import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
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

test("CloudBase initialization accepts the signed config of the pinned root", async () => {
  const { config } = await fixture();
  assert.equal(
    await cloudCrypto.validateInitialConfig(config, config.rootDeviceId),
    config,
  );
});

test("CloudBase initialization rejects a valid config from a different root", async () => {
  const { config } = await fixture();
  const trustedRoot = await createDeviceIdentity();
  assert.equal(await cloudCrypto.verifyConfig(config), true);
  await assert.rejects(
    cloudCrypto.validateInitialConfig(config, trustedRoot.deviceId),
    { code: "UNTRUSTED_ROOT" },
  );
  await assert.rejects(
    cloudCrypto.validateInitialConfig(config, ` ${config.rootDeviceId} `),
    { code: "UNTRUSTED_ROOT" },
  );
});

test("CloudBase initialization rejects a forged pinned device ID even when re-signed", async () => {
  const { config, identity } = await fixture();
  const trustedRoot = await createDeviceIdentity();
  const forged = {
    ...config,
    rootDeviceId: trustedRoot.deviceId,
    devices: config.devices.map((device) => ({
      ...device,
      deviceId: trustedRoot.deviceId,
    })),
  };
  const payload = { ...forged };
  delete payload.signature;
  forged.signature = Buffer.from(
    await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(cloudCrypto.canonicalStringify(payload)),
    ),
  ).toString("base64");
  await assert.rejects(
    cloudCrypto.validateInitialConfig(forged, trustedRoot.deviceId),
    { code: "INVALID_CONFIG" },
  );
});

test("CloudBase initialization rejects a forged signature despite a matching pin", async () => {
  const { config } = await fixture();
  const signature = Buffer.from(config.signature, "base64");
  signature[0] ^= 1;
  const tampered = { ...config, signature: signature.toString("base64") };
  await assert.rejects(
    cloudCrypto.validateInitialConfig(tampered, config.rootDeviceId),
    { code: "INVALID_CONFIG" },
  );
  await assert.rejects(cloudCrypto.validateInitialConfig(tampered), {
    code: "INVALID_CONFIG",
  });
});

test("CloudBase initialization preserves compatibility when the root pin is unset", async () => {
  const { config } = await fixture();
  assert.equal(await cloudCrypto.validateInitialConfig(config), config);
  assert.equal(await cloudCrypto.validateInitialConfig(config, ""), config);
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
