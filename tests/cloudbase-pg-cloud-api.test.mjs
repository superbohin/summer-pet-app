import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("../cloudbase/functions/summer-pet-family/pg-cloud-api.js");
const { createPgCloudApiClient } = require(modulePath);
const { createPgDocumentStore } = require("../cloudbase/functions/summer-pet-family/pg-store.js");
const CONFIG = "summer_pet_config";
const GET = { p_table: CONFIG, p_id: "current" };
const LIST = { p_table: CONFIG, p_order: "timestamp_id", p_offset: 2, p_limit: 10 };
const COMMIT = {
  p_reads: [{ table: CONFIG, id: "current", expected: null }],
  p_writes: [{ table: CONFIG, id: "current", body: { version: 1 } }],
};
const credentials = () => ({
  envId: "test-env", secretId: "test-secret-id", secretKey: "test-secret-key",
  sessionToken: "test-session-token",
});
const copy = (value) => JSON.parse(JSON.stringify(value));

function envelope(data, stringifyColumn = true) {
  return { Response: {
    Columns: ["result"], ColumnTypes: ["jsonb"],
    Rows: [JSON.stringify([stringifyColumn ? JSON.stringify(data) : data])],
    AffectedRows: 0, RequestId: "test-request",
  } };
}

function fakeClient(data = { document: null }, overrides = {}) {
  const calls = [];
  const signatures = [];
  let credentialReads = 0;
  const client = createPgCloudApiClient({
    readRuntime: () => { credentialReads += 1; return credentials(); },
    now: () => 1_710_000_000_000,
    sign: (args) => {
      signatures.push(copy(args));
      return { authorization: "test-authorization", timestamp: args.timestamp };
    },
    fetch: async (url, request) => {
      calls.push({ url, request });
      return { ok: true, status: 200, json: async () => envelope(data) };
    },
    ...overrides,
  });
  return { client, calls, signatures, credentialReads: () => credentialReads };
}

function decodedLiterals(sql) {
  return [...sql.matchAll(/pg_catalog\.decode\('([0-9a-f]*)', 'hex'\)/g)]
    .map((match) => Buffer.from(match[1], "hex").toString("utf8"));
}

test("PG cloud API maps only the three RPCs to one role-fixed SQL statement", async () => {
  for (const [name, args, expected, literals] of [
    ["summer_pet_get", GET, { document: null }, [CONFIG, "current"]],
    ["summer_pet_list", LIST, { documents: [{ _id: "example", timestamp: 1 }] }, [CONFIG, "timestamp_id"]],
    ["summer_pet_commit", COMMIT, { committed: true }, [JSON.stringify(COMMIT.p_reads), JSON.stringify(COMMIT.p_writes)]],
  ]) {
    const fake = fakeClient(expected);
    assert.deepEqual(await fake.client.rpc(name, args), { data: expected, error: null });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.signatures.length, 1);
    const { url, request } = fake.calls[0];
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body), ["EnvId", "Role", "Sql"]);
    assert.equal(body.EnvId, "test-env");
    assert.equal(body.Role, "service_role");
    assert.ok(body.Sql.startsWith(`SELECT public.${name}(`));
    assert.ok(body.Sql.endsWith(") AS result;"));
    assert.equal((body.Sql.match(/;/g) ?? []).length, 1);
    assert.deepEqual(decodedLiterals(body.Sql), literals);
    assert.equal(url, "https://tcb.tencentcloudapi.com/");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    assert.deepEqual(request.headers, {
      "content-type": "application/json; charset=utf-8", host: "tcb.tencentcloudapi.com",
      Authorization: "test-authorization", "X-TC-Action": "ExecutePGSql",
      "X-TC-Version": "2018-06-08", "X-TC-Timestamp": "1710000000",
      "X-TC-Token": "test-session-token",
    });
    assert.deepEqual(fake.signatures[0].params, body);
    assert.equal(fake.signatures[0].secretId, "test-secret-id");
    assert.equal(fake.signatures[0].secretKey, "test-secret-key");
    assert.equal(fake.signatures[0].isCloudApi, true);
    assert.equal(fake.signatures[0].timestamp, 1_710_000_000);
    assert.equal(fake.signatures[0].service, "tcb");
    assert.equal(fake.signatures[0].url, url);
  }
});

test("hex parameters preserve malicious-looking text without permitting SQL injection", async () => {
  const attack = "宠物'); SET ROLE postgres; DROP TABLE summer_pet_config; -- \\ $$ 🐍";
  const args = {
    p_reads: [{ table: CONFIG, id: attack, expected: { [attack]: attack } }],
    p_writes: [{ table: CONFIG, id: attack, body: { nested: [attack, null, 1.5, false] } }],
  };
  const fake = fakeClient({ committed: true });
  assert.equal((await fake.client.rpc("summer_pet_commit", args)).error, null);
  const sql = JSON.parse(fake.calls[0].request.body).Sql;
  assert.equal(sql.includes(attack), false);
  assert.equal(sql.includes("DROP"), false);
  assert.equal(sql.includes("SET ROLE"), false);
  assert.equal((sql.match(/;/g) ?? []).length, 1);
  assert.equal((sql.match(/::jsonb/g) ?? []).length, 2);
  const [reads, writes] = decodedLiterals(sql).map((value) => JSON.parse(value));
  assert.deepEqual(reads, args.p_reads);
  assert.deepEqual(writes, args.p_writes);
  const get = fakeClient();
  await get.client.rpc("summer_pet_get", { ...GET, p_id: attack });
  assert.deepEqual(decodedLiterals(JSON.parse(get.calls[0].request.body).Sql), [CONFIG, attack]);
});

test("unsupported RPCs, parameters and document types fail before credentials, signing or network", async () => {
  const cycle = {};
  cycle.self = cycle;
  let getterCalls = 0;
  const accessor = { ...GET };
  Object.defineProperty(accessor, "p_id", { enumerable: true, get() { getterCalls += 1; return "current"; } });
  const symbolArgs = { ...GET, [Symbol("role")]: "postgres" };
  const invalid = [
    ["SELECT 1;", GET], ["summer_pet_get; DELETE", GET], ["__proto__", GET],
    ["summer_pet_get", { ...GET, EnvId: "other-env" }],
    ["summer_pet_get", { ...GET, Role: "postgres" }],
    ["summer_pet_get", { ...GET, Sql: "SELECT 1" }],
    ["summer_pet_get", { ...GET, secretKey: "client-key" }],
    ["summer_pet_get", { ...GET, p_table: "unrelated_table" }],
    ["summer_pet_get", { p_table: CONFIG }],
    ["summer_pet_get", { ...GET, p_id: "" }],
    ["summer_pet_get", { ...GET, p_id: "x".repeat(257) }],
    ["summer_pet_get", { ...GET, p_id: "nul\u0000" }],
    ["summer_pet_get", { ...GET, p_id: "\ud800" }],
    ["summer_pet_get", { ...GET, p_id: 2 }],
    ["summer_pet_get", null], ["summer_pet_get", []], ["summer_pet_get", accessor],
    ["summer_pet_get", symbolArgs], ["summer_pet_get", Object.create(GET)],
    ["summer_pet_list", { ...LIST, p_order: "id; DROP" }],
    ["summer_pet_list", { ...LIST, p_offset: -1 }],
    ["summer_pet_list", { ...LIST, p_offset: 100_001 }],
    ["summer_pet_list", { ...LIST, p_limit: 1.5 }],
    ["summer_pet_list", { ...LIST, p_limit: 1_001 }],
    ["summer_pet_commit", { ...COMMIT, p_reads: {} }],
    ["summer_pet_commit", { ...COMMIT, p_reads: [] }],
    ["summer_pet_commit", { ...COMMIT, p_reads: [COMMIT.p_reads[0], COMMIT.p_reads[0]] }],
    ["summer_pet_commit", { ...COMMIT, p_writes: [COMMIT.p_writes[0], COMMIT.p_writes[0]] }],
    ["summer_pet_commit", { ...COMMIT, p_reads: Array(1_001).fill(COMMIT.p_reads[0]) }],
    ["summer_pet_commit", { ...COMMIT, p_reads: [{ ...COMMIT.p_reads[0], Role: "postgres" }] }],
    ...[undefined, () => 1, new Date(), NaN, Infinity, 1n, cycle, { x: undefined },
      { x: Symbol("invalid") }, { x: new Map() }, { x: [, "hole"] }, { x: "\u0000" },
      { _id: "changed" }, ["not-object"]].map((body) => [
      "summer_pet_commit", { ...COMMIT, p_writes: [{ ...COMMIT.p_writes[0], body }] },
    ]),
  ];
  for (const [name, args] of invalid) {
    const fake = fakeClient();
    const result = await fake.client.rpc(name, args);
    assert.equal(result.error?.code, "PG_CLOUD_INVALID_ARGUMENT");
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.signatures.length, 0);
    assert.equal(fake.credentialReads(), 0);
  }
  assert.equal(getterCalls, 0);
});

test("runtime STS credentials and trusted environment are reread for every request", async () => {
  let generation = 0;
  const fake = fakeClient({ document: null }, {
    readRuntime: () => ({ envId: `env-${++generation}`, secretId: `id-${generation}`,
      secretKey: `key-${generation}`, sessionToken: `token-${generation}` }),
  });
  for (let index = 1; index <= 2; index += 1) {
    assert.equal((await fake.client.rpc("summer_pet_get", GET)).error, null);
    assert.equal(fake.signatures[index - 1].secretId, `id-${index}`);
    assert.equal(fake.signatures[index - 1].secretKey, `key-${index}`);
    assert.equal(fake.signatures[index - 1].params.EnvId, `env-${index}`);
    assert.equal(fake.calls[index - 1].request.headers["X-TC-Token"], `token-${index}`);
  }
});

test("missing or malformed runtime credentials and environment fail before signing or network", async () => {
  for (const [field, value, code] of [
    ["envId", undefined, "PG_CLOUD_MISSING_ENVIRONMENT"],
    ["envId", "env; injected", "PG_CLOUD_MISSING_ENVIRONMENT"],
    ["secretId", undefined, "PG_CLOUD_MISSING_CREDENTIALS"],
    ["secretKey", "", "PG_CLOUD_MISSING_CREDENTIALS"],
    ["sessionToken", "  ", "PG_CLOUD_MISSING_CREDENTIALS"],
    ["sessionToken", "token\r\nAuthorization: injected", "PG_CLOUD_MISSING_CREDENTIALS"],
  ]) {
    const fake = fakeClient(null, { readRuntime: () => ({ ...credentials(), [field]: value }) });
    assert.equal((await fake.client.rpc("summer_pet_get", GET)).error.code, code);
    assert.equal(fake.signatures.length, 0);
    assert.equal(fake.calls.length, 0);
  }
});

test("the runtime defaults use TCB_ENV then SCF_NAMESPACE and reread only temporary credentials", () => {
  const code = `
    const {createPgCloudApiClient}=require(${JSON.stringify(modulePath)});
    const calls=[];
    const client=createPgCloudApiClient({
      sign: args => {calls.push([args.params.EnvId,args.secretId,args.secretKey]);return {authorization:'test'};},
      fetch: async (_,req)=>({ok:true,status:200,json:async()=>{calls.push(req.headers['X-TC-Token']);return ${JSON.stringify(envelope({ document: null }))};}})
    });
    (async()=>{
      await client.rpc('summer_pet_get',${JSON.stringify(GET)});
      delete process.env.TCB_ENV;
      process.env.TENCENTCLOUD_SECRETID='refreshed-id';
      process.env.TENCENTCLOUD_SECRETKEY='refreshed-key';
      process.env.TENCENTCLOUD_SESSIONTOKEN='refreshed-token';
      await client.rpc('summer_pet_get',${JSON.stringify(GET)});
      process.stdout.write(JSON.stringify(calls));
    })();`;
  const child = spawnSync(process.execPath, ["-e", code], {
    env: { TCB_ENV: "env-primary", SCF_NAMESPACE: "env-fallback", NODE_DEBUG: "",
      TENCENTCLOUD_SECRETID: "fixture-id", TENCENTCLOUD_SECRETKEY: "fixture-key",
      TENCENTCLOUD_SESSIONTOKEN: "fixture-token" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [
    ["env-primary", "fixture-id", "fixture-key"], "fixture-token",
    ["env-fallback", "refreshed-id", "refreshed-key"], "refreshed-token",
  ]);
});

test("JSON-encoded positional rows and already-decoded jsonb columns both work", async () => {
  for (const stringifyColumn of [true, false]) {
    const fake = fakeClient(null, { fetch: async () => ({ ok: true, status: 200,
      json: async () => envelope({ document: { valid: true } }, stringifyColumn) }) });
    assert.deepEqual(await fake.client.rpc("summer_pet_get", GET), {
      data: { document: { valid: true } }, error: null,
    });
  }
  const conflict = fakeClient({ committed: false, conflict: true });
  assert.deepEqual(await conflict.client.rpc("summer_pet_commit", COMMIT), {
    data: { committed: false, conflict: true }, error: null,
  });
});

test("forged, malformed or mismatched responses never imply a successful RPC", async () => {
  const valid = envelope({ document: null }).Response;
  const invalidResponses = [
    null, {}, { response: valid }, { Response: null },
    ...[
      {}, { ...valid, Rows: [] }, { ...valid, Rows: [...valid.Rows, ...valid.Rows] },
      { ...valid, Rows: ["not JSON"] }, { ...valid, Rows: [JSON.stringify({ result: { document: null } })] },
      { ...valid, Rows: [JSON.stringify([])] },
      { ...valid, Rows: [JSON.stringify(["{}", "{}"])] },
      { ...valid, Rows: [[{ document: null }]] },
      { ...valid, Rows: [JSON.stringify(["not JSON"])] },
      { ...valid, Columns: ["other"] }, { ...valid, Columns: ["result", "extra"] },
      { ...valid, Columns: undefined }, { ...valid, ColumnTypes: ["text"] },
    ].map((Response) => ({ Response })),
    ...[null, [], false, 1, "string", {}, { document: [] }, { document: { _id: "bad" } },
      { document: null, unexpected: true }, { committed: true }].map((data) => envelope(data)),
  ];
  for (const payload of invalidResponses) {
    const fake = fakeClient(null, { fetch: async () => ({ ok: true, status: 200, json: async () => payload }) });
    assert.deepEqual((await fake.client.rpc("summer_pet_get", GET)).error, {
      code: "PG_CLOUD_INVALID_RESPONSE", message: "Family PostgreSQL request failed",
    });
  }
  for (const [name, args, data] of [
    ["summer_pet_list", LIST, { documents: [{}] }],
    ["summer_pet_list", LIST, { documents: Array(11).fill({ _id: "too-many" }) }],
    ["summer_pet_list", LIST, { documents: [{ _id: "" }] }],
    ["summer_pet_commit", COMMIT, { committed: false }],
    ["summer_pet_commit", COMMIT, { committed: true, conflict: true }],
    ["summer_pet_commit", COMMIT, { committed: "true" }],
    ["summer_pet_commit", COMMIT, { committed: false, conflict: false }],
  ]) {
    assert.equal((await fakeClient(data).client.rpc(name, args)).error.code, "PG_CLOUD_INVALID_RESPONSE");
  }
});

test("HTTP 200 Cloud API errors are failures and never expose raw error text", async () => {
  for (const [code, expected] of [
    ["AuthFailure.SecretIdNotFound", "PG_CLOUD_AUTHFAILURE_SECRETIDNOTFOUND"],
    ["leak=secret-key", "PG_CLOUD_API_ERROR"], [null, "PG_CLOUD_API_ERROR"],
  ]) {
    const fake = fakeClient(null, { fetch: async () => ({ ok: true, status: 200, json: async () => ({
      ...envelope({ document: null }), Response: {
        ...envelope({ document: null }).Response,
        Error: { Code: code, Message: "SQL=SELECT secret; secret-key=hidden", Detail: "private" },
      },
    }) }) });
    assert.deepEqual(await fake.client.rpc("summer_pet_get", GET), {
      data: null, error: { code: expected, message: "Family PostgreSQL request failed" },
    });
  }
});

test("network, HTTP, signing and JSON errors are sanitized without automatic commit retries", async () => {
  for (const mode of ["network", "http", "json", "signing", "bad-signature", "redirect"]) {
    let fetches = 0;
    let signatures = 0;
    const client = createPgCloudApiClient({
      readRuntime: credentials,
      sign: () => {
        signatures += 1;
        if (mode === "signing") throw new Error("secret-key SQL headers should not escape");
        return { authorization: mode === "bad-signature" ? "token\r\nleak" : "fixture-auth" };
      },
      fetch: async () => {
        fetches += 1;
        if (mode === "network" || mode === "redirect") throw new Error("secret-key failed SQL SELECT");
        return { ok: mode !== "http", status: mode === "http" ? 503 : 200,
          json: async () => { throw new Error("secret-key invalid JSON SQL SELECT"); } };
      },
    });
    const result = await client.rpc("summer_pet_commit", COMMIT);
    assert.equal(result.data, null);
    assert.ok(result.error.code.startsWith("PG_CLOUD_"));
    assert.equal(result.error.message, "Family PostgreSQL request failed");
    assert.equal(JSON.stringify(result).includes("secret-key"), false);
    assert.equal(JSON.stringify(result).includes("SELECT"), false);
    assert.equal(signatures, 1);
    assert.equal(fetches, ["signing", "bad-signature"].includes(mode) ? 0 : 1);
    if (mode === "http") assert.equal(result.error.status, 503);
  }
});

test("signing debug including wildcard NODE_DEBUG fails closed before reading any credentials", () => {
  for (const debug of ["@cloudbase/signature", "@CLOUDBASE/SIGNATURE", "@cloudbase/*", "*"]) {
    const code = `
      const {createPgCloudApiClient}=require(${JSON.stringify(modulePath)});
      let reads=0,signs=0,fetches=0;
      const client=createPgCloudApiClient({
        readRuntime:()=>{reads++;throw new Error('should not read');},
        sign:()=>{signs++;throw new Error('should not sign');},
        fetch:()=>{fetches++;throw new Error('should not fetch');}
      });
      client.rpc('summer_pet_get',${JSON.stringify(GET)}).then(result=>
        process.stdout.write(JSON.stringify({result,reads,signs,fetches})));`;
    const child = spawnSync(process.execPath, ["-e", code], {
      env: { NODE_DEBUG: debug }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), {
      result: { data: null, error: { code: "PG_CLOUD_UNSAFE_DEBUG", message: "Family PostgreSQL request failed" } },
      reads: 0, signs: 0, fetches: 0,
    });
  }
});

test("the PG document adapter accepts this transport and does not retry an uncertain commit", async () => {
  const calls = [];
  const transport = createPgCloudApiClient({
    readRuntime: credentials,
    sign: () => ({ authorization: "fixture-auth" }),
    fetch: async (_, request) => {
      const sql = JSON.parse(request.body).Sql;
      calls.push(sql);
      if (sql.startsWith("SELECT public.summer_pet_commit(")) throw new Error("unknown commit result");
      return { ok: true, status: 200, json: async () => envelope({ document: null }) };
    },
  });
  const store = createPgDocumentStore(transport);
  await assert.rejects(store.collection(CONFIG).doc("current").set({ version: 1 }), {
    code: "PG_RPC_ERROR", pgCode: "PG_CLOUD_REQUEST_FAILED",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((sql) => sql.startsWith("SELECT public.summer_pet_commit(")).length, 1);
});
