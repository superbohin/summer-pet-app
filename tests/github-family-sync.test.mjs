import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  FamilySyncValidationError,
  GitHubFamilyClient,
  approveOrRevokeDevice,
  createDeviceIdentity,
  createEncryptedEvent,
  createHouseholdKdfParameters,
  createInitialFamilyConfig,
  decryptEvent,
  decryptFamilyConfig,
  dedupeAndSortEvents,
  deriveHouseholdKey,
  exportDeviceRequest,
  validateEventEnvelope,
  verifyConfig,
} from "../lib/github-family-sync.ts";

async function familyFixture() {
  const kdf = createHouseholdKdfParameters({
    iterations: 100_000,
    salt: new Uint8Array(16).fill(7),
  });
  const householdKey = await deriveHouseholdKey("correct horse battery staple", kdf);
  const rootDevice = await createDeviceIdentity();
  const childDevice = await createDeviceIdentity();
  let config = await createInitialFamilyConfig({
    householdId: "family-test",
    rootDevice,
    rootDeviceLabel: "Parent iPad",
    householdKey,
    kdf,
    household: { displayName: "Test household", privateSetting: 42 },
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
  config = await approveOrRevokeDevice(
    config,
    {
      action: "approve",
      request: exportDeviceRequest(childDevice, "child", {
        label: "Child iPad",
        requestedAt: "2026-07-31T00:01:00.000Z",
      }),
      role: "child",
    },
    rootDevice.privateKey,
    "2026-07-31T00:02:00.000Z",
  );
  return { kdf, householdKey, rootDevice, childDevice, config };
}

test("device identity uses a stable public-key ID and a non-extractable private key", async () => {
  const device = await createDeviceIdentity();
  const first = exportDeviceRequest(device, "child", { requestedAt: "2026-07-31T00:00:00.000Z" });
  const second = exportDeviceRequest(device, "parent", { requestedAt: "2026-07-31T00:01:00.000Z" });

  assert.equal(device.privateKey.extractable, false);
  assert.equal(first.deviceId, second.deviceId);
  assert.deepEqual(first.publicKey, second.publicKey);
  await assert.rejects(
    crypto.subtle.exportKey("jwk", device.privateKey),
    /not extractable|key is not extractable/i,
  );
});

test("config and event ciphertext decrypt only with the derived household key", async () => {
  const { kdf, householdKey, childDevice, config } = await familyFixture();
  assert.equal(await verifyConfig(config), true);
  assert.deepEqual(await decryptFamilyConfig(config, householdKey), {
    displayName: "Test household",
    privateSetting: 42,
  });

  const event = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "task.submit",
    payload: { taskId: "read", proof: "pages 10-20" },
    householdKey,
    id: "event_child_001",
    timestamp: "2026-07-31T01:00:00.000Z",
  });
  await validateEventEnvelope(event, config);
  assert.deepEqual(await decryptEvent(event, householdKey), {
    taskId: "read",
    proof: "pages 10-20",
  });

  const wrongKey = await deriveHouseholdKey("wrong passphrase", kdf);
  await assert.rejects(decryptEvent(event, wrongKey));
});

test("tampering with a signed config or event is rejected", async () => {
  const { householdKey, childDevice, config } = await familyFixture();
  const event = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "reward.request",
    payload: { rewardId: "zoo-trip" },
    householdKey,
    id: "event_child_002",
    timestamp: "2026-07-31T02:00:00.000Z",
  });

  const tamperedEvent = {
    ...event,
    ciphertext: `${event.ciphertext.slice(0, -2)}AA`,
  };
  await assert.rejects(
    validateEventEnvelope(tamperedEvent, config),
    (error) =>
      error instanceof FamilySyncValidationError &&
      error.code === "invalid-event-signature",
  );

  const tamperedConfig = {
    ...config,
    devices: config.devices.map((device) =>
      device.deviceId === childDevice.deviceId
        ? {
            ...device,
            role: "parent",
            roleHistory: device.roleHistory.map((period) => ({ ...period, role: "parent" })),
          }
        : device,
    ),
  };
  assert.equal(await verifyConfig(tamperedConfig), false);
  await assert.rejects(
    validateEventEnvelope(event, tamperedConfig),
    (error) =>
      error instanceof FamilySyncValidationError &&
      error.code === "invalid-config-signature",
  );
});

test("child privilege escalation is rejected and revocation preserves earlier history", async () => {
  const { householdKey, rootDevice, childDevice, config } = await familyFixture();
  const childEvent = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "task.submit",
    payload: { taskId: "read" },
    householdKey,
    id: "event_child_003",
    timestamp: "2026-07-31T03:00:00.000Z",
  });
  const escalatedEnvelope = { ...childEvent, op: "task.approve" };

  await assert.rejects(
    validateEventEnvelope(escalatedEnvelope, config),
    (error) =>
      error instanceof FamilySyncValidationError &&
      error.code === "operation-denied",
  );

  const revokedConfig = await approveOrRevokeDevice(
    config,
    { action: "revoke", deviceId: childDevice.deviceId },
    rootDevice.privateKey,
    "2026-07-31T03:01:00.000Z",
  );
  await validateEventEnvelope(childEvent, revokedConfig);
  await assert.rejects(
    validateEventEnvelope(childEvent, revokedConfig, { mode: "append" }),
    (error) =>
      error instanceof FamilySyncValidationError &&
      error.code === "revoked-device",
  );

  const postRevocationEvent = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "task.submit",
    payload: { taskId: "write" },
    householdKey,
    id: "event_child_004",
    timestamp: "2026-07-31T03:02:00.000Z",
  });
  await assert.rejects(
    validateEventEnvelope(postRevocationEvent, revokedConfig),
    (error) =>
      error instanceof FamilySyncValidationError &&
      error.code === "revoked-device",
  );
});

test("role history validates old events under the role active when they were signed", async () => {
  const { householdKey, rootDevice, childDevice, config } = await familyFixture();
  const childEvent = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "task.submit",
    payload: { taskId: "read" },
    householdKey,
    id: "event_role_history",
    timestamp: "2026-07-31T07:00:00.000Z",
  });
  const promotedConfig = await approveOrRevokeDevice(
    config,
    { action: "update-role", deviceId: childDevice.deviceId, role: "parent" },
    rootDevice.privateKey,
    "2026-07-31T08:00:00.000Z",
  );

  assert.equal((await validateEventEnvelope(childEvent, promotedConfig)).deviceId, childDevice.deviceId);
  const postPromotion = await createEncryptedEvent({
    device: childDevice,
    role: "parent",
    op: "task.approve",
    payload: { submissionId: "submission-1" },
    householdKey,
    id: "event_role_parent",
    timestamp: "2026-07-31T08:01:00.000Z",
  });
  assert.equal((await validateEventEnvelope(postPromotion, promotedConfig)).role, "parent");
});

test("state snapshots are signed by either role but still carry the signer role", async () => {
  const { householdKey, rootDevice, childDevice, config } = await familyFixture();
  const childSnapshot = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "state.snapshot",
    payload: { version: 4, records: {} },
    householdKey,
    id: "event_snapshot_child",
    timestamp: "2026-07-31T04:00:00.000Z",
  });
  const parentSnapshot = await createEncryptedEvent({
    device: rootDevice,
    role: "parent",
    op: "state.snapshot",
    payload: { version: 4, records: {} },
    householdKey,
    id: "event_snapshot_parent",
    timestamp: "2026-07-31T04:01:00.000Z",
  });

  assert.equal((await validateEventEnvelope(childSnapshot, config)).role, "child");
  assert.equal((await validateEventEnvelope(parentSnapshot, config)).role, "parent");
});

test("events are deduplicated and sorted deterministically, while conflicting IDs fail", async () => {
  const { householdKey, childDevice } = await familyFixture();
  const later = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "task.submit",
    payload: { taskId: "later" },
    householdKey,
    id: "event_sort_later",
    timestamp: "2026-07-31T06:00:00.000Z",
  });
  const earlierB = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "task.submit",
    payload: { taskId: "b" },
    householdKey,
    id: "event_sort_bbb",
    timestamp: "2026-07-31T05:00:00.000Z",
  });
  const earlierA = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "task.submit",
    payload: { taskId: "a" },
    householdKey,
    id: "event_sort_aaa",
    timestamp: "2026-07-31T05:00:00.000Z",
  });

  assert.deepEqual(
    dedupeAndSortEvents([later, earlierB, earlierA, earlierA]).map((event) => event.id),
    ["event_sort_aaa", "event_sort_bbb", "event_sort_later"],
  );
  assert.throws(
    () => dedupeAndSortEvents([earlierA, { ...earlierA, ciphertext: later.ciphertext }]),
    (error) =>
      error instanceof FamilySyncValidationError &&
      error.code === "duplicate-event-conflict",
  );
});

test("GitHub client reads contents, dispatches base64 events, and updates config with SHA", async () => {
  const { householdKey, childDevice, config } = await familyFixture();
  const event = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "reward.request",
    payload: { rewardId: "museum" },
    householdKey,
    id: "event_github_client",
    timestamp: "2026-07-31T09:00:00.000Z",
  });
  const calls = [];
  const mockFetch = async (url, init = {}) => {
    calls.push({ url, init });
    const method = init.method ?? "GET";
    if (method === "GET" && url.includes("/contents/config/household.json")) {
      return Response.json({
        sha: "config-sha-before",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(config)).toString("base64"),
      });
    }
    if (method === "GET" && url.endsWith("/contents/events?ref=main")) {
      return Response.json([
        { name: `${event.id}.json`, path: `events/${event.id}.json`, type: "file" },
      ]);
    }
    if (method === "GET" && url.includes(`/contents/events/${event.id}.json`)) {
      return Response.json({
        sha: "event-sha",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(event)).toString("base64"),
      });
    }
    if (method === "POST") return new Response(null, { status: 204 });
    if (method === "PUT") return Response.json({ content: { sha: "config-sha-after" } });
    return Response.json({ message: "unexpected test request" }, { status: 500 });
  };
  const client = new GitHubFamilyClient({
    owner: "family-owner",
    repo: "private-family-data",
    fetchImpl: mockFetch,
  });

  assert.equal(Object.hasOwn(client, "token"), false);
  assert.equal((await client.readConfig("test-token")).sha, "config-sha-before");
  assert.deepEqual(await client.listEvents("test-token"), [event]);
  await client.dispatchEvent("test-token", event);
  assert.equal(
    (await client.updateConfig("test-token", config, "config-sha-before")).sha,
    "config-sha-after",
  );

  assert.ok(
    calls.every((call) => call.init.headers.Authorization === "Bearer test-token"),
  );
  const dispatch = calls.find((call) => call.init.method === "POST");
  const dispatchedBody = JSON.parse(dispatch.init.body);
  assert.deepEqual(
    JSON.parse(Buffer.from(dispatchedBody.inputs.event, "base64").toString("utf8")),
    event,
  );
  const update = calls.find((call) => call.init.method === "PUT");
  assert.equal(JSON.parse(update.init.body).sha, "config-sha-before");
});

test("Action validator appends one file and refuses to overwrite the same event ID", async () => {
  const { householdKey, childDevice, config } = await familyFixture();
  const event = await createEncryptedEvent({
    device: childDevice,
    role: "child",
    op: "task.submit",
    payload: { taskId: "action-test" },
    householdKey,
    id: "event_action_append",
    timestamp: "2026-07-31T10:00:00.000Z",
  });
  const workspace = await mkdtemp(join(tmpdir(), "family-sync-action-"));
  try {
    await mkdir(join(workspace, "config"), { recursive: true });
    await writeFile(join(workspace, "config", "household.json"), JSON.stringify(config), "utf8");
    const env = {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      EVENT_BASE64: Buffer.from(JSON.stringify(event)).toString("base64"),
    };
    const first = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/github-family-sync-action.mjs"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(join(workspace, "events", `${event.id}.json`), "utf8")),
      event,
    );

    const duplicate = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/github-family-sync-action.mjs"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /cannot be overwritten/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
