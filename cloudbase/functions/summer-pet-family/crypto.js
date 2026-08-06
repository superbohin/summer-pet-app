"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { webcrypto } = require("node:crypto");

const FAMILY_OPERATION_ALLOWLIST = Object.freeze({
  child: Object.freeze(["state.snapshot", "task.submit", "reward.request"]),
  parent: Object.freeze([
    "state.snapshot",
    "task.approve",
    "task.return",
    "reward.fulfill",
    "reward.refund",
    "task.update",
    "reward.update",
    "role.update",
    "device.add",
    "device.revoke",
  ]),
});

const encoder = new TextEncoder();
const MAX_FUTURE_EVENT_MS = 5 * 60 * 1000;

class FamilyValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FamilyValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FamilyValidationError(code, message);
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Only finite JSON numbers can be signed");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") throw new TypeError("Value is not JSON serializable");

  const result = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) result[key] = canonicalize(child);
  }
  return result;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hasOnlyKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function base64ToBytes(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new TypeError("Invalid base64 value");
  }
  return Buffer.from(value, "base64");
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function normalizePublicJwk(jwk) {
  if (
    !jwk ||
    typeof jwk !== "object" ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    !jwk.x ||
    typeof jwk.y !== "string" ||
    !jwk.y
  ) {
    fail("invalid-config", "Expected an ECDSA P-256 public key");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    ext: true,
    key_ops: ["verify"],
  };
}

async function importVerifyKey(jwk) {
  return webcrypto.subtle.importKey(
    "jwk",
    normalizePublicJwk(jwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

async function verifyBytes(publicKey, value, signature) {
  try {
    return await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64ToBytes(signature),
      encoder.encode(canonicalStringify(value)),
    );
  } catch {
    return false;
  }
}

async function verifyRequestProof(encodedKey, payload, signature) {
  try {
    const keyBytes = base64ToBytes(encodedKey);
    if (keyBytes.byteLength < 32 || keyBytes.byteLength > 128) return false;
    const key = await webcrypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return webcrypto.subtle.verify(
      "HMAC",
      key,
      base64ToBytes(signature),
      encoder.encode(canonicalStringify(payload)),
    );
  } catch {
    return false;
  }
}

async function publicKeyDeviceId(publicKey) {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonicalStringify(normalizePublicJwk(publicKey))),
  );
  return `device_${bytesToBase64Url(new Uint8Array(digest)).slice(0, 32)}`;
}

function assertRole(value, config = false) {
  if (value !== "child" && value !== "parent") {
    fail(config ? "invalid-config" : "invalid-event", "Invalid device role");
  }
}

function assertOperation(value) {
  const allowed = Object.values(FAMILY_OPERATION_ALLOWLIST).some((operations) =>
    operations.includes(value),
  );
  if (typeof value !== "string" || !allowed) {
    fail("invalid-event", "Unknown family operation");
  }
}

function assertIsoTimestamp(value, config = false) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(config ? "invalid-config" : "invalid-event", "Invalid timestamp");
  }
}

function assertConfigShape(config) {
  if (
    !config ||
    typeof config !== "object" ||
    config.schemaVersion !== 1 ||
    typeof config.householdId !== "string" ||
    !config.householdId ||
    config.householdId.length > 160 ||
    !Number.isInteger(config.version) ||
    config.version < 1 ||
    typeof config.rootDeviceId !== "string" ||
    !Array.isArray(config.devices) ||
    config.devices.length === 0 ||
    config.devices.length > 100 ||
    typeof config.signature !== "string" ||
    config.kdf?.algorithm !== "PBKDF2" ||
    config.kdf?.hash !== "SHA-256" ||
    !Number.isInteger(config.kdf?.iterations) ||
    config.kdf.iterations < 100_000 ||
    typeof config.kdf.salt !== "string" ||
    typeof config.encryptedHousehold?.iv !== "string" ||
    typeof config.encryptedHousehold?.ciphertext !== "string"
  ) {
    fail("invalid-config", "Malformed family config");
  }
  if (
    !hasOnlyKeys(config, [
      "schemaVersion",
      "householdId",
      "version",
      "updatedAt",
      "rootDeviceId",
      "rootPublicKey",
      "kdf",
      "devices",
      "encryptedHousehold",
      "signature",
    ]) ||
    !hasOnlyKeys(config.kdf, ["algorithm", "hash", "iterations", "salt"]) ||
    !hasOnlyKeys(config.encryptedHousehold, ["iv", "ciphertext"])
  ) {
    fail("invalid-config", "Family config contains unknown fields");
  }
  assertIsoTimestamp(config.updatedAt, true);
  normalizePublicJwk(config.rootPublicKey);
  if (base64ToBytes(config.kdf.salt).byteLength < 16) {
    fail("invalid-config", "Household KDF salt is too short");
  }
  if (base64ToBytes(config.encryptedHousehold.iv).byteLength !== 12) {
    fail("invalid-config", "Invalid encrypted household IV");
  }
  if (base64ToBytes(config.encryptedHousehold.ciphertext).byteLength < 17) {
    fail("invalid-config", "Invalid encrypted household payload");
  }
  if (base64ToBytes(config.signature).byteLength < 32) {
    fail("invalid-config", "Invalid config signature encoding");
  }

  const ids = new Set();
  for (const device of config.devices) {
    if (
      !device ||
      typeof device !== "object" ||
      typeof device.deviceId !== "string" ||
      !device.deviceId ||
      ids.has(device.deviceId) ||
      typeof device.addedAt !== "string" ||
      (device.label !== undefined &&
        (typeof device.label !== "string" || device.label.length > 80)) ||
      (device.revokedAt !== undefined && typeof device.revokedAt !== "string") ||
      (device.status !== "active" && device.status !== "revoked")
    ) {
      fail("invalid-config", "Malformed or duplicate authorized device");
    }
    ids.add(device.deviceId);
    if (
      !hasOnlyKeys(device, [
        "deviceId",
        "publicKey",
        "role",
        "status",
        "label",
        "addedAt",
        "revokedAt",
        "roleHistory",
      ])
    ) {
      fail("invalid-config", "Authorized device contains unknown fields");
    }
    assertRole(device.role, true);
    normalizePublicJwk(device.publicKey);
    assertIsoTimestamp(device.addedAt, true);
    if (device.revokedAt) assertIsoTimestamp(device.revokedAt, true);
    if (!Array.isArray(device.roleHistory) || device.roleHistory.length === 0) {
      fail("invalid-config", "Authorized device is missing role history");
    }
    for (const [periodIndex, period] of device.roleHistory.entries()) {
      if (!period || !hasOnlyKeys(period, ["role", "validFrom", "validUntil"])) {
        fail("invalid-config", "Role history contains unknown fields");
      }
      assertRole(period.role, true);
      assertIsoTimestamp(period.validFrom, true);
      if (period.validUntil) {
        assertIsoTimestamp(period.validUntil, true);
        if (Date.parse(period.validUntil) < Date.parse(period.validFrom)) {
          fail("invalid-config", "Invalid device role period");
        }
      }
      const previous = device.roleHistory[periodIndex - 1];
      if (
        previous &&
        (!previous.validUntil || Date.parse(period.validFrom) < Date.parse(previous.validUntil))
      ) {
        fail("invalid-config", "Overlapping or unordered role history");
      }
    }
    const firstPeriod = device.roleHistory[0];
    const lastPeriod = device.roleHistory[device.roleHistory.length - 1];
    if (
      firstPeriod.validFrom !== device.addedAt ||
      lastPeriod.role !== device.role ||
      (device.status === "active" && lastPeriod.validUntil) ||
      (device.status === "revoked" && lastPeriod.validUntil !== device.revokedAt)
    ) {
      fail("invalid-config", "Role history does not match device status");
    }
    if (device.status === "revoked" && !device.revokedAt) {
      fail("invalid-config", "Revoked device is missing revokedAt");
    }
  }

  const root = config.devices.find((device) => device.deviceId === config.rootDeviceId);
  if (!root || root.role !== "parent" || root.status !== "active") {
    fail("invalid-config", "Root device must be an active parent");
  }
  if (
    canonicalStringify(normalizePublicJwk(root.publicKey)) !==
    canonicalStringify(normalizePublicJwk(config.rootPublicKey))
  ) {
    fail("invalid-config", "Root device key does not match root key");
  }
}

function configSigningPayload(config) {
  return {
    schemaVersion: config.schemaVersion,
    householdId: config.householdId,
    version: config.version,
    updatedAt: config.updatedAt,
    rootDeviceId: config.rootDeviceId,
    rootPublicKey: config.rootPublicKey,
    kdf: config.kdf,
    devices: config.devices,
    encryptedHousehold: config.encryptedHousehold,
  };
}

async function verifyConfig(config, trustedRootPublicKey) {
  try {
    assertConfigShape(config);
    for (const device of config.devices) {
      if ((await publicKeyDeviceId(device.publicKey)) !== device.deviceId) return false;
    }
    if (
      trustedRootPublicKey &&
      canonicalStringify(normalizePublicJwk(trustedRootPublicKey)) !==
        canonicalStringify(normalizePublicJwk(config.rootPublicKey))
    ) {
      return false;
    }
    const rootPublicKey = await importVerifyKey(config.rootPublicKey);
    return verifyBytes(rootPublicKey, configSigningPayload(config), config.signature);
  } catch {
    return false;
  }
}

function assertEventShape(event) {
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.id !== "string" ||
    !/^[A-Za-z0-9_-]{12,100}$/.test(event.id) ||
    typeof event.deviceId !== "string" ||
    !event.deviceId
  ) {
    fail("invalid-event", "Malformed family event metadata");
  }
  assertRole(event.role);
  assertOperation(event.op);
  assertIsoTimestamp(event.timestamp);
  if (
    typeof event.iv !== "string" ||
    typeof event.ciphertext !== "string" ||
    event.ciphertext.length > 4_500_000 ||
    typeof event.signature !== "string"
  ) {
    fail("invalid-event", "Malformed family event envelope");
  }
  if (
    !hasOnlyKeys(event, [
      "id",
      "deviceId",
      "role",
      "op",
      "timestamp",
      "iv",
      "ciphertext",
      "signature",
    ])
  ) {
    fail("invalid-event", "Event envelope contains unknown fields");
  }
  try {
    if (base64ToBytes(event.iv).byteLength !== 12) throw new Error("bad iv");
    if (base64ToBytes(event.ciphertext).byteLength < 17) throw new Error("bad ciphertext");
    if (base64ToBytes(event.signature).byteLength < 32) throw new Error("bad signature");
  } catch {
    fail("invalid-event", "Invalid event cryptographic fields");
  }
}

function eventSigningPayload(event) {
  return {
    id: event.id,
    deviceId: event.deviceId,
    role: event.role,
    op: event.op,
    timestamp: event.timestamp,
    iv: event.iv,
    ciphertext: event.ciphertext,
  };
}

async function validateEventEnvelope(event, config, options = {}) {
  assertConfigShape(config);
  if (!(await verifyConfig(config, options.trustedRootPublicKey))) {
    fail(
      options.trustedRootPublicKey ? "untrusted-root" : "invalid-config-signature",
      "Family config signature is invalid or the root key is not trusted",
    );
  }
  assertEventShape(event);
  const device = config.devices.find((candidate) => candidate.deviceId === event.deviceId);
  if (!device) fail("unknown-device", "Event device is not approved");
  const eventTime = Date.parse(event.timestamp);
  if (
    options.mode === "append" &&
    eventTime > (options.now ?? Date.now()) + MAX_FUTURE_EVENT_MS
  ) {
    fail("invalid-event", "Event timestamp is too far in the future");
  }
  if (options.mode === "append" && device.status !== "active") {
    fail("revoked-device", "Revoked device cannot append new events");
  }
  if (device.status === "revoked" && device.revokedAt && eventTime >= Date.parse(device.revokedAt)) {
    fail("revoked-device", "Event device has been revoked");
  }
  const currentRolePeriod = device.roleHistory[device.roleHistory.length - 1];
  const roleAtEvent =
    options.mode === "append"
      ? eventTime >= Date.parse(currentRolePeriod.validFrom)
        ? device.role
        : undefined
      : device.roleHistory.find(
          (period) =>
            eventTime >= Date.parse(period.validFrom) &&
            (!period.validUntil || eventTime < Date.parse(period.validUntil)),
        )?.role;
  if (!roleAtEvent) fail("unknown-device", "Device was not approved at the event time");
  if (roleAtEvent !== event.role) {
    fail("role-mismatch", "Event role does not match the approved role");
  }
  if (!FAMILY_OPERATION_ALLOWLIST[roleAtEvent].includes(event.op)) {
    fail("operation-denied", "Device role cannot perform this operation");
  }
  const publicKey = await importVerifyKey(device.publicKey);
  if (!(await verifyBytes(publicKey, eventSigningPayload(event), event.signature))) {
    fail("invalid-event-signature", "Event signature is invalid");
  }
  return device;
}

async function validateDeviceRequest(request) {
  if (
    !request ||
    typeof request !== "object" ||
    !hasOnlyKeys(request, ["deviceId", "publicKey", "requestedRole", "label", "requestedAt"]) ||
    typeof request.deviceId !== "string" ||
    !/^device_[A-Za-z0-9_-]{32}$/.test(request.deviceId) ||
    typeof request.requestedAt !== "string" ||
    (request.label !== undefined &&
      (typeof request.label !== "string" || request.label.length > 80))
  ) {
    fail("invalid-device-request", "Malformed device request");
  }
  assertRole(request.requestedRole);
  assertIsoTimestamp(request.requestedAt);
  normalizePublicJwk(request.publicKey);
  if ((await publicKeyDeviceId(request.publicKey)) !== request.deviceId) {
    fail("invalid-device-request", "Device request ID does not match its public key");
  }
  return {
    deviceId: request.deviceId,
    publicKey: normalizePublicJwk(request.publicKey),
    requestedRole: request.requestedRole,
    ...(request.label ? { label: request.label } : {}),
    requestedAt: request.requestedAt,
  };
}

module.exports = {
  FamilyValidationError,
  canonicalStringify,
  validateDeviceRequest,
  validateEventEnvelope,
  verifyRequestProof,
  verifyConfig,
};
