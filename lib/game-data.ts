import { avatarCatalog, defaultRealRewards, freeAvatarIds, virtualShopItems, type AvatarId, type RealRewardCatalogItem, type RealRewardCategory } from "./game-catalog.ts";

export type PetType = "dog" | "cat" | "snake" | "dino";
export type TaskCategory = "reading" | "writing" | "sport" | "homework" | "tidy" | "help" | "sleep" | "custom";

export type Task = {
  id: string;
  title: string;
  icon: string;
  category: TaskCategory;
  coins: number;
  xp: number;
  active: boolean;
  proofPrompt: string;
  requiresProof: boolean;
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

export type TaskSubmission = {
  id: string;
  taskId: string;
  taskTitle: string;
  date: string;
  proofNote: string;
  submittedAt: string;
  activeTaskIds: string[];
  status: "pending" | "approved" | "rejected";
  reviewedAt?: string;
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
  avatarId: AvatarId;
  ownedAvatars: AvatarId[];
};

export type TransactionKind =
  | "opening-balance"
  | "task-reward"
  | "full-bonus"
  | "task-undo"
  | "bonus-reversal"
  | "purchase"
  | "care-penalty"
  | "avatar-unlock"
  | "real-reward-reserve"
  | "real-reward-fulfilled"
  | "real-reward-refund"
  | "legacy-balance-adjustment";

export type GameTransaction = {
  id: string;
  at: string;
  date: string;
  /**
   * Business date affected by a parent review. This differs from `date` when
   * a parent approves or revokes an older check-in on a later calendar day.
   */
  recordDate?: string;
  kind: TransactionKind;
  coinsDelta: number;
  xpDelta: number;
  heartsDelta: number;
  note: string;
  taskId?: string;
  itemId?: string;
  itemName?: string;
  avatarId?: AvatarId;
  rewardId?: string;
  claimId?: string;
};

export type RealReward = RealRewardCatalogItem;

export type RewardClaim = {
  id: string;
  rewardId: string;
  rewardName: string;
  rewardDescription: string;
  rewardImage: string;
  category: RealRewardCategory;
  price: number;
  requestedAt: string;
  status: "pending" | "fulfilled" | "refunded";
  resolvedAt?: string;
};

export type GameData = {
  version: 4;
  pet: PetState;
  tasks: Task[];
  records: Record<string, DailyRecord>;
  badges: string[];
  transactions: GameTransaction[];
  submissions: TaskSubmission[];
  realRewards: RealReward[];
  rewardClaims: RewardClaim[];
  care: {
    startedAtDate: string;
    fedDates: string[];
    penaltyDates: string[];
  };
  settings: {
    sound: boolean;
    animations: boolean;
    parentPin: string | null;
    carePenaltyEnabled: boolean;
    missedFeedCoins: number;
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

type GameMeta = GameData["meta"];
type GameSettingsV2 = Pick<GameData["settings"], "sound" | "animations">;
type GameSettingsV3 = GameData["settings"];
type LegacyPetStateV3 = Omit<PetState, "avatarId" | "ownedAvatars">;
type LegacyTaskV2 = Omit<Task, "proofPrompt" | "requiresProof"> & {
  proofPrompt?: string;
  requiresProof?: boolean;
};
type LegacyTaskV3 = Omit<Task, "requiresProof"> & { requiresProof?: boolean };
type LegacyGameDataV2 = {
  version: 2;
  pet: LegacyPetStateV3;
  tasks: LegacyTaskV2[];
  records: Record<string, DailyRecord>;
  badges: string[];
  transactions: GameTransaction[];
  settings: GameSettingsV2;
  meta: GameMeta;
};

type LegacyGameDataV1 = Omit<LegacyGameDataV2, "version" | "transactions" | "meta"> & {
  version: 1;
};

type LegacyGameDataV3 = {
  version: 3;
  pet: LegacyPetStateV3;
  tasks: LegacyTaskV3[];
  records: Record<string, DailyRecord>;
  badges: string[];
  transactions: GameTransaction[];
  submissions: TaskSubmission[];
  care: GameData["care"];
  settings: GameSettingsV3;
  meta: GameMeta;
};

export const APP_VERSION = "0.5.3";
export const CURRENT_SCHEMA_VERSION = 4;
export const FULL_BONUS_COINS = 20;
export const PRIMARY_STORAGE_KEY = "summer-pet-data";
export const LEGACY_STORAGE_KEYS = ["summer-pet-v1"];

const DB_NAME = "summer-pet-db";
const DB_VERSION = 1;
const DATA_STORE = "data";
const SNAPSHOT_STORE = "snapshots";
const CURRENT_DATA_ID = "current";
const MAX_SNAPSHOTS = 12;

const permanentItemInfo = Object.fromEntries(
  virtualShopItems
    .filter((item) => item.permanent)
    .map((item) => [item.id, { name: item.name, price: item.price }]),
) as Record<string, { name: string; price: number }>;

const proofPromptByTaskId: Record<string, string> = {
  read: "写下今天读的书名和页码",
  write: "写下练习内容，把练字本交给家长",
  sport: "写下运动项目和大约时长",
  homework: "写下完成了哪一页或哪几题",
  tidy: "写下整理了什么，请家长现场查看",
  help: "写下帮家里做了什么",
  sleep: "睡前请家长当面验收",
};

function proofPromptForTask(task: LegacyTaskV2 | LegacyTaskV3 | Task) {
  return typeof task.proofPrompt === "string" && task.proofPrompt.trim()
    ? task.proofPrompt
    : proofPromptByTaskId[task.id] ?? "写下完成情况，交给家长检查";
}

function requiresProofForTask(task: LegacyTaskV2 | LegacyTaskV3 | Task) {
  if (typeof task.requiresProof === "boolean") return task.requiresProof;
  return task.category === "reading" ||
    task.category === "writing" ||
    task.category === "homework" ||
    task.category === "custom";
}

function avatarIdForPetType(type: PetType): AvatarId {
  return `pet-${type}`;
}

function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === "string" && avatarCatalog.some((avatar) => avatar.id === value);
}

function cloneDefaultRealRewards(): RealReward[] {
  return defaultRealRewards.map((reward) => ({ ...reward }));
}

export class DataSafetyError extends Error {
  rawData?: string;
  reason: "invalid-data" | "future-schema";

  constructor(
    message: string,
    rawData?: string,
    reason: "invalid-data" | "future-schema" = "invalid-data",
  ) {
    super(message);
    this.name = "DataSafetyError";
    this.rawData = rawData;
    this.reason = reason;
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

function localDateFromDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function shiftDateKey(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

let transactionSequence = 0;

function uniqueIdPart(at: string) {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${at}-${transactionSequence += 1}`;
}

export function createTransaction(
  kind: TransactionKind,
  values: Omit<GameTransaction, "id" | "at" | "date" | "kind">,
  at = nowIso(),
): GameTransaction {
  return {
    id: `${kind}:${uniqueIdPart(at)}`,
    at,
    date: dateFromIso(at),
    kind,
    ...values,
  };
}

export function createInitialGameData(tasks: Task[]): GameData {
  const createdAt = nowIso();
  return {
    version: 4,
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
      avatarId: "pet-dog",
      ownedAvatars: [...freeAvatarIds],
    },
    tasks: tasks.map((task) => ({
      ...task,
      proofPrompt: proofPromptForTask(task),
      requiresProof: requiresProofForTask(task),
    })),
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
    submissions: [],
    realRewards: cloneDefaultRealRewards(),
    rewardClaims: [],
    care: {
      startedAtDate: localDateFromDate(new Date()),
      fedDates: [],
      penaltyDates: [],
    },
    settings: {
      sound: true,
      animations: true,
      parentPin: null,
      carePenaltyEnabled: true,
      missedFeedCoins: 3,
    },
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

function migrateV1(value: LegacyGameDataV1): LegacyGameDataV2 {
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

function migrateV2(value: LegacyGameDataV2): LegacyGameDataV3 {
  if (!Array.isArray(value.transactions) || !isObject(value.meta)) {
    throw new DataSafetyError("数据版本标记为 v2，但缺少升级所需的流水或元数据。", JSON.stringify(value));
  }
  const migratedAt = nowIso();
  const submissions: TaskSubmission[] = [];
  for (const [date, record] of Object.entries(value.records)) {
    for (const taskId of record.completed) {
      const reward = record.rewards[taskId];
      submissions.push({
        id: `legacy-approved:${date}:${taskId}`,
        taskId,
        taskTitle: reward?.title ?? taskId,
        date,
        proofNote: "旧版本已完成记录",
        submittedAt: `${date}T12:00:00.000Z`,
        activeTaskIds: [...record.completed],
        status: "approved",
        reviewedAt: `${date}T12:00:00.000Z`,
      });
    }
  }
  return {
    ...value,
    version: 3,
    pet: { ...value.pet, owned: [...value.pet.owned] },
    tasks: value.tasks.map((task) => ({
      ...task,
      proofPrompt: proofPromptForTask(task),
    })),
    records: structuredClone(value.records),
    badges: [...value.badges],
    transactions: value.transactions.map((transaction) => ({ ...transaction })),
    submissions,
    care: {
      startedAtDate: localDateFromDate(new Date()),
      fedDates: [],
      penaltyDates: [],
    },
    settings: {
      ...value.settings,
      parentPin: null,
      carePenaltyEnabled: true,
      missedFeedCoins: 3,
    },
    meta: {
      ...value.meta,
      appVersion: APP_VERSION,
      updatedAt: migratedAt,
      lastMigratedAt: migratedAt,
      taskTombstones: Array.isArray(value.meta.taskTombstones) ? [...value.meta.taskTombstones] : [],
    },
  };
}

function migrateV3(value: LegacyGameDataV3): GameData {
  if (!Array.isArray(value.transactions) || !Array.isArray(value.submissions) || !isObject(value.meta) || !isObject(value.care)) {
    throw new DataSafetyError("数据版本标记为 v3，但缺少验收、照料或迁移元数据。", JSON.stringify(value));
  }
  const migratedAt = nowIso();
  const avatarId = avatarIdForPetType(
    value.pet.type === "cat" || value.pet.type === "snake" || value.pet.type === "dino"
      ? value.pet.type
      : "dog",
  );
  return {
    ...value,
    version: 4,
    pet: {
      ...value.pet,
      owned: [...value.pet.owned],
      avatarId,
      ownedAvatars: Array.from(new Set([...freeAvatarIds, avatarId])),
    },
    tasks: value.tasks.map((task) => ({
      ...task,
      proofPrompt: proofPromptForTask(task),
      requiresProof: requiresProofForTask(task),
    })),
    records: structuredClone(value.records),
    badges: [...value.badges],
    transactions: value.transactions.map((transaction) => ({ ...transaction })),
    submissions: value.submissions.map((submission) => ({
      ...submission,
      activeTaskIds: Array.isArray(submission.activeTaskIds)
        ? [...submission.activeTaskIds]
        : value.tasks.filter((task) => task.active).map((task) => task.id),
    })),
    realRewards: cloneDefaultRealRewards(),
    rewardClaims: [],
    care: {
      startedAtDate: typeof value.care.startedAtDate === "string" ? value.care.startedAtDate : localDateFromDate(new Date()),
      fedDates: Array.isArray(value.care.fedDates) ? [...value.care.fedDates] : [],
      penaltyDates: Array.isArray(value.care.penaltyDates) ? [...value.care.penaltyDates] : [],
    },
    settings: {
      sound: Boolean(value.settings.sound),
      animations: Boolean(value.settings.animations),
      parentPin: typeof value.settings.parentPin === "string" ? value.settings.parentPin : null,
      carePenaltyEnabled: value.settings.carePenaltyEnabled !== false,
      missedFeedCoins: Number.isFinite(value.settings.missedFeedCoins)
        ? Math.max(0, Math.min(20, Math.round(value.settings.missedFeedCoins)))
        : 3,
    },
    meta: {
      ...value.meta,
      appVersion: APP_VERSION,
      updatedAt: migratedAt,
      lastMigratedAt: migratedAt,
      taskTombstones: Array.isArray(value.meta.taskTombstones) ? [...value.meta.taskTombstones] : [],
    },
  };
}

function normalizeV4(value: GameData): GameData {
  if (
    !Array.isArray(value.transactions) ||
    !Array.isArray(value.submissions) ||
    !Array.isArray(value.realRewards) ||
    !Array.isArray(value.rewardClaims) ||
    !isObject(value.meta) ||
    !isObject(value.care) ||
    !isAvatarId(value.pet.avatarId) ||
    !Array.isArray(value.pet.ownedAvatars)
  ) {
    throw new DataSafetyError("数据版本标记为 v4，但缺少角色、奖励、验收或迁移元数据。", JSON.stringify(value));
  }
  const updatedAt = nowIso();
  const ownedAvatars = Array.from(new Set([
    ...freeAvatarIds,
    ...value.pet.ownedAvatars.filter(isAvatarId),
    value.pet.avatarId,
  ]));
  return {
    ...value,
    pet: {
      ...value.pet,
      owned: [...value.pet.owned],
      ownedAvatars,
    },
    tasks: value.tasks.map((task) => ({
      ...task,
      proofPrompt: proofPromptForTask(task),
      requiresProof: requiresProofForTask(task),
    })),
    records: structuredClone(value.records),
    badges: [...value.badges],
    transactions: value.transactions.map((transaction) => ({ ...transaction })),
    submissions: value.submissions.map((submission) => ({
      ...submission,
      activeTaskIds: Array.isArray(submission.activeTaskIds)
        ? [...submission.activeTaskIds]
        : value.tasks.filter((task) => task.active).map((task) => task.id),
    })),
    realRewards: value.realRewards.map((reward) => ({ ...reward })),
    rewardClaims: value.rewardClaims.map((claim) => ({ ...claim })),
    care: {
      startedAtDate: typeof value.care.startedAtDate === "string" ? value.care.startedAtDate : localDateFromDate(new Date()),
      fedDates: Array.isArray(value.care.fedDates) ? [...value.care.fedDates] : [],
      penaltyDates: Array.isArray(value.care.penaltyDates) ? [...value.care.penaltyDates] : [],
    },
    settings: {
      sound: Boolean(value.settings.sound),
      animations: Boolean(value.settings.animations),
      parentPin: typeof value.settings.parentPin === "string" ? value.settings.parentPin : null,
      carePenaltyEnabled: value.settings.carePenaltyEnabled !== false,
      missedFeedCoins: Number.isFinite(value.settings.missedFeedCoins)
        ? Math.max(0, Math.min(20, Math.round(value.settings.missedFeedCoins)))
        : 3,
    },
    meta: {
      ...value.meta,
      appVersion: APP_VERSION,
      updatedAt,
      taskTombstones: Array.isArray(value.meta.taskTombstones) ? [...value.meta.taskTombstones] : [],
    },
  };
}

export function migrateGameData(value: unknown): { data: GameData; migratedFrom: number | null } {
  const version = schemaVersionOf(value);
  if (version && version > CURRENT_SCHEMA_VERSION) {
    throw new DataSafetyError(
      "这份数据来自更高版本，请先升级应用后再打开。",
      safeStringify(value),
      "future-schema",
    );
  }
  if (!validateCore(value)) {
    throw new DataSafetyError("数据结构不完整，已停止写入以保护原记录。", safeStringify(value));
  }
  if (version === 1) return { data: migrateV3(migrateV2(migrateV1(value as LegacyGameDataV1))), migratedFrom: 1 };
  if (version === 2) return { data: migrateV3(migrateV2(value as LegacyGameDataV2)), migratedFrom: 2 };
  if (version === 3) return { data: migrateV3(value as LegacyGameDataV3), migratedFrom: 3 };
  if (version === 4) return { data: normalizeV4(value as GameData), migratedFrom: null };
  throw new DataSafetyError("无法识别这份数据的版本，原数据没有被修改。", safeStringify(value));
}

export function applyMissedFeedPenalties(data: GameData, today: string) {
  if (!data.settings.carePenaltyEnabled || data.care.startedAtDate >= today) {
    return { data, appliedDates: [] as string[] };
  }

  const fedDates = new Set(data.care.fedDates);
  const penaltyDates = new Set(data.care.penaltyDates);
  const appliedDates: string[] = [];
  const transactions = [...data.transactions];
  let coins = data.pet.coins;
  let hunger = data.pet.hunger;
  let happiness = data.pet.happiness;
  const earliestDate = shiftDateKey(today, -120);
  let cursor = data.care.startedAtDate < earliestDate ? earliestDate : data.care.startedAtDate;
  let inspected = 0;

  while (cursor < today && inspected < 120) {
    if (!fedDates.has(cursor) && !penaltyDates.has(cursor)) {
      const coinLoss = Math.min(coins, data.settings.missedFeedCoins);
      coins -= coinLoss;
      hunger = Math.max(0, hunger - 15);
      happiness = Math.max(0, happiness - 8);
      penaltyDates.add(cursor);
      appliedDates.push(cursor);
      transactions.push({
        id: `care-penalty:${cursor}`,
        at: `${cursor}T23:59:00.000Z`,
        date: cursor,
        kind: "care-penalty",
        coinsDelta: -coinLoss,
        xpDelta: 0,
        heartsDelta: 0,
        note: coinLoss > 0 ? `漏喂惩罚：扣除 ${coinLoss} 枚金币` : "漏喂记录：金币已为 0",
      });
    }
    cursor = nextDateKey(cursor);
    inspected += 1;
  }

  if (appliedDates.length === 0) return { data, appliedDates };
  return {
    data: {
      ...data,
      pet: { ...data.pet, coins, hunger, happiness },
      transactions,
      care: { ...data.care, penaltyDates: [...penaltyDates] },
    },
    appliedDates,
  };
}

export function submitTaskForApproval(
  data: GameData,
  taskId: string,
  date: string,
  proofNote: string,
  submittedAt = nowIso(),
) {
  const task = data.tasks.find((item) => item.id === taskId);
  const normalizedProof = proofNote.trim();
  const duplicate = data.submissions.some((submission) =>
    submission.date === date && submission.taskId === taskId && submission.status === "pending"
  );
  if (
    !task ||
    duplicate ||
    data.records[date]?.completed.includes(taskId) ||
    (task.requiresProof && normalizedProof.length === 0)
  ) {
    return { data, submitted: false };
  }
  const submission: TaskSubmission = {
    id: `submission:${date}:${taskId}:${uniqueIdPart(submittedAt)}`,
    taskId,
    taskTitle: task.title,
    date,
    proofNote: normalizedProof,
    submittedAt,
    activeTaskIds: data.tasks.filter((item) => item.active).map((item) => item.id),
    status: "pending",
  };
  return { data: { ...data, submissions: [...data.submissions, submission] }, submitted: true };
}

export function approveTaskSubmissionsBatch(
  data: GameData,
  date: string,
  selectedSubmissionIds: readonly string[],
  reviewedAt = nowIso(),
  rejectUnselected = true,
) {
  const selectedIds = new Set(selectedSubmissionIds);
  const pendingForDate = data.submissions.filter((submission) =>
    submission.date === date && submission.status === "pending"
  );
  const selected = pendingForDate.filter((submission) => selectedIds.has(submission.id));
  const selectedTasks = selected.map((submission) =>
    data.tasks.find((task) => task.id === submission.taskId)
  );
  const record = data.records[date] ?? {
    completed: [],
    rewards: {},
    fullBonus: false,
    fullComplete: false,
  };
  const selectedTaskIds = selected.map((submission) => submission.taskId);
  const invalidSelection =
    selectedIds.size !== selectedSubmissionIds.length ||
    selected.length !== selectedIds.size ||
    selectedTasks.some((task) => !task) ||
    new Set(selectedTaskIds).size !== selectedTaskIds.length ||
    selectedTaskIds.some((taskId) => record.completed.includes(taskId));
  if (invalidSelection) {
    return {
      data,
      processed: 0,
      approvedSubmissionIds: [] as string[],
      rejectedSubmissionIds: [] as string[],
      grantedFullBonus: false,
    };
  }

  const rejectedSubmissionIds = rejectUnselected
    ? pendingForDate.filter((submission) => !selectedIds.has(submission.id)).map((submission) => submission.id)
    : [];
  if (selected.length === 0 && rejectedSubmissionIds.length === 0) {
    return {
      data,
      processed: 0,
      approvedSubmissionIds: [] as string[],
      rejectedSubmissionIds,
      grantedFullBonus: false,
    };
  }

  const tasks = selectedTasks as Task[];
  const completed = [...record.completed, ...tasks.map((task) => task.id)];
  const rewards = { ...record.rewards };
  for (const task of tasks) {
    rewards[task.id] = {
      title: task.title,
      category: task.category,
      coins: task.coins,
      xp: task.xp,
    };
  }
  const activeTaskIds = Array.from(new Set(
    data.submissions
      .filter((submission) =>
        submission.date === date &&
        (submission.status === "approved" || selectedIds.has(submission.id))
      )
      .flatMap((submission) => submission.activeTaskIds),
  ));
  const isFull = activeTaskIds.length > 0 &&
    activeTaskIds.every((taskId) => completed.includes(taskId));
  const grantBonus = selected.length > 0 && isFull && !record.fullBonus;
  const coinsGranted = tasks.reduce((sum, task) => sum + task.coins, 0);
  const xpGranted = tasks.reduce((sum, task) => sum + task.xp, 0);
  const next: GameData = {
    ...data,
    pet: {
      ...data.pet,
      coins: data.pet.coins + coinsGranted + (grantBonus ? FULL_BONUS_COINS : 0),
      xp: data.pet.xp + xpGranted,
      hearts: data.pet.hearts + (grantBonus ? 1 : 0),
    },
    records: selected.length > 0
      ? {
        ...data.records,
        [date]: {
          completed,
          rewards,
          fullBonus: record.fullBonus || grantBonus,
          fullComplete: isFull,
        },
      }
      : data.records,
    submissions: data.submissions.map((item) =>
      selectedIds.has(item.id) && item.date === date && item.status === "pending"
        ? { ...item, status: "approved" as const, reviewedAt }
        : rejectedSubmissionIds.includes(item.id)
          ? { ...item, status: "rejected" as const, reviewedAt }
          : item
    ),
    transactions: [
      ...data.transactions,
      ...tasks.map((task) =>
        createTransaction("task-reward", {
          coinsDelta: task.coins,
          xpDelta: task.xp,
          heartsDelta: 0,
          note: `完成：${task.title}`,
          taskId: task.id,
          recordDate: date,
        }, reviewedAt)
      ),
      ...(grantBonus ? [
        createTransaction("full-bonus", {
          coinsDelta: FULL_BONUS_COINS,
          xpDelta: 0,
          heartsDelta: 1,
          note: "今日全勤奖励",
          recordDate: date,
        }, reviewedAt),
      ] : []),
    ],
  };
  return {
    data: next,
    processed: selected.length + rejectedSubmissionIds.length,
    approvedSubmissionIds: selected.map((submission) => submission.id),
    rejectedSubmissionIds,
    grantedFullBonus: grantBonus,
  };
}

export function approveTaskSubmission(
  data: GameData,
  submissionId: string,
  reviewedAt = nowIso(),
) {
  const submission = data.submissions.find((item) =>
    item.id === submissionId && item.status === "pending"
  );
  if (!submission) return { data, approved: false };
  const result = approveTaskSubmissionsBatch(
    data,
    submission.date,
    [submissionId],
    reviewedAt,
    false,
  );
  return {
    data: result.data,
    approved: result.approvedSubmissionIds.includes(submissionId),
  };
}

export function revokeTaskApproval(
  data: GameData,
  taskId: string,
  date: string,
  reviewedAt = nowIso(),
) {
  const record = data.records[date];
  const reward = record?.rewards[taskId];
  if (!record || !reward || !record.completed.includes(taskId)) {
    return { data, revoked: false };
  }

  const removeBonus = record.fullBonus;
  const taskCoinsReversed = Math.min(data.pet.coins, reward.coins);
  const coinsAfterTask = data.pet.coins - taskCoinsReversed;
  const bonusCoinsReversed = removeBonus ? Math.min(coinsAfterTask, FULL_BONUS_COINS) : 0;
  const xpReversed = Math.min(data.pet.xp, reward.xp);
  const heartsReversed = removeBonus ? Math.min(data.pet.hearts, 1) : 0;
  const completed = record.completed.filter((id) => id !== taskId);
  const rewards = { ...record.rewards };
  delete rewards[taskId];

  const next: GameData = {
    ...data,
    pet: {
      ...data.pet,
      coins: data.pet.coins - taskCoinsReversed - bonusCoinsReversed,
      xp: data.pet.xp - xpReversed,
      hearts: data.pet.hearts - heartsReversed,
    },
    records: {
      ...data.records,
      [date]: { completed, rewards, fullBonus: false, fullComplete: false },
    },
    submissions: data.submissions.map((submission) =>
      submission.date === date && submission.taskId === taskId && submission.status === "approved"
        ? { ...submission, status: "rejected" as const, reviewedAt }
        : submission
    ),
    transactions: [
      ...data.transactions,
      createTransaction("task-undo", {
        coinsDelta: -taskCoinsReversed,
        xpDelta: -xpReversed,
        heartsDelta: 0,
        note: taskCoinsReversed < reward.coins
          ? `取消打卡：${reward.title}（可用金币不足，实际收回 ${taskCoinsReversed} 枚）`
          : `取消打卡：${reward.title}`,
        taskId,
        recordDate: date,
      }, reviewedAt),
      ...(removeBonus ? [
        createTransaction("bonus-reversal", {
          coinsDelta: -bonusCoinsReversed,
          xpDelta: 0,
          heartsDelta: -heartsReversed,
          note: bonusCoinsReversed < FULL_BONUS_COINS
            ? `取消今日全勤奖励（实际收回 ${bonusCoinsReversed} 枚金币）`
            : "取消今日全勤奖励",
          recordDate: date,
        }, reviewedAt),
      ] : []),
    ],
  };
  return { data: next, revoked: true };
}

export function unlockAvatar(
  data: GameData,
  avatarId: AvatarId,
  unlockedAt = nowIso(),
) {
  const avatar = avatarCatalog.find((item) => item.id === avatarId);
  if (
    !avatar ||
    data.pet.ownedAvatars.includes(avatarId) ||
    avatar.price < 0 ||
    data.pet.coins < avatar.price
  ) {
    return { data, unlocked: false };
  }
  return {
    data: {
      ...data,
      pet: {
        ...data.pet,
        coins: data.pet.coins - avatar.price,
        ownedAvatars: [...data.pet.ownedAvatars, avatarId],
      },
      transactions: [
        ...data.transactions,
        createTransaction("avatar-unlock", {
          coinsDelta: -avatar.price,
          xpDelta: 0,
          heartsDelta: 0,
          note: `解锁角色：${avatar.name}`,
          itemId: avatar.id,
          itemName: avatar.name,
          avatarId,
        }, unlockedAt),
      ],
    },
    unlocked: true,
  };
}

export function switchAvatar(data: GameData, avatarId: AvatarId) {
  if (
    !avatarCatalog.some((avatar) => avatar.id === avatarId) ||
    !data.pet.ownedAvatars.includes(avatarId) ||
    data.pet.avatarId === avatarId
  ) {
    return { data, switched: false };
  }
  return {
    data: {
      ...data,
      pet: { ...data.pet, avatarId },
    },
    switched: true,
  };
}

export function requestRealReward(
  data: GameData,
  rewardId: string,
  requestedAt = nowIso(),
) {
  const reward = data.realRewards.find((item) => item.id === rewardId);
  const alreadyPending = data.rewardClaims.some((claim) =>
    claim.rewardId === rewardId && claim.status === "pending"
  );
  if (
    !reward ||
    !reward.active ||
    alreadyPending ||
    !Number.isInteger(reward.price) ||
    reward.price < 1 ||
    reward.price > 9999 ||
    data.pet.coins < reward.price
  ) {
    return { data, requested: false, claimId: null as string | null };
  }
  const claimId = `reward-claim:${reward.id}:${uniqueIdPart(requestedAt)}`;
  const claim: RewardClaim = {
    id: claimId,
    rewardId: reward.id,
    rewardName: reward.name,
    rewardDescription: reward.description,
    rewardImage: reward.image,
    category: reward.category,
    price: reward.price,
    requestedAt,
    status: "pending",
  };
  return {
    data: {
      ...data,
      pet: { ...data.pet, coins: data.pet.coins - reward.price },
      rewardClaims: [...data.rewardClaims, claim],
      transactions: [
        ...data.transactions,
        createTransaction("real-reward-reserve", {
          coinsDelta: -reward.price,
          xpDelta: 0,
          heartsDelta: 0,
          note: `申请现实奖励：${reward.name}`,
          itemId: reward.id,
          itemName: reward.name,
          rewardId: reward.id,
          claimId,
        }, requestedAt),
      ],
    },
    requested: true,
    claimId,
  };
}

export function resolveRewardClaim(
  data: GameData,
  claimId: string,
  resolution: "fulfilled" | "refunded",
  resolvedAt = nowIso(),
) {
  if (resolution !== "fulfilled" && resolution !== "refunded") {
    return { data, resolved: false };
  }
  const claim = data.rewardClaims.find((item) =>
    item.id === claimId && item.status === "pending"
  );
  if (!claim) return { data, resolved: false };
  const refunded = resolution === "refunded";
  const kind: TransactionKind = refunded
    ? "real-reward-refund"
    : "real-reward-fulfilled";
  const note = refunded
    ? `现实奖励退款：${claim.rewardName}`
    : `现实奖励已兑现：${claim.rewardName}`;
  return {
    data: {
      ...data,
      pet: {
        ...data.pet,
        coins: data.pet.coins + (refunded ? claim.price : 0),
      },
      rewardClaims: data.rewardClaims.map((item) =>
        item.id === claimId
          ? { ...item, status: resolution, resolvedAt }
          : item
      ),
      transactions: [
        ...data.transactions,
        createTransaction(kind, {
          coinsDelta: refunded ? claim.price : 0,
          xpDelta: 0,
          heartsDelta: 0,
          note,
          itemId: claim.rewardId,
          itemName: claim.rewardName,
          rewardId: claim.rewardId,
          claimId,
        }, resolvedAt),
      ],
    },
    resolved: true,
  };
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
        if (error instanceof DataSafetyError && error.reason === "future-schema") {
          throw error;
        }
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
