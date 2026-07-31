import type {
  DeviceKeyMaterial,
  DeviceRequest,
  DeviceRole,
  FamilyConfig,
  FamilyEventEnvelope,
} from "./github-family-sync.ts";

export type FamilyConnectionProfile = {
  id: "current";
  owner: string;
  repo: string;
  branch: string;
  workflowRef: string;
  token: string;
  deviceLabel: string;
  requestedRole: DeviceRole;
  identity: DeviceKeyMaterial;
  householdKey: CryptoKey | null;
  trustedRootPublicKey: JsonWebKey | null;
  config: FamilyConfig | null;
  configSha: string | null;
  lastSyncAt: string | null;
  lastPublishedDigest?: string | null;
  /**
   * Digest of the newest game state whose local IndexedDB save completed.
   * If it differs from lastPublishedDigest after a crash, startup can recover
   * by placing that saved state in the outbox.
   */
  lastObservedDigest?: string | null;
  lastAppliedEventIds: string[];
  pendingDeviceRequests: DeviceRequest[];
};

export type QueuedFamilyEvent = {
  id: string;
  createdAt: string;
  envelope: FamilyEventEnvelope;
  attempts: number;
  lastError?: string;
  dispatchedAt?: string;
};

const DB_NAME = "summer-pet-family-sync";
const DB_VERSION = 1;
const PROFILE_STORE = "profile";
const QUEUE_STORE = "outbox";
const CURRENT_PROFILE_ID = "current";

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROFILE_STORE)) {
        database.createObjectStore(PROFILE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        database.createObjectStore(QUEUE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open family sync storage"));
    request.onblocked = () => reject(new Error("Family sync storage upgrade was blocked"));
  });
}

export async function loadFamilyConnectionProfile() {
  if (typeof indexedDB === "undefined") return null;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PROFILE_STORE, "readonly");
    const profile = await requestResult(
      transaction.objectStore(PROFILE_STORE).get(CURRENT_PROFILE_ID) as IDBRequest<
        FamilyConnectionProfile | undefined
      >,
    );
    await transactionDone(transaction);
    return profile ?? null;
  } finally {
    database.close();
  }
}

export async function saveFamilyConnectionProfile(profile: FamilyConnectionProfile) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PROFILE_STORE, "readwrite");
    transaction.objectStore(PROFILE_STORE).put({
      ...profile,
      id: CURRENT_PROFILE_ID,
      lastAppliedEventIds: profile.lastAppliedEventIds.slice(-2_000),
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function deleteFamilyConnectionProfile() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([PROFILE_STORE, QUEUE_STORE], "readwrite");
    transaction.objectStore(PROFILE_STORE).delete(CURRENT_PROFILE_ID);
    transaction.objectStore(QUEUE_STORE).clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function enqueueFamilyEvent(envelope: FamilyEventEnvelope) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(QUEUE_STORE, "readwrite");
    transaction.objectStore(QUEUE_STORE).put({
      id: envelope.id,
      createdAt: envelope.timestamp,
      envelope,
      attempts: 0,
    } satisfies QueuedFamilyEvent);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function listQueuedFamilyEvents() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(QUEUE_STORE, "readonly");
    const events = await requestResult(
      transaction.objectStore(QUEUE_STORE).getAll() as IDBRequest<QueuedFamilyEvent[]>,
    );
    await transactionDone(transaction);
    return events.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
  } finally {
    database.close();
  }
}

export async function markFamilyEventAttempt(id: string, error: unknown) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(QUEUE_STORE, "readwrite");
    const store = transaction.objectStore(QUEUE_STORE);
    const event = await requestResult(store.get(id) as IDBRequest<QueuedFamilyEvent | undefined>);
    if (event) {
      store.put({
        ...event,
        attempts: event.attempts + 1,
        lastError: error instanceof Error ? error.message.slice(0, 200) : "同步失败",
      } satisfies QueuedFamilyEvent);
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function markFamilyEventDispatched(
  id: string,
  dispatchedAt = new Date().toISOString(),
) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(QUEUE_STORE, "readwrite");
    const store = transaction.objectStore(QUEUE_STORE);
    const event = await requestResult(
      store.get(id) as IDBRequest<QueuedFamilyEvent | undefined>,
    );
    if (event) {
      store.put({
        ...event,
        attempts: event.attempts + 1,
        dispatchedAt,
        lastError: undefined,
      } satisfies QueuedFamilyEvent);
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function removeQueuedFamilyEvent(id: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(QUEUE_STORE, "readwrite");
    transaction.objectStore(QUEUE_STORE).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
