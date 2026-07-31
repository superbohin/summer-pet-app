export type DeviceRole = "child" | "parent";

export type FamilyOperationKind =
  | "state.snapshot"
  | "task.submit"
  | "reward.request"
  | "task.approve"
  | "task.return"
  | "reward.fulfill"
  | "reward.refund"
  | "task.update"
  | "reward.update"
  | "role.update"
  | "device.add"
  | "device.revoke";

export const FAMILY_OPERATION_ALLOWLIST: Readonly<Record<DeviceRole, readonly FamilyOperationKind[]>> = {
  child: ["state.snapshot", "task.submit", "reward.request"],
  parent: [
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
  ],
};

export type HouseholdKdfParameters = {
  algorithm: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
  salt: string;
};

export type EncryptedJson = {
  iv: string;
  ciphertext: string;
};

export type DeviceKeyMaterial = {
  deviceId: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
};

export type DeviceRequest = {
  deviceId: string;
  publicKey: JsonWebKey;
  requestedRole: DeviceRole;
  label?: string;
  requestedAt: string;
};

export type DeviceRolePeriod = {
  role: DeviceRole;
  validFrom: string;
  validUntil?: string;
};

export type AuthorizedDevice = {
  deviceId: string;
  publicKey: JsonWebKey;
  role: DeviceRole;
  status: "active" | "revoked";
  label?: string;
  addedAt: string;
  revokedAt?: string;
  roleHistory: DeviceRolePeriod[];
};

export type FamilyConfig = {
  schemaVersion: 1;
  householdId: string;
  version: number;
  updatedAt: string;
  rootDeviceId: string;
  rootPublicKey: JsonWebKey;
  kdf: HouseholdKdfParameters;
  devices: AuthorizedDevice[];
  encryptedHousehold: EncryptedJson;
  signature: string;
};

// T documents the decrypted payload type without changing the serialized envelope.
declare const familyEventPayloadType: unique symbol;

export type FamilyEventEnvelope<T = unknown> = {
  id: string;
  deviceId: string;
  role: DeviceRole;
  op: FamilyOperationKind;
  timestamp: string;
  iv: string;
  ciphertext: string;
  signature: string;
  readonly [familyEventPayloadType]?: T;
};

export type DeviceConfigChange =
  | {
      action: "approve";
      request: DeviceRequest;
      role: DeviceRole;
      label?: string;
    }
  | {
      action: "update-role";
      deviceId: string;
      role: DeviceRole;
    }
  | {
      action: "revoke";
      deviceId: string;
    };

export type GitHubFamilyClientOptions = {
  owner: string;
  repo: string;
  branch?: string;
  workflowRef?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type GitHubConfigResult = {
  config: FamilyConfig;
  sha: string;
};

export class FamilySyncValidationError extends Error {
  readonly code:
    | "invalid-config"
    | "invalid-config-signature"
    | "untrusted-root"
    | "invalid-event"
    | "unknown-device"
    | "revoked-device"
    | "role-mismatch"
    | "operation-denied"
    | "invalid-event-signature"
    | "duplicate-event-conflict";

  constructor(code: FamilySyncValidationError["code"], message: string) {
    super(message);
    this.name = "FamilySyncValidationError";
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_PBKDF2_ITERATIONS = 310_000;
const CONFIG_PATH = "config/household.json";
const EVENTS_PATH = "events";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is unavailable in this environment");
  }
  return globalThis.crypto;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function utf8ToBase64(value: string): string {
  return bytesToBase64(encoder.encode(value));
}

function base64ToUtf8(value: string): string {
  return decoder.decode(base64ToBytes(value));
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Only finite JSON numbers can be signed");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") throw new TypeError("Value is not JSON serializable");

  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = canonicalize(child);
  }
  return result;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function normalizePublicJwk(jwk: JsonWebKey): JsonWebKey {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new FamilySyncValidationError("invalid-config", "Expected an ECDSA P-256 public key");
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

async function importVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    "jwk",
    normalizePublicJwk(jwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

async function signBytes(privateKey: CryptoKey, value: unknown): Promise<string> {
  const signature = await webCrypto().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(canonicalStringify(value)),
  );
  return bytesToBase64(new Uint8Array(signature));
}

async function verifyBytes(publicKey: CryptoKey, value: unknown, signature: string): Promise<boolean> {
  try {
    return await webCrypto().subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64ToBytes(signature),
      encoder.encode(canonicalStringify(value)),
    );
  } catch {
    return false;
  }
}

async function publicKeyDeviceId(publicKey: JsonWebKey): Promise<string> {
  const digest = await webCrypto().subtle.digest(
    "SHA-256",
    encoder.encode(canonicalStringify(normalizePublicJwk(publicKey))),
  );
  const urlSafe = bytesToBase64(new Uint8Array(digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `device_${urlSafe.slice(0, 32)}`;
}

export async function createDeviceIdentity(): Promise<DeviceKeyMaterial> {
  const pair = (await webCrypto().subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKeyJwk = normalizePublicJwk(await webCrypto().subtle.exportKey("jwk", pair.publicKey));
  return {
    deviceId: await publicKeyDeviceId(publicKeyJwk),
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyJwk,
  };
}

export function exportDeviceRequest(
  material: DeviceKeyMaterial,
  requestedRole: DeviceRole,
  options: { label?: string; requestedAt?: string } = {},
): DeviceRequest {
  return {
    deviceId: material.deviceId,
    publicKey: normalizePublicJwk(material.publicKeyJwk),
    requestedRole,
    ...(options.label ? { label: options.label } : {}),
    requestedAt: options.requestedAt ?? new Date().toISOString(),
  };
}

export function createHouseholdKdfParameters(
  options: { iterations?: number; salt?: Uint8Array } = {},
): HouseholdKdfParameters {
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 100_000) {
    throw new RangeError("PBKDF2 iterations must be an integer of at least 100000");
  }
  const salt = options.salt ?? webCrypto().getRandomValues(new Uint8Array(16));
  if (salt.byteLength < 16) throw new RangeError("PBKDF2 salt must be at least 16 bytes");
  return {
    algorithm: "PBKDF2",
    hash: "SHA-256",
    iterations,
    salt: bytesToBase64(salt),
  };
}

export async function deriveHouseholdKey(
  passphrase: string,
  parameters: HouseholdKdfParameters,
): Promise<CryptoKey> {
  if (!passphrase) throw new TypeError("Household passphrase cannot be empty");
  if (
    parameters.algorithm !== "PBKDF2" ||
    parameters.hash !== "SHA-256" ||
    !Number.isInteger(parameters.iterations) ||
    parameters.iterations < 100_000
  ) {
    throw new TypeError("Unsupported or unsafe household KDF parameters");
  }
  const baseKey = await webCrypto().subtle.importKey(
    "raw",
    encoder.encode(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return webCrypto().subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(parameters.salt),
      iterations: parameters.iterations,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptJson(key: CryptoKey, value: unknown, aad: unknown): Promise<EncryptedJson> {
  const iv = webCrypto().getRandomValues(new Uint8Array(12));
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(canonicalStringify(aad)),
      tagLength: 128,
    },
    key,
    encoder.encode(canonicalStringify(value)),
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptJson<T>(key: CryptoKey, encrypted: EncryptedJson, aad: unknown): Promise<T> {
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(encrypted.iv),
      additionalData: encoder.encode(canonicalStringify(aad)),
      tagLength: 128,
    },
    key,
    base64ToBytes(encrypted.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

function configSigningPayload(config: FamilyConfig | Omit<FamilyConfig, "signature">) {
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

function eventMetadata(event: Pick<FamilyEventEnvelope, "id" | "deviceId" | "role" | "op" | "timestamp">) {
  return {
    id: event.id,
    deviceId: event.deviceId,
    role: event.role,
    op: event.op,
    timestamp: event.timestamp,
  };
}

function eventSigningPayload(event: FamilyEventEnvelope | Omit<FamilyEventEnvelope, "signature">) {
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

async function signConfig(
  config: Omit<FamilyConfig, "signature">,
  rootPrivateKey: CryptoKey,
): Promise<FamilyConfig> {
  return { ...config, signature: await signBytes(rootPrivateKey, config) };
}

function assertRole(value: unknown): asserts value is DeviceRole {
  if (value !== "child" && value !== "parent") {
    throw new FamilySyncValidationError("invalid-event", "Invalid device role");
  }
}

function assertOperation(value: unknown): asserts value is FamilyOperationKind {
  if (
    typeof value !== "string" ||
    !Object.values(FAMILY_OPERATION_ALLOWLIST).some((operations) =>
      (operations as readonly string[]).includes(value),
    )
  ) {
    throw new FamilySyncValidationError("invalid-event", "Unknown family operation");
  }
}

function assertIsoTimestamp(value: unknown, config = false): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new FamilySyncValidationError(config ? "invalid-config" : "invalid-event", "Invalid timestamp");
  }
}

function assertConfigShape(config: FamilyConfig): void {
  if (
    !config ||
    config.schemaVersion !== 1 ||
    typeof config.householdId !== "string" ||
    !config.householdId ||
    !Number.isInteger(config.version) ||
    config.version < 1 ||
    typeof config.rootDeviceId !== "string" ||
    !Array.isArray(config.devices) ||
    typeof config.signature !== "string" ||
    config.kdf?.algorithm !== "PBKDF2" ||
    config.kdf?.hash !== "SHA-256" ||
    !Number.isInteger(config.kdf?.iterations) ||
    config.kdf.iterations < 100_000 ||
    typeof config.kdf.salt !== "string" ||
    typeof config.encryptedHousehold?.iv !== "string" ||
    typeof config.encryptedHousehold?.ciphertext !== "string"
  ) {
    throw new FamilySyncValidationError("invalid-config", "Malformed family config");
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
    throw new FamilySyncValidationError("invalid-config", "Family config contains unknown fields");
  }
  assertIsoTimestamp(config.updatedAt, true);
  normalizePublicJwk(config.rootPublicKey);
  const ids = new Set<string>();
  for (const device of config.devices) {
    if (
      !device ||
      typeof device.deviceId !== "string" ||
      !device.deviceId ||
      ids.has(device.deviceId) ||
      typeof device.addedAt !== "string" ||
      (device.label !== undefined && typeof device.label !== "string") ||
      (device.revokedAt !== undefined && typeof device.revokedAt !== "string") ||
      (device.status !== "active" && device.status !== "revoked")
    ) {
      throw new FamilySyncValidationError("invalid-config", "Malformed or duplicate authorized device");
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
      throw new FamilySyncValidationError("invalid-config", "Authorized device contains unknown fields");
    }
    assertRole(device.role);
    normalizePublicJwk(device.publicKey);
    if (!Array.isArray(device.roleHistory) || device.roleHistory.length === 0) {
      throw new FamilySyncValidationError("invalid-config", "Authorized device is missing role history");
    }
    for (const [periodIndex, period] of device.roleHistory.entries()) {
      if (!hasOnlyKeys(period, ["role", "validFrom", "validUntil"])) {
        throw new FamilySyncValidationError("invalid-config", "Role history contains unknown fields");
      }
      assertRole(period.role);
      assertIsoTimestamp(period.validFrom, true);
      if (period.validUntil) {
        assertIsoTimestamp(period.validUntil, true);
        if (Date.parse(period.validUntil) < Date.parse(period.validFrom)) {
          throw new FamilySyncValidationError("invalid-config", "Invalid device role period");
        }
      }
      const previous = device.roleHistory[periodIndex - 1];
      if (
        previous &&
        (!previous.validUntil || Date.parse(period.validFrom) < Date.parse(previous.validUntil))
      ) {
        throw new FamilySyncValidationError("invalid-config", "Overlapping or unordered role history");
      }
    }
    const firstPeriod = device.roleHistory[0];
    const lastPeriod = device.roleHistory.at(-1)!;
    if (
      firstPeriod.validFrom !== device.addedAt ||
      lastPeriod.role !== device.role ||
      (device.status === "active" && lastPeriod.validUntil) ||
      (device.status === "revoked" && lastPeriod.validUntil !== device.revokedAt)
    ) {
      throw new FamilySyncValidationError("invalid-config", "Role history does not match device status");
    }
    if (device.status === "revoked" && !device.revokedAt) {
      throw new FamilySyncValidationError("invalid-config", "Revoked device is missing revokedAt");
    }
  }
  const root = config.devices.find((device) => device.deviceId === config.rootDeviceId);
  if (!root || root.role !== "parent" || root.status !== "active") {
    throw new FamilySyncValidationError("invalid-config", "Root device must be an active parent");
  }
  if (
    canonicalStringify(normalizePublicJwk(root.publicKey)) !==
    canonicalStringify(normalizePublicJwk(config.rootPublicKey))
  ) {
    throw new FamilySyncValidationError("invalid-config", "Root device key does not match root key");
  }
}

function assertEventMetadataShape(
  event: Pick<FamilyEventEnvelope, "id" | "deviceId" | "role" | "op" | "timestamp">,
): void {
  if (
    !event ||
    typeof event.id !== "string" ||
    !/^[A-Za-z0-9_-]{12,100}$/.test(event.id) ||
    typeof event.deviceId !== "string" ||
    !event.deviceId
  ) {
    throw new FamilySyncValidationError("invalid-event", "Malformed family event metadata");
  }
  assertRole(event.role);
  assertOperation(event.op);
  assertIsoTimestamp(event.timestamp);
}

function assertEventShape(event: FamilyEventEnvelope): void {
  assertEventMetadataShape(event);
  if (
    typeof event.iv !== "string" ||
    typeof event.ciphertext !== "string" ||
    typeof event.signature !== "string"
  ) {
    throw new FamilySyncValidationError("invalid-event", "Malformed family event envelope");
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
    throw new FamilySyncValidationError("invalid-event", "Event envelope contains unknown fields");
  }
  try {
    if (base64ToBytes(event.iv).byteLength !== 12) throw new Error("bad iv");
    if (base64ToBytes(event.ciphertext).byteLength < 17) throw new Error("bad ciphertext");
    if (base64ToBytes(event.signature).byteLength < 32) throw new Error("bad signature");
  } catch {
    throw new FamilySyncValidationError("invalid-event", "Invalid event cryptographic fields");
  }
}

export async function createInitialFamilyConfig<T>(options: {
  householdId: string;
  rootDevice: DeviceKeyMaterial;
  householdKey: CryptoKey;
  kdf: HouseholdKdfParameters;
  household: T;
  rootDeviceLabel?: string;
  updatedAt?: string;
}): Promise<FamilyConfig> {
  if (!options.householdId) throw new TypeError("householdId is required");
  if ((await publicKeyDeviceId(options.rootDevice.publicKeyJwk)) !== options.rootDevice.deviceId) {
    throw new FamilySyncValidationError("invalid-config", "Root device ID does not match its public key");
  }
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  assertIsoTimestamp(updatedAt, true);
  const encryptedHousehold = await encryptJson(
    options.householdKey,
    options.household,
    { type: "family-config", householdId: options.householdId },
  );
  return signConfig(
    {
      schemaVersion: 1,
      householdId: options.householdId,
      version: 1,
      updatedAt,
      rootDeviceId: options.rootDevice.deviceId,
      rootPublicKey: normalizePublicJwk(options.rootDevice.publicKeyJwk),
      kdf: options.kdf,
      devices: [
        {
          deviceId: options.rootDevice.deviceId,
          publicKey: normalizePublicJwk(options.rootDevice.publicKeyJwk),
          role: "parent",
          status: "active",
          ...(options.rootDeviceLabel ? { label: options.rootDeviceLabel } : {}),
          addedAt: updatedAt,
          roleHistory: [{ role: "parent", validFrom: updatedAt }],
        },
      ],
      encryptedHousehold,
    },
    options.rootDevice.privateKey,
  );
}

export async function decryptFamilyConfig<T>(config: FamilyConfig, householdKey: CryptoKey): Promise<T> {
  return decryptJson<T>(
    householdKey,
    config.encryptedHousehold,
    { type: "family-config", householdId: config.householdId },
  );
}

export async function approveOrRevokeDevice(
  config: FamilyConfig,
  change: DeviceConfigChange,
  rootPrivateKey: CryptoKey,
  updatedAt = new Date().toISOString(),
): Promise<FamilyConfig> {
  assertConfigShape(config);
  if (!(await verifyConfig(config))) {
    throw new FamilySyncValidationError("invalid-config-signature", "Cannot update an invalid family config");
  }
  assertIsoTimestamp(updatedAt, true);
  if (Date.parse(updatedAt) < Date.parse(config.updatedAt)) {
    throw new FamilySyncValidationError("invalid-config", "Config update time cannot move backwards");
  }
  const devices = config.devices.map((device) => ({
    ...device,
    publicKey: { ...device.publicKey },
    roleHistory: device.roleHistory.map((period) => ({ ...period })),
  }));

  if (change.action === "approve") {
    const computedId = await publicKeyDeviceId(change.request.publicKey);
    if (computedId !== change.request.deviceId) {
      throw new FamilySyncValidationError("invalid-config", "Device request ID does not match its public key");
    }
    const existing = devices.findIndex((device) => device.deviceId === change.request.deviceId);
    const previous = existing >= 0 ? devices[existing] : undefined;
    if (previous?.status === "active") {
      throw new FamilySyncValidationError(
        "invalid-config",
        "Device is already active; use update-role to change its role",
      );
    }
    const previousHistory = previous?.roleHistory ?? [];
    const approved: AuthorizedDevice = {
      deviceId: change.request.deviceId,
      publicKey: normalizePublicJwk(change.request.publicKey),
      role: change.role,
      status: "active",
      ...(change.label ?? change.request.label ? { label: change.label ?? change.request.label } : {}),
      addedAt: previous?.addedAt ?? updatedAt,
      roleHistory: [...previousHistory, { role: change.role, validFrom: updatedAt }],
    };
    if (existing >= 0) devices[existing] = approved;
    else devices.push(approved);
  } else {
    const index = devices.findIndex((device) => device.deviceId === change.deviceId);
    if (index < 0) {
      throw new FamilySyncValidationError("unknown-device", "Device is not in this household");
    }
    if (change.deviceId === config.rootDeviceId) {
      throw new FamilySyncValidationError("invalid-config", "The root device cannot be changed or revoked");
    }
    if (devices[index].status !== "active") {
      throw new FamilySyncValidationError("revoked-device", "Revoked device must be re-approved first");
    }
    const roleHistory = devices[index].roleHistory.map((period, periodIndex, periods) =>
      periodIndex === periods.length - 1 && !period.validUntil
        ? { ...period, validUntil: updatedAt }
        : period,
    );
    devices[index] =
      change.action === "update-role"
        ? {
            ...devices[index],
            role: change.role,
            roleHistory: [...roleHistory, { role: change.role, validFrom: updatedAt }],
          }
        : {
            ...devices[index],
            status: "revoked",
            revokedAt: updatedAt,
            roleHistory,
          };
  }

  devices.sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  const updatedConfig = await signConfig(
    {
      ...configSigningPayload(config),
      version: config.version + 1,
      updatedAt,
      devices,
    },
    rootPrivateKey,
  );
  if (!(await verifyConfig(updatedConfig, config.rootPublicKey))) {
    throw new FamilySyncValidationError("invalid-config-signature", "Root private key does not match the config");
  }
  return updatedConfig;
}

export async function verifyConfig(
  config: FamilyConfig,
  trustedRootPublicKey?: JsonWebKey,
): Promise<boolean> {
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

function createEventId(): string {
  if (typeof webCrypto().randomUUID === "function") {
    return `event_${webCrypto().randomUUID()}`;
  }
  return `event_${bytesToBase64(webCrypto().getRandomValues(new Uint8Array(18)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

export async function createEncryptedEvent<T>(options: {
  device: DeviceKeyMaterial;
  role: DeviceRole;
  op: FamilyOperationKind;
  payload: T;
  householdKey: CryptoKey;
  id?: string;
  timestamp?: string;
}): Promise<FamilyEventEnvelope<T>> {
  assertRole(options.role);
  assertOperation(options.op);
  if (!FAMILY_OPERATION_ALLOWLIST[options.role].includes(options.op)) {
    throw new FamilySyncValidationError("operation-denied", "This role cannot create that operation");
  }
  const metadata = {
    id: options.id ?? createEventId(),
    deviceId: options.device.deviceId,
    role: options.role,
    op: options.op,
    timestamp: options.timestamp ?? new Date().toISOString(),
  };
  assertEventMetadataShape(metadata);
  const encrypted = await encryptJson(options.householdKey, options.payload, metadata);
  const unsigned = { ...metadata, ...encrypted };
  return { ...unsigned, signature: await signBytes(options.device.privateKey, unsigned) };
}

export async function decryptEvent<T>(
  event: FamilyEventEnvelope<T>,
  householdKey: CryptoKey,
): Promise<T> {
  assertEventShape(event);
  return decryptJson<T>(
    householdKey,
    { iv: event.iv, ciphertext: event.ciphertext },
    eventMetadata(event),
  );
}

export async function validateEventEnvelope(
  event: FamilyEventEnvelope,
  config: FamilyConfig,
  options: {
    trustedRootPublicKey?: JsonWebKey;
    mode?: "replay" | "append";
  } = {},
): Promise<AuthorizedDevice> {
  assertConfigShape(config);
  if (!(await verifyConfig(config, options.trustedRootPublicKey))) {
    throw new FamilySyncValidationError(
      options.trustedRootPublicKey ? "untrusted-root" : "invalid-config-signature",
      "Family config signature is invalid or the root key is not trusted",
    );
  }
  assertEventShape(event);
  const device = config.devices.find((candidate) => candidate.deviceId === event.deviceId);
  if (!device) throw new FamilySyncValidationError("unknown-device", "Event device is not approved");
  const eventTime = Date.parse(event.timestamp);
  if (options.mode === "append" && device.status !== "active") {
    throw new FamilySyncValidationError("revoked-device", "Revoked device cannot append new events");
  }
  if (device.status === "revoked" && device.revokedAt && eventTime >= Date.parse(device.revokedAt)) {
    throw new FamilySyncValidationError("revoked-device", "Event device has been revoked");
  }
  const currentRolePeriod = device.roleHistory.at(-1)!;
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
  if (!roleAtEvent) {
    throw new FamilySyncValidationError("unknown-device", "Device was not approved at the event time");
  }
  if (roleAtEvent !== event.role) {
    throw new FamilySyncValidationError("role-mismatch", "Event role does not match the approved role");
  }
  if (!FAMILY_OPERATION_ALLOWLIST[roleAtEvent].includes(event.op)) {
    throw new FamilySyncValidationError("operation-denied", "Device role cannot perform this operation");
  }
  const publicKey = await importVerifyKey(device.publicKey);
  if (!(await verifyBytes(publicKey, eventSigningPayload(event), event.signature))) {
    throw new FamilySyncValidationError("invalid-event-signature", "Event signature is invalid");
  }
  return device;
}

export function dedupeAndSortEvents<T>(
  events: readonly FamilyEventEnvelope<T>[],
): FamilyEventEnvelope<T>[] {
  const byId = new Map<string, FamilyEventEnvelope<T>>();
  for (const event of events) {
    assertEventShape(event);
    const existing = byId.get(event.id);
    if (existing && canonicalStringify(existing) !== canonicalStringify(event)) {
      throw new FamilySyncValidationError(
        "duplicate-event-conflict",
        `Conflicting events use the same ID: ${event.id}`,
      );
    }
    if (!existing) byId.set(event.id, event);
  }
  return [...byId.values()].sort((left, right) => {
    const byTimestamp = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return byTimestamp || left.id.localeCompare(right.id);
  });
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function githubHeaders(token: string): HeadersInit {
  if (!token) throw new TypeError("GitHub token is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
  };
}

export class GitHubFamilyClient {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly workflowRef: string;
  readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubFamilyClientOptions) {
    if (!options.owner || !options.repo) throw new TypeError("GitHub owner and repo are required");
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch ?? "main";
    this.workflowRef = options.workflowRef ?? "family-sync.yml";
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    // Safari brand-checks Window.fetch. Keeping the native function as an
    // instance field and calling `this.fetchImpl(...)` changes its receiver to
    // GitHubFamilyClient and throws `Illegal invocation` on iPadOS.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private endpoint(path: string): string {
    return `${this.apiBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${path}`;
  }

  private async request(
    token: string,
    url: string,
    init: RequestInit = {},
    allowNotFound = false,
  ): Promise<Response> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { ...githubHeaders(token), ...init.headers },
    });
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      throw new Error(`GitHub API request failed (${response.status})`);
    }
    return response;
  }

  private async readJsonFile<T>(token: string, path: string): Promise<{ value: T; sha: string }> {
    const response = await this.request(
      token,
      `${this.endpoint(`contents/${encodePath(path)}`)}?ref=${encodeURIComponent(this.branch)}`,
    );
    const body = (await response.json()) as { content?: string; encoding?: string; sha?: string };
    if (body.encoding !== "base64" || !body.content || !body.sha) {
      throw new Error("GitHub contents response did not contain a base64 file");
    }
    return { value: JSON.parse(base64ToUtf8(body.content)) as T, sha: body.sha };
  }

  async readConfig(token: string): Promise<GitHubConfigResult> {
    const result = await this.readJsonFile<FamilyConfig>(token, CONFIG_PATH);
    return { config: result.value, sha: result.sha };
  }

  async listEvents<T = unknown>(token: string): Promise<FamilyEventEnvelope<T>[]> {
    const response = await this.request(
      token,
      `${this.endpoint(`contents/${EVENTS_PATH}`)}?ref=${encodeURIComponent(this.branch)}`,
      {},
      true,
    );
    if (response.status === 404) return [];
    const entries = (await response.json()) as Array<{ name?: string; path?: string; type?: string }>;
    if (!Array.isArray(entries)) throw new Error("GitHub events path is not a directory");
    if (entries.length >= 1_000) {
      throw new Error("GitHub contents API directory limit reached; archive old events before continuing");
    }
    const files = entries.filter(
      (entry): entry is { name: string; path: string; type: string } =>
        entry.type === "file" &&
        typeof entry.name === "string" &&
        entry.name.endsWith(".json") &&
        typeof entry.path === "string",
    );
    const events: FamilyEventEnvelope<T>[] = [];
    for (let start = 0; start < files.length; start += 20) {
      const batch = await Promise.all(
        files
          .slice(start, start + 20)
          .map(async (entry) =>
            (await this.readJsonFile<FamilyEventEnvelope<T>>(token, entry.path)).value
          ),
      );
      events.push(...batch);
    }
    return dedupeAndSortEvents(events);
  }

  async dispatchEvent(token: string, event: FamilyEventEnvelope): Promise<void> {
    assertEventShape(event);
    await this.request(
      token,
      this.endpoint(`actions/workflows/${encodeURIComponent(this.workflowRef)}/dispatches`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: this.branch,
          inputs: { event: utf8ToBase64(canonicalStringify(event)) },
        }),
      },
    );
  }

  async initializeConfig(token: string, config: FamilyConfig): Promise<GitHubConfigResult> {
    return this.writeConfig(token, config, undefined, "Initialize encrypted family sync config");
  }

  async updateConfig(
    token: string,
    config: FamilyConfig,
    expectedSha: string,
  ): Promise<GitHubConfigResult> {
    if (!expectedSha) throw new TypeError("expectedSha is required for optimistic concurrency");
    return this.writeConfig(token, config, expectedSha, "Update encrypted family sync config");
  }

  private async writeConfig(
    token: string,
    config: FamilyConfig,
    expectedSha: string | undefined,
    message: string,
  ): Promise<GitHubConfigResult> {
    if (!(await verifyConfig(config))) {
      throw new FamilySyncValidationError("invalid-config-signature", "Refusing to upload invalid config");
    }
    const response = await this.request(token, this.endpoint(`contents/${encodePath(CONFIG_PATH)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: utf8ToBase64(`${canonicalStringify(config)}\n`),
        branch: this.branch,
        ...(expectedSha ? { sha: expectedSha } : {}),
      }),
    });
    const body = (await response.json()) as { content?: { sha?: string } };
    const sha = body.content?.sha;
    if (!sha) throw new Error("GitHub config update did not return a content SHA");
    return { config, sha };
  }
}

export function createGithubFamilyClient(options: GitHubFamilyClientOptions): GitHubFamilyClient {
  return new GitHubFamilyClient(options);
}
