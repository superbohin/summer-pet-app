"use strict";

// PostgreSQL-only compatibility layer for the family function's document API.
// Requires public.summer_pet_get, summer_pet_list and summer_pet_commit from
// cloudbase/sql/001-family-sync.sql; call with the server-side app.rdb() client.
const TABLES = new Set([
  "summer_pet_config",
  "summer_pet_events",
  "summer_pet_device_requests",
]);
const MAX_PAGE_SIZE = 1_000;
const MAX_OFFSET = 100_000;
const MAX_TRANSACTION_DOCUMENTS = 1_000;
const MAX_ATTEMPTS = 3;

function storeError(code, message) {
  const error = new Error(message);
  error.name = "FamilyPgStoreError";
  error.code = code;
  return error;
}

function rpcError(source) {
  const pgCode = typeof source?.code === "string" && /^[A-Z0-9_]{2,80}$/.test(source.code)
    ? source.code : null;
  const message = typeof source?.message === "string" ? source.message : "";
  // Classify known permission failures without returning gateway text or data.
  const permission = [
    ["Family RPC requires server authorization", "family-role-check"],
    ["permission denied for table", "table-permission"],
    ["permission denied for schema", "schema-permission"],
    ["permission denied for function", "function-permission"],
  ].find(([pattern]) => message.includes(pattern))?.[1];
  const error = storeError("PG_RPC_ERROR", `Family PostgreSQL request failed${pgCode ? ` (${pgCode})` : ""}${permission ? ` [${permission}]` : ""}`);
  if (pgCode) error.pgCode = pgCode;
  const status = source?.status ?? source?.statusCode;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertTable(name) {
  if (!TABLES.has(name)) {
    throw storeError("INVALID_ARGUMENT", "Unsupported family table");
  }
  return name;
}

function assertId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 256
    || id.includes("\u0000")) {
    throw storeError("INVALID_ARGUMENT", "Document ID must be 1 to 256 characters");
  }
  return id;
}

function assertInteger(value, max, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw storeError("INVALID_ARGUMENT", `${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

function documentBody(value, id) {
  if (!plainObject(value)) {
    throw storeError("INVALID_ARGUMENT", "Document body must be an object");
  }
  if (Object.hasOwn(value, "_id") && value._id !== id) {
    throw storeError("INVALID_ARGUMENT", "Document ID cannot be changed");
  }
  let body;
  try {
    body = clone(value);
  } catch {
    throw storeError("INVALID_ARGUMENT", "Document body must be JSON serializable");
  }
  if (!plainObject(body)) {
    throw storeError("INVALID_ARGUMENT", "Document body must serialize to an object");
  }
  delete body._id;
  return body;
}

function documentResult(body, id) {
  return { data: body === null ? [] : [{ ...clone(body), _id: id }] };
}

function keyFor(table, id) {
  return JSON.stringify([table, id]);
}

function createPgDocumentStore(rdb) {
  if (!rdb || typeof rdb.rpc !== "function") {
    throw storeError("INVALID_ARGUMENT", "A server-side PostgreSQL RPC client is required");
  }

  async function rpc(name, args) {
    let response;
    try {
      response = await rdb.rpc(name, args);
    } catch (error) {
      // Do not copy gateway error text, SQL, credentials or user data outward.
      throw rpcError(error);
    }
    if (!response || response.error) {
      throw rpcError({ ...response?.error, status: response?.status ?? response?.error?.status });
    }
    if (!plainObject(response.data)) {
      throw storeError("PG_INVALID_RESPONSE", "Invalid family PostgreSQL response");
    }
    return response.data;
  }

  async function readBody(table, id) {
    const result = await rpc("summer_pet_get", { p_table: table, p_id: id });
    if (result.document !== null && !plainObject(result.document)) {
      throw storeError("PG_INVALID_RESPONSE", "Invalid family PostgreSQL document");
    }
    if (result.document !== null && Object.hasOwn(result.document, "_id")) {
      throw storeError("PG_INVALID_RESPONSE", "Invalid family PostgreSQL document ID");
    }
    return clone(result.document);
  }

  function collection(table, transaction, query = { order: [], offset: 0, limit: 100 }) {
    assertTable(table);
    return {
      doc(id) {
        assertId(id);
        return {
          async get() {
            const body = transaction
              ? await transaction.get(table, id)
              : await readBody(table, id);
            return documentResult(body, id);
          },
          async set(value) {
            const body = documentBody(value, id);
            if (transaction) return transaction.write(table, id, body);
            await runTransaction(async (tx) => tx.collection(table).doc(id).set(body));
            return { id };
          },
          async remove() {
            if (transaction) return transaction.write(table, id, null);
            await runTransaction(async (tx) => tx.collection(table).doc(id).remove());
            return { id };
          },
        };
      },
      orderBy(field, direction) {
        if (direction !== "asc" || !["timestamp", "_id"].includes(field)
          || query.order.includes(field) || query.order.includes("_id")) {
          throw storeError("INVALID_ARGUMENT", "Only timestamp ASC, then _id ASC are supported");
        }
        return collection(table, transaction, { ...query, order: [...query.order, field] });
      },
      skip(offset) {
        return collection(table, transaction, {
          ...query, offset: assertInteger(offset, MAX_OFFSET, "skip"),
        });
      },
      limit(limit) {
        return collection(table, transaction, {
          ...query, limit: assertInteger(limit, MAX_PAGE_SIZE, "limit"),
        });
      },
      async get() {
        // The family service uses document reads in transactions. Range reads
        // would require phantom detection; fail closed rather than imply it.
        if (transaction) {
          throw storeError("PG_UNSUPPORTED_QUERY", "Transaction range queries are not supported");
        }
        const result = await rpc("summer_pet_list", {
          p_table: table,
          p_order: query.order.includes("timestamp") ? "timestamp_id" : "_id",
          p_offset: query.offset,
          p_limit: query.limit,
        });
        if (!Array.isArray(result.documents) || result.documents.length > query.limit
          || result.documents.some((item) => !plainObject(item) || typeof item._id !== "string")) {
          throw storeError("PG_INVALID_RESPONSE", "Invalid family PostgreSQL page");
        }
        return { data: clone(result.documents) };
      },
    };
  }

  async function runTransaction(callback) {
    if (typeof callback !== "function") {
      throw storeError("INVALID_ARGUMENT", "Transaction callback is required");
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const reads = new Map();
      const writes = new Map();
      const pendingReads = new Map();
      let active = true;
      function assertActive() {
        if (!active) throw storeError("PG_TRANSACTION_CLOSED", "Transaction is no longer active");
      }
      async function read(table, id) {
        assertActive();
        const key = keyFor(table, id);
        if (!pendingReads.has(key)) {
          if (pendingReads.size >= MAX_TRANSACTION_DOCUMENTS) {
            throw storeError("INVALID_ARGUMENT", "Too many transaction documents");
          }
          const promise = readBody(table, id).then((expected) => {
            reads.set(key, { table, id, expected });
            return expected;
          });
          pendingReads.set(key, promise);
        }
        return pendingReads.get(key);
      }
      const transaction = {
        async get(table, id) {
          assertActive();
          const key = keyFor(table, id);
          if (writes.has(key)) return clone(writes.get(key).body);
          return clone(await read(table, id));
        },
        async write(table, id, body) {
          // Blind writes also capture a precondition and use the same lock/CAS.
          await read(table, id);
          assertActive();
          writes.set(keyFor(table, id), { table, id, body: clone(body) });
          return { id };
        },
      };
      let result;
      try {
        result = await callback({ collection: (table) => collection(table, transaction) });
      } finally {
        active = false;
      }
      const committed = await rpc("summer_pet_commit", {
        p_reads: [...reads.values()],
        p_writes: [...writes.values()],
      });
      if (committed.committed === true) return { result };
      if (committed.committed !== false || committed.conflict !== true) {
        throw storeError("PG_INVALID_RESPONSE", "Invalid family PostgreSQL commit result");
      }
      // Repeat all reads AND async signature/authorization checks on conflict.
      // Transport errors are not retried: the commit outcome could be unknown.
    }
    throw storeError("TRANSACTION_CONFLICT", "Family data changed; refresh and retry");
  }

  return { collection: (table) => collection(table), runTransaction };
}

module.exports = { createPgDocumentStore };
