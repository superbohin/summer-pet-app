import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  createDeviceIdentity,
  createEncryptedEvent,
  createHouseholdKdfParameters,
  createHouseholdRequestProof,
  createInitialFamilyConfig,
  deriveHouseholdKey,
  deriveHouseholdRequestProofKey,
  exportDeviceRequest,
} from "../lib/github-family-sync.ts";

const require = createRequire(import.meta.url);
const cloudCrypto = require(
  "../cloudbase/functions/summer-pet-family/crypto.js",
);

async function fixture() {
  const identity = await createDeviceIdentity();
  const kdf = createHouseholdKdfParameters();
  const householdKey = await deriveHouseholdKey("family-passphrase-for-tests", kdf);
  const config = await createInitialFamilyConfig({
    householdId: "family_cloudbase_test",
    rootDevice: identity,
    rootDeviceLabel: "测试家长设备",
    householdKey,
    kdf,
    household: { schemaVersion: 1, name: "测试家庭" },
  });
  const event = await createEncryptedEvent({
    device: identity,
    role: "parent",
    op: "state.snapshot",
    payload: { schemaVersion: 1, data: { test: true } },
    householdKey,
  });
  const requestProofKey = await deriveHouseholdRequestProofKey(
    householdKey,
    config.householdId,
  );
  return { config, event, identity, requestProofKey };
}

test("CloudBase function crypto accepts configs, requests and events made by the PWA", async () => {
  const { config, event, identity } = await fixture();
  assert.equal(await cloudCrypto.verifyConfig(config), true);
  const request = exportDeviceRequest(identity, "parent", { label: "测试设备" });
  assert.deepEqual(await cloudCrypto.validateDeviceRequest(request), request);
  assert.equal(
    (await cloudCrypto.validateEventEnvelope(event, config, { mode: "append" }))
      .deviceId,
    identity.deviceId,
  );
});

test("CloudBase function verifies family-bound device request proofs", async () => {
  const { identity, requestProofKey } = await fixture();
  const request = exportDeviceRequest(identity, "parent", { label: "测试设备" });
  const payload = { action: "submitDeviceRequest", request };
  const proof = await createHouseholdRequestProof(requestProofKey.key, payload);
  assert.equal(
    await cloudCrypto.verifyRequestProof(
      requestProofKey.encodedKey,
      payload,
      proof,
    ),
    true,
  );
  assert.equal(
    await cloudCrypto.verifyRequestProof(
      requestProofKey.encodedKey,
      { ...payload, action: "listDeviceRequests" },
      proof,
    ),
    false,
  );
});

test("CloudBase function crypto rejects tampered PWA events", async () => {
  const { config, event } = await fixture();
  await assert.rejects(
    cloudCrypto.validateEventEnvelope(
      { ...event, ciphertext: `${event.ciphertext.slice(0, -2)}AA` },
      config,
      { mode: "append" },
    ),
    /signature/i,
  );
});

test("CloudBase function rejects events too far in the future", async () => {
  const { config, event } = await fixture();
  await assert.rejects(
    cloudCrypto.validateEventEnvelope(event, config, {
      mode: "append",
      now: Date.parse(event.timestamp) - 6 * 60 * 1000,
    }),
    /future/i,
  );
});
