import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudBaseFamilyClient,
  normalizeCloudBaseSettings,
} from "../lib/cloudbase-family-sync.ts";
import { familySyncProvider } from "../lib/family-sync-provider.ts";

const SETTINGS = {
  envId: "summer-pet-family-test",
  region: "ap-shanghai",
  publishableKey: "publishable-test-key",
  functionName: "summer-pet-family",
};

const HEALTH = { service: "summer-pet-family", schemaVersion: 1 };
const SESSION = { data: { session: { user: { id: "test-user" } } }, error: null };
const NO_SESSION = { data: { session: null }, error: null };

function clientHarness(overrides = {}) {
  const observed = {
    loads: 0,
    initializations: [],
    sessionChecks: 0,
    signIns: 0,
    calls: [],
  };
  const app = {
    // Deliberately an object, not a callable legacy auth() function.
    auth: {
      async getSession() {
        observed.sessionChecks += 1;
        return overrides.getSession ? overrides.getSession() : SESSION;
      },
      async getLoginState() {
        throw new Error("Do not use legacy login state with a Publishable Key");
      },
      async signInAnonymously() {
        observed.signIns += 1;
        return overrides.signInAnonymously ? overrides.signInAnonymously() : SESSION;
      },
    },
    async callFunction(options) {
      observed.calls.push(options);
      return overrides.callFunction
        ? overrides.callFunction(options)
        : { result: { ok: true, data: HEALTH } };
    },
  };
  const client = new CloudBaseFamilyClient(SETTINGS, {
    sdkLoader: async () => {
      observed.loads += 1;
      await overrides.load?.();
      return {
        init(options) {
          observed.initializations.push(options);
          return overrides.init ? overrides.init(options, app) : app;
        },
      };
    },
  });
  return { client, observed };
}

test("CloudBase browser settings reject missing public connection values", () => {
  assert.throws(
    () => normalizeCloudBaseSettings({ ...SETTINGS, envId: " " }),
    /EnvId/,
  );
  assert.throws(
    () => normalizeCloudBaseSettings({ ...SETTINGS, publishableKey: "" }),
    /Publishable Key/,
  );
});

test("CloudBase client trims settings and applies the default function name", () => {
  const client = new CloudBaseFamilyClient({
    ...SETTINGS,
    envId: ` ${SETTINGS.envId} `,
    functionName: "",
  });
  assert.deepEqual(client.settings, SETTINGS);
});

test("profiles created before provider migration remain GitHub profiles", () => {
  assert.equal(familySyncProvider({}), "github");
  assert.equal(familySyncProvider({ provider: "cloudbase" }), "cloudbase");
});

test("CloudBase uses property auth and reuses a real session", async () => {
  const { client, observed } = clientHarness();
  assert.deepEqual(await client.health(), HEALTH);
  assert.deepEqual(await client.health(), HEALTH);
  assert.equal(observed.loads, 1);
  assert.equal(observed.sessionChecks, 1);
  assert.equal(observed.signIns, 0);
  assert.deepEqual(observed.initializations, [{
    env: SETTINGS.envId,
    region: SETTINGS.region,
    accessKey: SETTINGS.publishableKey,
    timeout: 20_000,
  }]);
  assert.deepEqual(observed.calls[0], {
    name: SETTINGS.functionName,
    data: { action: "health" },
    parse: true,
  });
});

test("CloudBase signs in anonymously when the Publishable Key has no real session", async () => {
  const { client, observed } = clientHarness({ getSession: () => NO_SESSION });
  assert.deepEqual(await client.health(), HEALTH);
  assert.equal(observed.sessionChecks, 1);
  assert.equal(observed.signIns, 1);
  assert.equal(observed.calls.length, 1);
});

test("CloudBase does not mask session errors by starting an anonymous login", async () => {
  const { client, observed } = clientHarness({
    getSession: () => ({
      data: { session: null },
      error: { code: "unreachable", message: "Session network unavailable" },
    }),
  });
  await assert.rejects(client.health(), (error) => {
    assert.match(error.message, /Session network unavailable/);
    assert.equal(error.code, "unreachable");
    return true;
  });
  assert.equal(observed.signIns, 0);
  assert.equal(observed.calls.length, 0);
});

test("CloudBase blocks function calls when anonymous login reports an error", async () => {
  const { client, observed } = clientHarness({
    getSession: () => NO_SESSION,
    signInAnonymously: () => ({
      data: { session: null },
      error: { code: "permission_denied", message: "Anonymous provider is disabled" },
    }),
  });
  await assert.rejects(client.health(), /Anonymous provider is disabled/);
  assert.equal(observed.calls.length, 0);
});

test("CloudBase requires a session even when anonymous login returns no error", async () => {
  for (const data of [null, {}, { session: null }]) {
    const { client, observed } = clientHarness({
      getSession: () => NO_SESSION,
      signInAnonymously: () => ({ data, error: null }),
    });
    await assert.rejects(client.health(), /未建立有效会话/);
    assert.equal(observed.calls.length, 0);
  }
});

test("CloudBase shares one pending initialization and login across concurrent calls", async () => {
  const started = Promise.withResolvers();
  const signedIn = Promise.withResolvers();
  const { client, observed } = clientHarness({
    getSession: () => NO_SESSION,
    signInAnonymously: () => {
      started.resolve();
      return signedIn.promise;
    },
  });
  const first = client.health();
  const second = client.readConfig();
  await started.promise;
  assert.equal(observed.loads, 1);
  assert.equal(observed.initializations.length, 1);
  assert.equal(observed.signIns, 1);
  assert.equal(observed.calls.length, 0);
  signedIn.resolve(SESSION);
  await Promise.all([first, second]);
  assert.deepEqual(observed.calls.map(({ data }) => data.action), ["health", "getConfig"]);
});

test("CloudBase can recover from concurrent initialization failure on the next explicit attempt", async () => {
  const started = Promise.withResolvers();
  const signedIn = Promise.withResolvers();
  let attempts = 0;
  const { client, observed } = clientHarness({
    getSession: () => NO_SESSION,
    signInAnonymously: () => {
      attempts += 1;
      if (attempts > 1) return SESSION;
      started.resolve();
      return signedIn.promise;
    },
  });
  const failures = Promise.all([
    assert.rejects(client.health(), /Temporary login failure/),
    assert.rejects(client.readConfig(), /Temporary login failure/),
  ]);
  await started.promise;
  signedIn.resolve({ data: null, error: { message: "Temporary login failure" } });
  await failures;
  assert.equal(observed.loads, 1);
  assert.equal(observed.signIns, 1);
  assert.equal(observed.calls.length, 0);
  assert.deepEqual(await client.health(), HEALTH);
  assert.equal(observed.loads, 2);
  assert.equal(observed.signIns, 2);
  assert.equal(observed.calls.length, 1);
});

test("CloudBase retries a failed SDK load only on a later explicit call", async () => {
  let attempts = 0;
  const { client, observed } = clientHarness({
    load: () => {
      if (++attempts === 1) throw new Error("SDK load failed");
    },
  });
  await assert.rejects(client.health(), /SDK load failed/);
  assert.equal(observed.loads, 1);
  assert.equal(observed.initializations.length, 0);
  assert.deepEqual(await client.health(), HEALTH);
  assert.equal(observed.loads, 2);
});

test("CloudBase recovers after SDK initialization throws", async () => {
  let attempts = 0;
  const { client, observed } = clientHarness({
    init: (_options, app) => {
      if (++attempts === 1) throw new Error("SDK init failed");
      return app;
    },
  });
  await assert.rejects(client.health(), /SDK init failed/);
  assert.equal(observed.calls.length, 0);
  assert.deepEqual(await client.health(), HEALTH);
  assert.equal(observed.initializations.length, 2);
});

test("CloudBase preserves resolved platform error details before parsing the function result", async () => {
  const { client, observed } = clientHarness({
    callFunction: () => ({
      code: "PERMISSION_DENIED",
      message: "Function invocation denied",
      requestId: "safe-test-request",
      result: { ok: true, data: HEALTH },
    }),
  });
  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, "PERMISSION_DENIED");
    assert.equal(error.requestId, "safe-test-request");
    assert.match(error.message, /Function invocation denied/);
    assert.match(error.message, /PERMISSION_DENIED/);
    assert.match(error.message, /safe-test-request/);
    return true;
  });
  assert.equal(observed.calls.length, 1);
});

test("CloudBase supplies a useful fallback for a resolved platform error without a message", async () => {
  const { client } = clientHarness({ callFunction: () => ({ code: "FUNCTION_NOT_FOUND" }) });
  await assert.rejects(client.health(), /CloudBase 云函数调用失败.*FUNCTION_NOT_FOUND/);
});

test("CloudBase parses both object and JSON-string business results", async () => {
  for (const result of [{ ok: true, data: HEALTH }, JSON.stringify({ ok: true, data: HEALTH })]) {
    const { client } = clientHarness({ callFunction: () => ({ result }) });
    assert.deepEqual(await client.health(), HEALTH);
  }
});

test("CloudBase reports business failures and rejects malformed function responses", async () => {
  const cases = [
    [{ ok: false, error: "Revision conflict" }, /Revision conflict/],
    [JSON.stringify({ ok: false, error: "Device denied" }), /Device denied/],
    ["not-json", /无法识别/],
    [null, /没有返回有效结果/],
    [undefined, /没有返回有效结果/],
    [42, /没有返回有效结果/],
    [{}, /云函数调用失败/],
  ];
  for (const [result, expected] of cases) {
    const { client } = clientHarness({ callFunction: () => ({ result }) });
    await assert.rejects(client.health(), expected);
  }
});

test("CloudBase does not implicitly retry a write after an ambiguous transport failure", async () => {
  const failure = Object.assign(new Error("Response lost after possible commit"), {
    code: "TIMEOUT",
    requestId: "safe-write-request",
  });
  const { client, observed } = clientHarness({ callFunction: () => { throw failure; } });
  const config = { test: "payload" };
  await assert.rejects(client.updateConfig(config, "revision-1"), (error) => error === failure);
  assert.equal(observed.loads, 1);
  assert.equal(observed.calls.length, 1);
  assert.deepEqual(observed.calls[0].data, {
    action: "updateConfig",
    config,
    expectedRevision: "revision-1",
  });
});

test("CloudBase does not implicitly retry a write after a resolved platform error", async () => {
  const { client, observed } = clientHarness({
    callFunction: () => ({ code: "INTERNAL_ERROR", message: "Temporary server failure" }),
  });
  await assert.rejects(client.initializeConfig({ test: "payload" }), /Temporary server failure/);
  assert.equal(observed.loads, 1);
  assert.equal(observed.calls.length, 1);
});
