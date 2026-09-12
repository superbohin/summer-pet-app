"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const cloudbase = process.env.SUMMER_PET_STORAGE === "postgresql"
  ? require("@cloudbase/js-sdk")
  : require("@cloudbase/node-sdk");
const { createPgDocumentStore } = require("./pg-store");
const {
  canonicalStringify,
  validateInitialConfig,
  validateDeviceRequest,
  validateEventEnvelope,
  verifyRequestProof,
  verifyConfig,
} = require("./crypto");

const CONFIG_COLLECTION = "summer_pet_config";
const EVENT_COLLECTION = "summer_pet_events";
const REQUEST_COLLECTION = "summer_pet_device_requests";
const CURRENT_CONFIG_ID = "current";
const QUERY_PAGE_SIZE = 100;
const MAX_EVENT_COUNT = 5_000;
const MAX_EXCLUDE_IDS = 5_000;

function serviceError(code, message) {
  const error = new Error(message);
  error.name = "FamilyCloudBaseError";
  error.code = code;
  return error;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("INVALID_ARGUMENT", `${name} must be an object`);
  }
}

function documentData(result) {
  const data = result?.data;
  if (Array.isArray(data)) return data[0] ?? null;
  return data && typeof data === "object" ? data : null;
}

function isMissingDocument(error) {
  const marker = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return (
    marker.includes("document_not_exist") ||
    marker.includes("document not exist") ||
    marker.includes("not found")
  );
}

async function getDocumentOrNull(reference) {
  try {
    return documentData(await reference.get());
  } catch (error) {
    if (isMissingDocument(error)) return null;
    throw error;
  }
}

function configRevision(config) {
  return String(config.version);
}

function assertRequestProofKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 44 ||
    value.length > 180 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw serviceError("INVALID_ARGUMENT", "A valid requestProofKey is required");
  }
  return value;
}

async function requireRequestProof(record, payload, signature) {
  if (
    !record?.requestProofKey ||
    typeof signature !== "string" ||
    !(await verifyRequestProof(record.requestProofKey, payload, signature))
  ) {
    throw serviceError("INVALID_REQUEST_PROOF", "Family request authorization failed");
  }
}

async function requireStoredConfig(reference) {
  const record = await getDocumentOrNull(reference);
  const config = record?.config;
  if (!config) throw serviceError("CONFIG_NOT_FOUND", "Family config has not been initialized");
  if (!(await verifyConfig(config))) {
    throw serviceError("INVALID_STORED_CONFIG", "Stored family config signature is invalid");
  }
  return config;
}

function sameRoot(left, right) {
  return (
    left.householdId === right.householdId &&
    left.rootDeviceId === right.rootDeviceId &&
    canonicalStringify(left.rootPublicKey) === canonicalStringify(right.rootPublicKey)
  );
}

async function getConfig(db) {
  const record = await getDocumentOrNull(db.collection(CONFIG_COLLECTION).doc(CURRENT_CONFIG_ID));
  if (!record?.config) {
    throw serviceError("CONFIG_NOT_FOUND", "Family config has not been initialized");
  }
  if (!(await verifyConfig(record.config))) {
    throw serviceError("INVALID_STORED_CONFIG", "Stored family config signature is invalid");
  }
  return { config: record.config, revision: configRevision(record.config) };
}

async function initializeConfig(db, input) {
  assertPlainObject(input.config, "config");
  const requestProofKey = assertRequestProofKey(input.requestProofKey);
  await validateInitialConfig(input.config, process.env.SUMMER_PET_ROOT_DEVICE_ID);
  let result;
  const transactionResult = await db.runTransaction(async (transaction) => {
    const reference = transaction.collection(CONFIG_COLLECTION).doc(CURRENT_CONFIG_ID);
    const existing = await getDocumentOrNull(reference);
    if (existing?.config) {
      if (canonicalStringify(existing.config) === canonicalStringify(input.config)) {
        if (
          existing.requestProofKey &&
          existing.requestProofKey !== requestProofKey
        ) {
          throw serviceError(
            "REQUEST_PROOF_CONFLICT",
            "Family request authorization key does not match",
          );
        }
        if (!existing.requestProofKey) {
          await reference.set({
            config: existing.config,
            revision: configRevision(existing.config),
            requestProofKey,
            createdAt: existing.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        result = { config: existing.config, revision: configRevision(existing.config) };
        return result;
      }
      throw serviceError("CONFIG_ALREADY_EXISTS", "Family config has already been initialized");
    }
    await reference.set({
      config: input.config,
      requestProofKey,
      revision: configRevision(input.config),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    result = { config: input.config, revision: configRevision(input.config) };
    return result;
  });
  return transactionResult?.result ?? result;
}

async function updateConfig(db, input) {
  assertPlainObject(input.config, "config");
  if (typeof input.expectedRevision !== "string" || !input.expectedRevision) {
    throw serviceError("INVALID_ARGUMENT", "expectedRevision is required");
  }
  if (!(await verifyConfig(input.config))) {
    throw serviceError("INVALID_CONFIG", "Updated family config or root signature is invalid");
  }
  let result;
  const transactionResult = await db.runTransaction(async (transaction) => {
    const reference = transaction.collection(CONFIG_COLLECTION).doc(CURRENT_CONFIG_ID);
    const currentRecord = await getDocumentOrNull(reference);
    const current = currentRecord?.config;
    if (!current || !(await verifyConfig(current))) {
      throw serviceError("CONFIG_NOT_FOUND", "Family config has not been initialized");
    }
    const currentRevision = configRevision(current);
    if (input.expectedRevision !== currentRevision) {
      throw serviceError("REVISION_CONFLICT", "Family config changed; refresh before retrying");
    }
    if (!sameRoot(current, input.config)) {
      throw serviceError("UNTRUSTED_ROOT", "Household or root device cannot be replaced");
    }
    if (input.config.version <= current.version) {
      throw serviceError("INVALID_CONFIG_VERSION", "Family config version must increase");
    }
    if (Date.parse(input.config.updatedAt) < Date.parse(current.updatedAt)) {
      throw serviceError("INVALID_CONFIG_VERSION", "Family config update time cannot move backwards");
    }
    await reference.set({
      config: input.config,
      requestProofKey: currentRecord.requestProofKey,
      revision: configRevision(input.config),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    result = { config: input.config, revision: configRevision(input.config) };
    return result;
  });
  return transactionResult?.result ?? result;
}

async function submitDeviceRequest(db, input) {
  const request = await validateDeviceRequest(input.request);
  const configRecord = await getDocumentOrNull(
    db.collection(CONFIG_COLLECTION).doc(CURRENT_CONFIG_ID),
  );
  if (!configRecord?.config || !(await verifyConfig(configRecord.config))) {
    throw serviceError("CONFIG_NOT_FOUND", "Family config has not been initialized");
  }
  await requireRequestProof(
    configRecord,
    { action: "submitDeviceRequest", request },
    input.requestProof,
  );
  if (configRecord?.config) {
    if (!(await verifyConfig(configRecord.config))) {
      throw serviceError("INVALID_STORED_CONFIG", "Stored family config signature is invalid");
    }
    if (
      configRecord.config.devices.some(
        (device) => device.deviceId === request.deviceId && device.status === "active",
      )
    ) {
      return { accepted: true };
    }
  }
  await db.collection(REQUEST_COLLECTION).doc(request.deviceId).set({
    request,
    updatedAt: new Date().toISOString(),
  });
  return { accepted: true };
}

async function listDeviceRequests(db, input) {
  const configRecord = await getDocumentOrNull(
    db.collection(CONFIG_COLLECTION).doc(CURRENT_CONFIG_ID),
  );
  const config = configRecord?.config ?? null;
  if (!config) {
    throw serviceError("CONFIG_NOT_FOUND", "Family config has not been initialized");
  }
  if (!(await verifyConfig(config))) {
    throw serviceError("INVALID_STORED_CONFIG", "Stored family config signature is invalid");
  }
  await requireRequestProof(
    configRecord,
    { action: "listDeviceRequests" },
    input.requestProof,
  );
  const activeIds = new Set(
    config?.devices.filter((device) => device.status === "active").map((device) => device.deviceId) ?? [],
  );
  const result = await db.collection(REQUEST_COLLECTION).limit(1_000).get();
  const records = Array.isArray(result?.data) ? result.data : [];
  const requests = [];
  for (const record of records) {
    const request = await validateDeviceRequest(record.request);
    if (!activeIds.has(request.deviceId)) requests.push(request);
  }
  requests.sort(
    (left, right) =>
      left.requestedAt.localeCompare(right.requestedAt) || left.deviceId.localeCompare(right.deviceId),
  );
  return { requests };
}

async function resolveDeviceRequest(db, input) {
  if (typeof input.deviceId !== "string" || !/^device_[A-Za-z0-9_-]{32}$/.test(input.deviceId)) {
    throw serviceError("INVALID_ARGUMENT", "A valid deviceId is required");
  }
  const configReference = db.collection(CONFIG_COLLECTION).doc(CURRENT_CONFIG_ID);
  const configRecord = await getDocumentOrNull(configReference);
  const config = configRecord?.config;
  if (!config || !(await verifyConfig(config))) {
    throw serviceError("CONFIG_NOT_FOUND", "Family config has not been initialized");
  }
  await requireRequestProof(
    configRecord,
    { action: "resolveDeviceRequest", deviceId: input.deviceId },
    input.requestProof,
  );
  if (!config.devices.some((device) => device.deviceId === input.deviceId)) {
    throw serviceError(
      "DEVICE_NOT_RESOLVED",
      "An unapproved request cannot be deleted without a root-signed config decision",
    );
  }
  await db.collection(REQUEST_COLLECTION).doc(input.deviceId).remove();
  return { accepted: true };
}

function normalizeExcludeIds(value) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > MAX_EXCLUDE_IDS) {
    throw serviceError("INVALID_ARGUMENT", `excludeIds must contain at most ${MAX_EXCLUDE_IDS} IDs`);
  }
  const ids = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{12,100}$/.test(id)) {
      throw serviceError("INVALID_ARGUMENT", "excludeIds contains an invalid event ID");
    }
    ids.add(id);
  }
  return ids;
}

async function listAllEventRecords(db) {
  const records = [];
  for (let offset = 0; offset < MAX_EVENT_COUNT; offset += QUERY_PAGE_SIZE) {
    const result = await db
      .collection(EVENT_COLLECTION)
      .orderBy("timestamp", "asc")
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(QUERY_PAGE_SIZE)
      .get();
    const page = Array.isArray(result?.data) ? result.data : [];
    records.push(...page);
    if (page.length < QUERY_PAGE_SIZE) return records;
  }
  throw serviceError(
    "EVENT_LIMIT_REACHED",
    `The family event collection exceeds the current ${MAX_EVENT_COUNT}-event safety limit`,
  );
}

async function listEvents(db, input) {
  const excludeIds = normalizeExcludeIds(input.excludeIds);
  const configRecord = await getDocumentOrNull(
    db.collection(CONFIG_COLLECTION).doc(CURRENT_CONFIG_ID),
  );
  const config = configRecord?.config;
  if (!config || !(await verifyConfig(config))) {
    throw serviceError("CONFIG_NOT_FOUND", "Family config has not been initialized");
  }
  await requireRequestProof(
    configRecord,
    { action: "listEvents" },
    input.requestProof,
  );
  const records = await listAllEventRecords(db);
  const events = [];
  const remoteEventIds = [];
  const seenIds = new Set();
  for (const record of records) {
    const event = record.event;
    if (!event || record._id !== event.id || seenIds.has(event.id)) {
      throw serviceError("INVALID_STORED_EVENT", "Stored family event index is invalid or duplicated");
    }
    seenIds.add(event.id);
    try {
      await validateEventEnvelope(event, config, { mode: "replay" });
    } catch {
      // Events were strictly validated when appended. If a later role change,
      // revocation, or administrator edit makes one invalid under the newest
      // config, quarantine that record instead of blocking every device sync.
      continue;
    }
    remoteEventIds.push(event.id);
    if (!excludeIds.has(event.id)) events.push(event);
  }
  return { events, remoteEventIds };
}

async function appendEvent(db, input) {
  assertPlainObject(input.event, "event");
  let result;
  const transactionResult = await db.runTransaction(async (transaction) => {
    const config = await requireStoredConfig(
      transaction.collection(CONFIG_COLLECTION).doc(CURRENT_CONFIG_ID),
    );
    await validateEventEnvelope(input.event, config, { mode: "append" });
    const reference = transaction.collection(EVENT_COLLECTION).doc(input.event.id);
    const existing = await getDocumentOrNull(reference);
    if (existing?.event) {
      if (canonicalStringify(existing.event) !== canonicalStringify(input.event)) {
        throw serviceError("DUPLICATE_EVENT_CONFLICT", "The event ID already has different content");
      }
      result = { accepted: true, eventId: input.event.id };
      return result;
    }
    await reference.set({
      event: input.event,
      timestamp: input.event.timestamp,
      deviceId: input.event.deviceId,
      role: input.event.role,
      op: input.event.op,
      createdAt: new Date().toISOString(),
    });
    result = { accepted: true, eventId: input.event.id };
    return result;
  });
  return transactionResult?.result ?? result;
}

exports.main = async (event, context) => {
  assertPlainObject(event, "event");
  const action = event.action;
  if (typeof action !== "string") throw serviceError("INVALID_ARGUMENT", "action is required");

  const app = cloudbase.init({
    env: cloudbase.SYMBOL_CURRENT_ENV ?? cloudbase.SYMBOL_DEFAULT_ENV,
    context,
  });
  const db = process.env.SUMMER_PET_STORAGE === "postgresql"
    ? createPgDocumentStore(app.rdb())
    : app.database();
  let data;
  switch (action) {
    case "health":
      data = { service: "summer-pet-family", version: "1", schemaVersion: 1 };
      break;
    case "getConfig":
      data = await getConfig(db);
      break;
    case "initializeConfig":
      data = await initializeConfig(db, event);
      break;
    case "updateConfig":
      data = await updateConfig(db, event);
      break;
    case "submitDeviceRequest":
      data = await submitDeviceRequest(db, event);
      break;
    case "listDeviceRequests":
      data = await listDeviceRequests(db, event);
      break;
    case "resolveDeviceRequest":
      data = await resolveDeviceRequest(db, event);
      break;
    case "listEvents":
      data = await listEvents(db, event);
      break;
    case "appendEvent":
      data = await appendEvent(db, event);
      break;
    default:
      throw serviceError("UNKNOWN_ACTION", `Unsupported action: ${action}`);
  }
  return { ok: true, data };
};

exports._test = {
  configRevision,
  documentData,
  normalizeExcludeIds,
  sameRoot,
};
