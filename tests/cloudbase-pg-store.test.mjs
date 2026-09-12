import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPgDocumentStore } = require("../cloudbase/functions/summer-pet-family/pg-store.js");
const CONFIG = "summer_pet_config";
const EVENTS = "summer_pet_events";
const REQUESTS = "summer_pet_device_requests";
const copy = (value) => JSON.parse(JSON.stringify(value));
const keyFor = (table, id) => JSON.stringify([table, id]);

// No network, CloudBase SDK or real database is involved. This test double
// models the documented get/list/atomic-CAS-commit contract, not PostgreSQL's
// permission engine. Live role and SQL checks remain deployment verification.
function fakeRpc(initial = []) {
  let rows = new Map(initial.map(([table, id, body]) => [keyFor(table, id), copy(body)]));
  const calls = [];
  const fake = {
    calls,
    beforeCommit: null,
    commitError: null,
    set(table, id, body) { rows.set(keyFor(table, id), copy(body)); },
    get(table, id) { return copy(rows.get(keyFor(table, id)) ?? null); },
    async rpc(name, args) {
      calls.push({ name, args: copy(args) });
      if (name === "summer_pet_get") {
        return { data: { document: fake.get(args.p_table, args.p_id) }, error: null };
      }
      if (name === "summer_pet_list") {
        const documents = [...rows.entries()]
          .filter(([key]) => JSON.parse(key)[0] === args.p_table)
          .map(([key, body]) => ({ ...copy(body), _id: JSON.parse(key)[1] }));
        const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
        documents.sort((left, right) => (
          args.p_order === "timestamp_id" ? compare(left.timestamp, right.timestamp) : 0
        ) || compare(left._id, right._id));
        return {
          data: { documents: documents.slice(args.p_offset, args.p_offset + args.p_limit) },
          error: null,
        };
      }
      assert.equal(name, "summer_pet_commit");
      if (fake.beforeCommit) await fake.beforeCommit(args);
      if (fake.commitError) return { data: null, error: fake.commitError };
      if (args.p_reads.some((read) => {
        try {
          assert.deepEqual(fake.get(read.table, read.id), read.expected);
          return false;
        } catch {
          return true;
        }
      })) return { data: { committed: false, conflict: true }, error: null };
      const next = new Map(rows);
      for (const write of args.p_writes) {
        assert.ok(args.p_reads.some((read) => read.table === write.table && read.id === write.id));
        if (write.body === null) next.delete(keyFor(write.table, write.id));
        else next.set(keyFor(write.table, write.id), copy(write.body));
      }
      rows = next;
      return { data: { committed: true }, error: null };
    },
  };
  return fake;
}

test("PG document adapter reads missing and existing documents without leaking mutable state", async () => {
  const rpc = fakeRpc([[CONFIG, "current", { config: { version: 1 } }]]);
  const db = createPgDocumentStore(rpc);
  assert.deepEqual(await db.collection(EVENTS).doc("missing").get(), { data: [] });
  const found = await db.collection(CONFIG).doc("current").get();
  assert.deepEqual(found, { data: [{ config: { version: 1 }, _id: "current" }] });
  found.data[0].config.version = 9;
  assert.equal(rpc.get(CONFIG, "current").config.version, 1);
});

test("standalone set and remove always use captured reads and the atomic commit RPC", async () => {
  const rpc = fakeRpc();
  const db = createPgDocumentStore(rpc);
  const ref = db.collection(REQUESTS).doc("device-test");
  assert.deepEqual(await ref.set({ request: { label: "request" } }), { id: "device-test" });
  assert.deepEqual(rpc.calls.map((call) => call.name), ["summer_pet_get", "summer_pet_commit"]);
  assert.deepEqual(rpc.calls[1].args.p_reads, [{ table: REQUESTS, id: "device-test", expected: null }]);
  await ref.remove();
  assert.equal(rpc.get(REQUESTS, "device-test"), null);
  assert.equal(rpc.calls.at(-1).name, "summer_pet_commit");
  assert.equal(rpc.calls.at(-1).args.p_writes[0].body, null);
  await ref.remove();
  assert.equal(rpc.get(REQUESTS, "device-test"), null);
});

test("transactions atomically commit every write and support cached reads/read-your-writes", async () => {
  const rpc = fakeRpc([[CONFIG, "current", { config: { version: 1 } }]]);
  const db = createPgDocumentStore(rpc);
  const result = await db.runTransaction(async (tx) => {
    const ref = tx.collection(CONFIG).doc("current");
    const [first, second] = await Promise.all([ref.get(), ref.get()]);
    first.data[0].config.version = 999;
    assert.equal(second.data[0].config.version, 1);
    await ref.set({ config: { version: 2 }, _id: "current" });
    assert.equal((await ref.get()).data[0].config.version, 2);
    const event = tx.collection(EVENTS).doc("event-one");
    await event.set({ event: { id: "event-one" } });
    await event.remove();
    assert.deepEqual(await event.get(), { data: [] });
    await event.set({ event: { id: "event-one", final: true } });
    assert.equal(rpc.get(CONFIG, "current").config.version, 1);
    assert.equal(rpc.get(EVENTS, "event-one"), null);
    return { accepted: true };
  });
  assert.deepEqual(result, { result: { accepted: true } });
  assert.equal(rpc.get(CONFIG, "current").config.version, 2);
  assert.equal(rpc.get(EVENTS, "event-one").event.final, true);
  const commits = rpc.calls.filter((call) => call.name === "summer_pet_commit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].args.p_reads.length, 2);
  assert.equal(commits[0].args.p_writes.length, 2);
  assert.equal(rpc.calls.filter((call) => call.name === "summer_pet_get").length, 2);
  assert.equal(Object.hasOwn(commits[0].args.p_writes[0].body, "_id"), false);
});

test("a concurrent config change reruns the complete async callback with fresh reads", async () => {
  const rpc = fakeRpc([[CONFIG, "current", { version: 1 }]]);
  const db = createPgDocumentStore(rpc);
  let injected = false;
  rpc.beforeCommit = () => {
    if (!injected) {
      injected = true;
      rpc.set(CONFIG, "current", { version: 2 });
    }
  };
  const versions = [];
  const result = await db.runTransaction(async (tx) => {
    const config = (await tx.collection(CONFIG).doc("current").get()).data[0];
    await Promise.resolve(); // Models the existing asynchronous ECDSA checks.
    versions.push(config.version);
    await tx.collection(EVENTS).doc("event-one").set({ authorizedVersion: config.version });
    return config.version;
  });
  assert.deepEqual(versions, [1, 2]);
  assert.deepEqual(result, { result: 2 });
  assert.deepEqual(rpc.get(EVENTS, "event-one"), { authorizedVersion: 2 });
  const commits = rpc.calls.filter((call) => call.name === "summer_pet_commit");
  assert.equal(commits.length, 2);
  assert.equal(commits[1].args.p_reads.find((read) => read.table === CONFIG).expected.version, 2);
});

test("revocation during signature verification prevents every pending write after retry", async () => {
  const rpc = fakeRpc([[CONFIG, "current", { active: true }]]);
  const db = createPgDocumentStore(rpc);
  rpc.beforeCommit = () => rpc.set(CONFIG, "current", { active: false });
  let checks = 0;
  await assert.rejects(db.runTransaction(async (tx) => {
    const config = (await tx.collection(CONFIG).doc("current").get()).data[0];
    await Promise.resolve();
    checks += 1;
    if (!config.active) throw new Error("Device revoked");
    await tx.collection(EVENTS).doc("event-one").set({ authorized: true });
    await tx.collection(REQUESTS).doc("request-one").set({ authorized: true });
  }), /Device revoked/);
  assert.equal(checks, 2);
  assert.equal(rpc.get(EVENTS, "event-one"), null);
  assert.equal(rpc.get(REQUESTS, "request-one"), null);
});

test("concurrent insertion retries a previously missing read and permits idempotent replay", async () => {
  const rpc = fakeRpc();
  const db = createPgDocumentStore(rpc);
  let injected = false;
  const body = { event: { id: "event-one", ciphertext: "same-content" } };
  rpc.beforeCommit = () => {
    if (!injected) { injected = true; rpc.set(EVENTS, "event-one", body); }
  };
  let attempts = 0;
  await db.runTransaction(async (tx) => {
    attempts += 1;
    const ref = tx.collection(EVENTS).doc("event-one");
    const existing = (await ref.get()).data[0];
    if (existing) assert.deepEqual(existing.event, body.event);
    else await ref.set(body);
  });
  assert.equal(attempts, 2);
  assert.deepEqual(rpc.get(EVENTS, "event-one"), body);
  assert.deepEqual(rpc.calls.at(-1).args.p_writes, []);
  assert.equal(rpc.calls.at(-1).args.p_reads.length, 1);
});

test("transaction conflicts are bounded at three attempts", async () => {
  const rpc = fakeRpc([[CONFIG, "current", { version: 0 }]]);
  const db = createPgDocumentStore(rpc);
  let attempt = 0;
  rpc.beforeCommit = () => rpc.set(CONFIG, "current", { version: ++attempt });
  await assert.rejects(db.runTransaction(async (tx) => {
    await tx.collection(CONFIG).doc("current").get();
    await tx.collection(EVENTS).doc("event-one").set({ allowed: true });
  }), { code: "TRANSACTION_CONFLICT" });
  assert.equal(attempt, 3);
  assert.equal(rpc.get(EVENTS, "event-one"), null);
});

test("callback errors never submit pending writes or retry", async () => {
  const rpc = fakeRpc();
  const db = createPgDocumentStore(rpc);
  await assert.rejects(db.runTransaction(async (tx) => {
    await tx.collection(EVENTS).doc("event-one").set({ valid: true });
    throw new Error("Signature verification failed");
  }), /Signature verification failed/);
  assert.equal(rpc.calls.some((call) => call.name === "summer_pet_commit"), false);
  assert.equal(rpc.get(EVENTS, "event-one"), null);
});

test("commit failures apply no fake writes, are sanitized and are not blindly retried", async () => {
  const rpc = fakeRpc([[CONFIG, "current", { version: 1 }]]);
  rpc.commitError = { message: "SQL password=do-not-return", code: "failed" };
  const db = createPgDocumentStore(rpc);
  let callbacks = 0;
  await assert.rejects(db.runTransaction(async (tx) => {
    callbacks += 1;
    await tx.collection(CONFIG).doc("current").set({ version: 2 });
    await tx.collection(EVENTS).doc("event-one").set({ value: 1 });
  }), (error) => error.code === "PG_RPC_ERROR" && !error.message.includes("password"));
  assert.equal(callbacks, 1);
  assert.equal(rpc.get(CONFIG, "current").version, 1);
  assert.equal(rpc.get(EVENTS, "event-one"), null);
});

test("timestamp and ID ordering give deterministic complete pagination", async () => {
  const rpc = fakeRpc(Array.from({ length: 237 }, (_, index) => [
    EVENTS,
    `event-${String(236 - index).padStart(3, "0")}`,
    { timestamp: `2026-09-${index < 119 ? "11" : "12"}T00:00:00Z` },
  ]));
  const db = createPgDocumentStore(rpc);
  const base = db.collection(EVENTS).orderBy("timestamp", "asc").orderBy("_id", "asc");
  const all = [];
  for (let offset = 0; offset < 300; offset += 100) {
    all.push(...(await base.skip(offset).limit(100).get()).data);
  }
  assert.equal(all.length, 237);
  assert.equal(new Set(all.map((item) => item._id)).size, 237);
  assert.equal(all[0]._id, "event-118");
  assert.equal(all[118]._id, "event-236");
  assert.equal(all[119]._id, "event-000");
  assert.deepEqual(rpc.calls.map((call) => call.args.p_offset), [0, 100, 200]);
  assert.deepEqual(await base.limit(0).get(), { data: [] });
  assert.equal((await db.collection(EVENTS).orderBy("_id", "asc").limit(1).get()).data[0]._id, "event-000");
});

test("table/query/ID validation rejects unsupported input before any RPC", async () => {
  const rpc = fakeRpc();
  const db = createPgDocumentStore(rpc);
  assert.throws(() => db.collection("users; DELETE FROM users"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => db.collection(EVENTS).doc(""), { code: "INVALID_ARGUMENT" });
  assert.throws(() => db.collection(EVENTS).doc("a\u0000b"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => db.collection(EVENTS).doc("a".repeat(257)), { code: "INVALID_ARGUMENT" });
  assert.throws(() => db.collection(EVENTS).orderBy("timestamp", "desc"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => db.collection(EVENTS).orderBy("body", "asc"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => db.collection(EVENTS).orderBy("_id", "asc").orderBy("timestamp", "asc"), { code: "INVALID_ARGUMENT" });
  for (const value of [-1, 1.5, NaN, 1001, "100"]) {
    assert.throws(() => db.collection(EVENTS).limit(value), { code: "INVALID_ARGUMENT" });
  }
  for (const value of [-1, 1.5, NaN, 100001, "0"]) {
    assert.throws(() => db.collection(EVENTS).skip(value), { code: "INVALID_ARGUMENT" });
  }
  await assert.rejects(db.collection(EVENTS).doc("event-one").set({ _id: "other-id" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(db.collection(EVENTS).doc("event-one").set(null), { code: "INVALID_ARGUMENT" });
  assert.equal(rpc.calls.length, 0);
});

test("closed transactions and unsupported range reads fail closed", async () => {
  const rpc = fakeRpc();
  const db = createPgDocumentStore(rpc);
  let closedRef;
  await db.runTransaction(async (tx) => { closedRef = tx.collection(EVENTS).doc("event-one"); });
  await assert.rejects(closedRef.set({ value: 1 }), { code: "PG_TRANSACTION_CLOSED" });
  await assert.rejects(closedRef.get(), { code: "PG_TRANSACTION_CLOSED" });
  await assert.rejects(db.runTransaction(async (tx) => tx.collection(EVENTS).get()), { code: "PG_UNSUPPORTED_QUERY" });
  assert.equal(rpc.get(EVENTS, "event-one"), null);
});

test("malformed gateway responses are rejected instead of assuming a successful commit", async () => {
  const invalidRead = createPgDocumentStore({ rpc: async () => ({ data: {} }) });
  await assert.rejects(invalidRead.collection(CONFIG).doc("current").get(), { code: "PG_INVALID_RESPONSE" });
  const invalidCommit = createPgDocumentStore({ rpc: async () => ({ data: { committed: false } }) });
  await assert.rejects(invalidCommit.runTransaction(async () => 1), { code: "PG_INVALID_RESPONSE" });
  const failedTransport = createPgDocumentStore({ rpc: async () => { throw new Error("credential-detail"); } });
  await assert.rejects(failedTransport.collection(CONFIG).doc("current").get(),
    (error) => error.code === "PG_RPC_ERROR" && !error.message.includes("credential-detail"));
});

test("RPC errors retain only a restricted diagnostic code and numeric HTTP status", async () => {
  const db = createPgDocumentStore({ rpc: async () => ({
    data: null,
    error: { code: "42501", status: 403, message: "password=secret; SELECT private_body" },
  }) });
  await assert.rejects(db.collection(CONFIG).doc("current").get(), (error) => {
    assert.equal(error.code, "PG_RPC_ERROR");
    assert.equal(error.pgCode, "42501");
    assert.equal(error.status, 403);
    assert.match(error.message, /42501/);
    assert.doesNotMatch(error.message, /password|SELECT|secret/);
    return true;
  });
  const unsafe = createPgDocumentStore({ rpc: async () => ({
    data: null, error: { code: "42501 password=secret", status: "403" },
  }) });
  await assert.rejects(unsafe.collection(CONFIG).doc("current").get(), (error) => {
    assert.equal(error.pgCode, undefined);
    assert.equal(error.status, undefined);
    assert.doesNotMatch(error.message, /password|secret/);
    return true;
  });
});

test("gateway status and fixed permission categories survive without exposing error text", async () => {
  for (const [message, category] of [
    ["Family RPC requires server authorization", "family-role-check"],
    ["permission denied for table secret_name", "table-permission"],
    ["permission denied for schema secret_name", "schema-permission"],
    ["permission denied for function secret_name", "function-permission"],
  ]) {
    const db = createPgDocumentStore({ rpc: async () => ({
      data: null, status: 403,
      error: { code: "DATABASE_42501", message: `${message}; token=secret_value` },
    }) });
    await assert.rejects(db.collection(CONFIG).doc("current").get(), (error) => {
      assert.equal(error.status, 403);
      assert.ok(error.message.includes(`[${category}]`));
      assert.doesNotMatch(error.message, /secret_name|token|secret_value/);
      return true;
    });
  }
});

test("SQL migration preserves the server-only, transactional and narrowly scoped contract", async () => {
  const sql = await readFile(new URL("../cloudbase/sql/001-family-sync.sql", import.meta.url), "utf8");
  assert.match(sql, /\bBEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 3);
  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 3);
  assert.equal((sql.match(/SECURITY INVOKER/g) ?? []).length, 3);
  assert.equal((sql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length, 3);
  assert.equal((sql.match(/IS DISTINCT FROM 'service_role'/g) ?? []).length, 6);
  assert.match(sql, /FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /v_body IS DISTINCT FROM nullif/);
  assert.match(sql, /jsonb_build_object\('committed', false, 'conflict', true\)/);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /SECURITY DEFINER/);
});
