export type PetType = "dog" | "cat" | "dino";
export type TaskCategory = "reading" | "writing" | "sport" | "homework" | "tidy" | "help" | "sleep" | "custom";

export type Task = {
  id: string;
  title: string;
  icon: string;
  category: TaskCategory;
  coins: number;
  xp: number;
  active: boolean;
};

export type RewardSnapshot = {
  title: string;
  category: TaskCategory;
  coins: number;
  xp: number;
};

export type DailyRecord = {
  completed: string[];
  rewards: Record<string, RewardSnapshot>;
  fullBonus: boolean;
  fullComplete: boolean;
};

export type PetState = {
  chosen: boolean;
  type: PetType;
  nickname: string;
  coins: number;
  xp: number;
  hearts: number;
  hunger: number;
  happiness: number;
  owned: string[];
  equippedClothes: string | null;
  equippedDecor: string | null;
};

export type TransactionKind =
  | "opening-balance"
  | "task-reward"
  | "full-bonus"
  | "task-undo"
  | "bonus-reversal"
  | "purchase"
  | "legacy-balance-adjustment";

export type GameTransaction = {
  id: string;
  at: string;
  date: string;
  kind: TransactionKind;
  coinsDelta: number;
  xpDelta: number;
  heartsDelta: number;
  note: string;
  taskId?: string;
  itemId?: string;
  itemName?: string;
};

export type GameData = {
  version: 2;
  pet: PetState;
  tasks: Task[];
  records: Record<string, DailyRecord>;
  badges: string[];
  transactions: GameTransaction[];
  settings: {
    sound: boolean;
    animations: boolean;
  };
  meta: {
    createdAt: string;
    updatedAt: string;
    lastMigratedAt: string;
    appVersion: string;
    taskSeedVersion: number;
    taskTombstones: string[];
  };
};

type LegacyGameDataV1 = Omit<GameData, "version" | "transactions" | "meta"> & {
  version: 1;
};

export const APP_VERSION = "0.2.0";
export const CURRENT_SCHEMA_VERSION = 2;
export const FULL_BONUS_COINS = 20;
export const PRIMARY_STORAGE_KEY = "summer-pet-data";
export const LEGACY_STORAGE_KEYS = ["summer-pet-v1"];

const DB_NAME = "summer-pet-db";
const DB_VERSION = 1;
const DATA_STORE = "data";
const SNAPSHOT_STORE = "snapshots";
const CURRENT_DATA_ID = "current";
const MAX_SNAPSHOTS = 12;

const permanentItemInfo: Record<string, { name: string; price: number }> = {
  cape: { name: "勇气披风", price: 45 },
  hat: { name: "夏日草帽", price: 40 },
  plant: { name: "向日葵盆栽", price: 50 },
  tent: { name: "星空帐篷", price: 65 },
};

export class DataSafetyError extends Error {
  rawData?: string;

  constructor(message: string, rawData?: string) {
    super(message);
    this.name = "DataSafetyError";
    this.rawData = rawData;
  }
}

export type LoadResult = {
  data: GameData;
  migratedFrom: number | null;
  recoveredFromSnapshot: boolean;
  usedLegacyLocalStorage: boolean;
};

type SnapshotRecord = {
  id: string;
  createdAt: string;
  reason: string;
  schemaVersion: number | null;
  payload: unknown;
};

function nowIso() {
  return new Date().toISOString();
}

function dateFromIso(value: string) {
  return value.slice(0, 10);
}

let transactionSequence = 0;

export function createTransaction(
  kind: TransactionKind,
  values: Omit<GameTransaction, "id" | "at" | "date" | "kind">,
  at = nowIso(),
): GameTransaction {
  const randomPart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${at}-${transactionSequence += 1}`;
  return {
    id: `${kind}:${randomPart}`,
    at,
    date: dateFromIso(at),
    kind,
    ...values,
  };
}

export function createInitialGameData(tasks: Task[]): GameData {
  const createdAt = nowIso();
  return {
    version: 2,
    pet: {
      chosen: false,
      type: "dog",
      nickname: "小布丁",
      coins: 30,
      xp: 0,
      hearts: 3,
      hunger: 78,
      happiness: 82,
      owned: [],
      equippedClothes: null,
      equippedDecor: null,
    },
    tasks,
    records: {},
    badges: [],
    transactions: [
      createTransaction("opening-balance", {
        coinsDelta: 30,
        xpDelta: 0,
        heartsDelta: 3,
        note: "初始成长资金",
      }, createdAt),
    ],
    settings: { sound: true, animations: true },
    meta: {
      createdAt,
      updatedAt: createdAt,
      lastMigratedAt: createdAt,
      appVersion: APP_VERSION,
      taskSeedVersion: 1,
      taskTombstones: [],
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaVersionOf(value: unknown) {
  if (!isObject(value)) return null;
  return typeof value.version === "number" ? value.version : null;
}

function validateCore(value: unknown) {
  if (!isObject(value)) return false;
  const pet = value.pet;
  return isObject(pet) &&
    typeof pet.coins === "number" &&
    typeof pet.xp === "number" &&
    typeof pet.hearts === "number" &&
    Array.isArray(pet.owned) &&
    Array.isArray(value.tasks) &&
    isObject(value.records) &&
    Array.isArray(value.badges) &&
    isObject(value.settings);
}

function migrateV1(value: LegacyGameDataV1): GameData {
  const migratedAt = nowIso();
  const transactions: GameTransaction[] = [
    createTransaction("opening-balance", {
      coinsDelta: 30,
      xpDelta: 0,
      heartsDelta: 3,
      note: "旧版本初始成长资金",
    }, migratedAt),
  ];

  for (const [date, record] of Object.entries(value.records)) {
    for (const taskId of record.completed) {
      const reward = record.rewards[taskId];
      if (!reward) continue;
      transactions.push({
        id: `migrated-task:${date}:${taskId}`,
        at: `${date}T12:00:00.000Z`,
        date,
        kind: "task-reward",
        coinsDelta: reward.coins,
        xpDelta: reward.xp,
        heartsDelta: 0,
        note: `完成：${reward.title}`,
        taskId,
      });
    }
    if (record.fullBonus) {
      transactions.push({
        id: `migrated-bonus:${date}`,
        at: `${date}T12:01:00.000Z`,
        date,
        kind: "full-bonus",
        coinsDelta: FULL_BONUS_COINS,
        xpDelta: 0,
        heartsDelta: 1,
        note: "今日全勤奖励",
      });
    }
  }

  for (const itemId of value.pet.owned) {
    const info = permanentItemInfo[itemId];
    if (!info) continue;
    transactions.push({
      id: `migrated-owned-item:${itemId}`,
      at: migratedAt,
      date: dateFromIso(migratedAt),
      kind: "purchase",
      coinsDelta: -info.price,
      xpDelta: 0,
      heartsDelta: 0,
      note: `旧版本已拥有：${info.name}`,
      itemId,
      itemName: info.name,
    });
  }

  const totals = transactions.reduce(
    (sum, transaction) => ({
      coins: sum.coins + transaction.coinsDelta,
      xp: sum.xp + transaction.xpDelta,
      hearts: sum.hearts + transaction.heartsDelta,
    }),
    { coins: 0, xp: 0, hearts: 0 },
  );
  const adjustment = {
    coins: value.pet.coins - totals.coins,
    xp: value.pet.xp - totals.xp,
    hearts: value.pet.hearts - totals.hearts,
  };
  if (adjustment.coins || adjustment.xp || adjustment.hearts) {
    transactions.push({
      id: "migrated-v1-balance-adjustment",
      at: migratedAt,
      date: dateFromIso(migratedAt),
      kind: "legacy-balance-adjustment",
      coinsDelta: adjustment.coins,
      xpDelta: adjustment.xp,
      heartsDelta: adjustment.hearts,
      note: "旧版本未单独记录的消费或数值调整汇总",
    });
  }

  return {
    ...value,
    version: 2,
    tasks: value.tasks.map((task) => ({ ...task })),
    records: structuredClone(value.records),
    badges: [...value.badges],
    pet: { ...value.pet, owned: [...value.pet.owned] },
    settings: { ...value.settings },
    transactions,
    meta: {
      createdAt: migratedAt,
      updatedAt: migratedAt,
      lastMigratedAt: migratedAt,
      appVersion: APP_VERSION,
      taskSeedVersion: 1,
      taskTombstones: [],
    },
  };
}

function normalizeV2(value: GameData): GameData {
  if (!Array.isArray(value.transactions) || !isObject(value.meta)) {
    throw new DataSafetyError("数据版本标记为 v2，但缺少升级所需的流水或元数据。", JSON.stringify(value));
  }
  const updatedAt = nowIso();
  return {
    ...value,
    pet: { ...value.pet, owned: [...value.pet.owned] },
    tasks: value.tasks.map((task) => ({ ...task })),
    records: structuredClone(value.records),
    badges: [...value.badges],
    transactions: value.transactions.map((transaction) => ({ ...transaction })),
    settings: { ...value.settings },
    meta: {
      ...value.meta,
      appVersion: APP_VERSION,
      updatedAt,
      taskTombstones: Array.isArray(value.meta.taskTombstones) ? [...value.meta.taskTombstones] : [],
    },
  };
}

export function migrateGameData(value: unknown): { data: GameData; migratedFrom: number | null } {
  if (!validateCore(value)) {
    throw new DataSafetyError("数据结构不完整，已停止写入以保护原记录。", safeStringify(value));
  }
  const version = schemaVersionOf(value);
  if (version === 1) return { data: migrateV1(value as LegacyGameDataV1), migratedFrom: 1 };
  if (version === 2) return { data: normalizeV2(value as GameData), migratedFrom: null };
  if (version && version > CURRENT_SCHEMA_VERSION) {
    throw new DataSafetyError("这份数据来自更高版本，请先升级应用后再打开。", safeStringify(value));
  }
  throw new DataSafetyError("无法识别这份数据的版本，原数据没有被修改。", safeStringify(value));
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

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
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATA_STORE)) {
        database.createObjectStore(DATA_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade was blocked"));
  });
}

function snapshotRecord(payload: unknown, reason: string): SnapshotRecord {
  const createdAt = nowIso();
  return {
    id: `${createdAt}:${reason}`,
    createdAt,
    reason,
    schemaVersion: schemaVersionOf(payload),
    payload: structuredClone(payload),
  };
}

async function trimSnapshots(database: IDBDatabase) {
  const transaction = database.transaction(SNAPSHOT_STORE, "readwrite");
  const store = transaction.objectStore(SNAPSHOT_STORE);
  const snapshots = await requestResult(store.getAll() as IDBRequest<SnapshotRecord[]>);
  snapshots
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(MAX_SNAPSHOTS)
    .forEach((snapshot) => store.delete(snapshot.id));
  await transactionDone(transaction);
}

async function writeCurrentAndSnapshot(
  database: IDBDatabase,
  data: GameData,
  existing: unknown,
  reason: string,
) {
  const transaction = database.transaction([DATA_STORE, SNAPSHOT_STORE], "readwrite");
  if (existing !== undefined) {
    transaction.objectStore(SNAPSHOT_STORE).put(snapshotRecord(existing, reason));
  }
  transaction.objectStore(DATA_STORE).put({ id: CURRENT_DATA_ID, payload: data });
  await transactionDone(transaction);
  await trimSnapshots(database);
}

async function recoverFromSnapshots(database: IDBDatabase) {
  const transaction = database.transaction(SNAPSHOT_STORE, "readonly");
  const snapshots = await requestResult(
    transaction.objectStore(SNAPSHOT_STORE).getAll() as IDBRequest<SnapshotRecord[]>,
  );
  await transactionDone(transaction);
  for (const snapshot of snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    try {
      return migrateGameData(snapshot.payload).data;
    } catch {
      // Try the next older snapshot.
    }
  }
  return null;
}

function readLegacyLocalStorage() {
  if (typeof localStorage === "undefined") return null;
  for (const key of [PRIMARY_STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
    const raw = localStorage.getItem(key);
    if (raw) return { key, raw };
  }
  return null;
}

export async function loadGameData(defaultTasks: Task[]): Promise<LoadResult> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    const transaction = database.transaction(DATA_STORE, "readonly");
    const current = await requestResult(
      transaction.objectStore(DATA_STORE).get(CURRENT_DATA_ID) as IDBRequest<{ id: string; payload: unknown } | undefined>,
    );
    await transactionDone(transaction);

    if (current) {
      try {
        const migrated = migrateGameData(current.payload);
        if (migrated.migratedFrom !== null) {
          await writeCurrentAndSnapshot(database, migrated.data, current.payload, `before-schema-v${CURRENT_SCHEMA_VERSION}`);
        }
        return {
          data: migrated.data,
          migratedFrom: migrated.migratedFrom,
          recoveredFromSnapshot: false,
          usedLegacyLocalStorage: false,
        };
      } catch (error) {
        const recovered = await recoverFromSnapshots(database);
        if (recovered) {
          await writeCurrentAndSnapshot(database, recovered, current.payload, "corrupt-primary-recovery");
          return {
            data: recovered,
            migratedFrom: null,
            recoveredFromSnapshot: true,
            usedLegacyLocalStorage: false,
          };
        }
        throw error;
      }
    }

    const legacy = readLegacyLocalStorage();
    if (legacy) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(legacy.raw);
      } catch {
        throw new DataSafetyError("旧版本记录无法解析，已停止写入，请先导出原始数据。", legacy.raw);
      }
      const migrated = migrateGameData(parsed);
      await writeCurrentAndSnapshot(database, migrated.data, parsed, `legacy-${legacy.key}-migration`);
      return {
        data: migrated.data,
        migratedFrom: migrated.migratedFrom,
        recoveredFromSnapshot: false,
        usedLegacyLocalStorage: true,
      };
    }

    const initial = createInitialGameData(defaultTasks);
    await writeCurrentAndSnapshot(database, initial, undefined, "initial-create");
    return {
      data: initial,
      migratedFrom: null,
      recoveredFromSnapshot: false,
      usedLegacyLocalStorage: false,
    };
  } catch (error) {
    if (error instanceof DataSafetyError) throw error;
    const legacy = readLegacyLocalStorage();
    if (legacy) {
      try {
        const migrated = migrateGameData(JSON.parse(legacy.raw));
        localStorage.setItem(PRIMARY_STORAGE_KEY, JSON.stringify(migrated.data));
        return {
          data: migrated.data,
          migratedFrom: migrated.migratedFrom,
          recoveredFromSnapshot: false,
          usedLegacyLocalStorage: true,
        };
      } catch (fallbackError) {
        if (fallbackError instanceof DataSafetyError) throw fallbackError;
        throw new DataSafetyError("本地数据库暂时不可用，且旧记录无法安全读取。", legacy.raw);
      }
    }
    throw new DataSafetyError("本地数据库暂时不可用。为避免覆盖记录，应用已进入保护模式。");
  } finally {
    database?.close();
  }
}

let saveQueue: Promise<void> = Promise.resolve();

async function saveToDatabase(data: GameData) {
  const stamped: GameData = {
    ...data,
    meta: { ...data.meta, updatedAt: nowIso(), appVersion: APP_VERSION },
  };
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DATA_STORE, "readwrite");
    transaction.objectStore(DATA_STORE).put({ id: CURRENT_DATA_ID, payload: stamped });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export function queueGameDataSave(data: GameData) {
  const snapshot = structuredClone(data);
  saveQueue = saveQueue.catch(() => undefined).then(() => saveToDatabase(snapshot));
  return saveQueue;
}

export async function snapshotAndReplaceGameData(data: GameData, reason: string) {
  await saveQueue.catch(() => undefined);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DATA_STORE, "readonly");
    const current = await requestResult(
      transaction.objectStore(DATA_STORE).get(CURRENT_DATA_ID) as IDBRequest<{ id: string; payload: unknown } | undefined>,
    );
    await transactionDone(transaction);
    await writeCurrentAndSnapshot(database, data, current?.payload, reason);
  } finally {
    database.close();
  }
}

export async function createSafetySnapshot(data: GameData, reason: string) {
  await saveQueue.catch(() => undefined);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SNAPSHOT_STORE, "readwrite");
    transaction.objectStore(SNAPSHOT_STORE).put(snapshotRecord(data, reason));
    await transactionDone(transaction);
    await trimSnapshots(database);
  } finally {
    database.close();
  }
}

export async function prepareImportedGameData(value: unknown) {
  return migrateGameData(value).data;
}
