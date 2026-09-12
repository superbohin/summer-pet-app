"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { debuglog } = require("node:util");

const API_URL = "https://tcb.tencentcloudapi.com/";
const API_HOST = "tcb.tencentcloudapi.com";
const CONTENT_TYPE = "application/json; charset=utf-8";
const TABLES = new Set([
  "summer_pet_config", "summer_pet_events", "summer_pet_device_requests",
]);
const ERROR_MESSAGE = "Family PostgreSQL request failed";

class PgCloudApiError extends Error {
  constructor(code, status) {
    super(ERROR_MESSAGE);
    this.code = code;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}

function invalidArgument() {
  throw new PgCloudApiError("PG_CLOUD_INVALID_ARGUMENT");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactObject(value, keys) {
  if (!plainObject(value)) invalidArgument();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) invalidArgument();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalidArgument();
  }
}

function jsonString(value) {
  // PostgreSQL text/jsonb cannot store NUL or invalid Unicode. Reject instead
  // of allowing UTF-8 encoding or JSON serialization to alter the document.
  if (typeof value !== "string" || value.includes("\u0000")
    || Buffer.from(value, "utf8").toString("utf8") !== value) invalidArgument();
  return value;
}

function jsonValue(value, ancestors = new Set(), depth = 0) {
  if (depth > 100) invalidArgument();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { jsonString(value); return; }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) invalidArgument();
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) invalidArgument();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalidArgument();
      jsonValue(descriptor.value, ancestors, depth + 1);
    }
  } else {
    if (!plainObject(value)) invalidArgument();
    for (const key of Reflect.ownKeys(value)) {
      jsonString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalidArgument();
      jsonValue(descriptor.value, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}

function table(value) {
  if (!TABLES.has(value)) invalidArgument();
  return value;
}

function documentId(value) {
  jsonString(value);
  if (value.length < 1 || value.length > 256) invalidArgument();
  return value;
}

function integer(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalidArgument();
  return value;
}

function textLiteral(value) {
  // Only hex digits enter SQL, regardless of quotes, slashes, comments or
  // Unicode in user data. Function names, casts and aliases are constants.
  return `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(value, "utf8").toString("hex")}', 'hex'), 'UTF8')`;
}

function transactionSet(value, field) {
  if (!Array.isArray(value) || value.length > 1_000) invalidArgument();
  jsonValue(value);
  const keys = new Set();
  for (const item of value) {
    exactObject(item, ["table", "id", field]);
    table(item.table);
    documentId(item.id);
    if (item[field] !== null && !plainObject(item[field])) invalidArgument();
    if (field === "body" && item.body !== null && Object.hasOwn(item.body, "_id")) invalidArgument();
    const key = JSON.stringify([item.table, item.id]);
    if (keys.has(key)) invalidArgument();
    keys.add(key);
  }
  return keys;
}

function rpcSql(name, args) {
  if (name === "summer_pet_get") {
    exactObject(args, ["p_table", "p_id"]);
    return `SELECT public.summer_pet_get(${textLiteral(table(args.p_table))}, ${textLiteral(documentId(args.p_id))}) AS result;`;
  }
  if (name === "summer_pet_list") {
    exactObject(args, ["p_table", "p_order", "p_offset", "p_limit"]);
    if (!["_id", "timestamp_id"].includes(args.p_order)) invalidArgument();
    return `SELECT public.summer_pet_list(${textLiteral(table(args.p_table))}, ${textLiteral(args.p_order)}, ${integer(args.p_offset, 100_000)}, ${integer(args.p_limit, 1_000)}) AS result;`;
  }
  if (name === "summer_pet_commit") {
    exactObject(args, ["p_reads", "p_writes"]);
    const reads = transactionSet(args.p_reads, "expected");
    const writes = transactionSet(args.p_writes, "body");
    if ([...writes].some((key) => !reads.has(key))) invalidArgument();
    return `SELECT public.summer_pet_commit(${textLiteral(JSON.stringify(args.p_reads))}::jsonb, ${textLiteral(JSON.stringify(args.p_writes))}::jsonb) AS result;`;
  }
  invalidArgument();
}

function readRuntime() {
  // Read every request: warm cloud functions must not retain expired STS
  // credentials. Never accept environment, role, SQL or credentials in rpc().
  return {
    envId: process.env.TCB_ENV || process.env.SCF_NAMESPACE,
    secretId: process.env.TENCENTCLOUD_SECRETID,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY,
    sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN,
  };
}

function validCredential(value) {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n\u0000]/.test(value);
}

function responseData(payload, name, args) {
  if (!plainObject(payload) || !plainObject(payload.Response)) {
    throw new PgCloudApiError("PG_CLOUD_INVALID_RESPONSE");
  }
  const response = payload.Response;
  if (Object.hasOwn(response, "Error")) {
    const code = response.Error?.Code;
    const safeCode = typeof code === "string" && code.length <= 60
      && /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/.test(code)
      ? `PG_CLOUD_${code.replaceAll(".", "_").toUpperCase()}` : "PG_CLOUD_API_ERROR";
    throw new PgCloudApiError(safeCode);
  }
  try {
    if (!Array.isArray(response.Columns) || response.Columns.length !== 1
      || response.Columns[0] !== "result" || !Array.isArray(response.ColumnTypes)
      || response.ColumnTypes.length !== 1 || response.ColumnTypes[0] !== "jsonb"
      || !Array.isArray(response.Rows) || response.Rows.length !== 1
      || typeof response.Rows[0] !== "string") invalidArgument();
    const row = JSON.parse(response.Rows[0]);
    // ExecutePGSql returns each row as a JSON-encoded positional array. A
    // jsonb column is normally another JSON string, not a named row object.
    if (!Array.isArray(row) || row.length !== 1) invalidArgument();
    const result = typeof row[0] === "string" ? JSON.parse(row[0]) : row[0];
    jsonValue(result);
    if (name === "summer_pet_get") {
      exactObject(result, ["document"]);
      if (result.document !== null && (!plainObject(result.document)
        || Object.hasOwn(result.document, "_id"))) invalidArgument();
    } else if (name === "summer_pet_list") {
      exactObject(result, ["documents"]);
      if (!Array.isArray(result.documents) || result.documents.length > args.p_limit) invalidArgument();
      for (const document of result.documents) {
        if (!plainObject(document)) invalidArgument();
        documentId(document._id);
      }
    } else {
      if (result?.committed === true) exactObject(result, ["committed"]);
      else {
        exactObject(result, ["committed", "conflict"]);
        if (result.committed !== false || result.conflict !== true) invalidArgument();
      }
    }
    return result;
  } catch {
    throw new PgCloudApiError("PG_CLOUD_INVALID_RESPONSE");
  }
}

// Dependency injection is only for trusted server-side tests. The deployed
// function constructs this with no options; requests only reach rpc(name,args).
function createPgCloudApiClient(options = {}) {
  const runtime = options.readRuntime ?? readRuntime;
  const fetchApi = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const sign = options.sign ?? ((params) => require("@cloudbase/signature-nodejs").sign(params));
  const now = options.now ?? Date.now;
  return {
    async rpc(name, args) {
      try {
        // The signing dependency's debug mode logs secrets and SQL. Fail closed
        // before reading credentials or importing/calling the signer, also for
        // NODE_DEBUG=* and case-insensitive/wildcard matching handled by Node.
        if (debuglog("@cloudbase/signature").enabled) {
          throw new PgCloudApiError("PG_CLOUD_UNSAFE_DEBUG");
        }
        const Sql = rpcSql(name, args);
        const { envId, secretId, secretKey, sessionToken } = runtime();
        if (typeof envId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(envId)) {
          throw new PgCloudApiError("PG_CLOUD_MISSING_ENVIRONMENT");
        }
        if (![secretId, secretKey, sessionToken].every(validCredential)) {
          throw new PgCloudApiError("PG_CLOUD_MISSING_CREDENTIALS");
        }
        const timestamp = Math.floor(now() / 1_000);
        if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
          throw new PgCloudApiError("PG_CLOUD_INVALID_CLOCK");
        }
        const params = { EnvId: envId, Role: "service_role", Sql };
        const headers = { "content-type": CONTENT_TYPE, host: API_HOST };
        const signed = sign({
          secretId, secretKey, method: "POST", url: API_URL, headers, params,
          timestamp, service: "tcb", isCloudApi: true,
        });
        if (!validCredential(signed?.authorization)) {
          throw new PgCloudApiError("PG_CLOUD_SIGNING_FAILED");
        }
        // No automatic retries, especially after an uncertain commit outcome.
        const response = await fetchApi(API_URL, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
          headers: {
            ...headers,
            Authorization: signed.authorization,
            "X-TC-Action": "ExecutePGSql",
            "X-TC-Version": "2018-06-08",
            "X-TC-Timestamp": String(timestamp),
            "X-TC-Token": sessionToken,
          },
          body: JSON.stringify(params),
        });
        if (response?.ok !== true || !Number.isInteger(response.status)
          || response.status < 200 || response.status > 299) {
          throw new PgCloudApiError("PG_CLOUD_HTTP_ERROR", response?.status);
        }
        let payload;
        try { payload = await response.json(); }
        catch { throw new PgCloudApiError("PG_CLOUD_INVALID_RESPONSE"); }
        return { data: responseData(payload, name, args), error: null };
      } catch (error) {
        // Never expose source messages, causes, SQL, response bodies or headers.
        const safe = error instanceof PgCloudApiError
          ? error : new PgCloudApiError("PG_CLOUD_REQUEST_FAILED");
        return {
          data: null,
          error: {
            code: safe.code, message: ERROR_MESSAGE,
            ...(safe.status ? { status: safe.status } : {}),
          },
        };
      }
    },
  };
}

module.exports = { createPgCloudApiClient };
