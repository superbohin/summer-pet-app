import {
  migrateGameData,
  type DailyRecord,
  type GameData,
  type GameTransaction,
  type RewardClaim,
  type TaskSubmission,
} from "./game-data.ts";
import { avatarCatalog, freeAvatarIds, virtualShopItems } from "./game-catalog.ts";

export type SyncedGameSnapshot = {
  eventId: string;
  role: "child" | "parent";
  createdAt: string;
  data: GameData;
};

function uniqueStrings(...groups: ReadonlyArray<readonly string[]>) {
  return Array.from(new Set(groups.flat()));
}

function statusRank(status: TaskSubmission["status"] | RewardClaim["status"]) {
  return status === "pending" ? 0 : 1;
}

function mergeById<T extends { id: string }>(
  local: readonly T[],
  incoming: readonly T[],
  preferIncoming: (localItem: T, incomingItem: T) => boolean,
) {
  const merged = new Map(local.map((item) => [item.id, structuredClone(item)]));
  for (const item of incoming) {
    const existing = merged.get(item.id);
    if (!existing || preferIncoming(existing, item)) {
      merged.set(item.id, structuredClone(item));
    }
  }
  return [...merged.values()];
}

function mergeSubmissions(
  local: readonly TaskSubmission[],
  incoming: readonly TaskSubmission[],
  incomingRole: SyncedGameSnapshot["role"],
) {
  return mergeById(local, incoming, (existing, next) => {
    if (incomingRole === "parent") {
      return existing.status === "pending" || next.status !== "pending";
    }
    return statusRank(next.status) > statusRank(existing.status);
  }).sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

function mergeClaims(
  local: readonly RewardClaim[],
  incoming: readonly RewardClaim[],
  incomingRole: SyncedGameSnapshot["role"],
) {
  return mergeById(local, incoming, (existing, next) => {
    if (incomingRole === "parent") {
      return existing.status === "pending" || next.status !== "pending";
    }
    return statusRank(next.status) > statusRank(existing.status);
  }).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}

function balanceFromLedger(transactions: GameData["transactions"]) {
  return transactions.reduce(
    (total, entry) => ({
      coins: total.coins + entry.coinsDelta,
      xp: total.xp + entry.xpDelta,
      hearts: total.hearts + entry.heartsDelta,
    }),
    { coins: 0, xp: 0, hearts: 0 },
  );
}

function childSubmissions(local: GameData, incoming: GameData) {
  const existingIds = new Set(local.submissions.map((submission) => submission.id));
  const additions = incoming.submissions.flatMap((submission) => {
    if (existingIds.has(submission.id) || submission.status !== "pending") return [];
    const task = local.tasks.find((candidate) => candidate.id === submission.taskId);
    if (
      !task ||
      submission.taskTitle !== task.title ||
      (task.requiresProof && submission.proofNote.trim().length === 0) ||
      local.records[submission.date]?.completed.includes(submission.taskId)
    ) {
      return [];
    }
    return [{
      ...structuredClone(submission),
      taskTitle: task.title,
      activeTaskIds: local.tasks
        .filter((candidate) => candidate.active)
        .map((candidate) => candidate.id),
      status: "pending" as const,
    }];
  });
  return [...local.submissions, ...structuredClone(additions)]
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

function canonicalChildTransaction(
  entry: GameTransaction,
  values: Partial<GameTransaction>,
) {
  return {
    ...structuredClone(entry),
    ...values,
    xpDelta: 0,
    heartsDelta: 0,
  };
}

/**
 * Child spending is validated as one ordered state transition, rather than as
 * unrelated ledger rows. This prevents two individually-valid purchases from
 * spending the same coins and prevents duplicate permanent/reward ownership.
 */
function processChildSpending(local: GameData, incoming: GameData) {
  const knownTransactionIds = new Set(local.transactions.map((entry) => entry.id));
  const knownClaimIds = new Set(local.rewardClaims.map((claim) => claim.id));
  const ownedPermanentItems = new Set(
    local.transactions
      .filter((entry) =>
        entry.kind === "purchase" &&
        virtualShopItems.some((item) => item.id === entry.itemId && item.permanent)
      )
      .map((entry) => entry.itemId as string),
  );
  const ownedAvatars = new Set([
    ...freeAvatarIds,
    ...local.transactions
      .filter((entry) => entry.kind === "avatar-unlock" && entry.avatarId)
      .map((entry) => entry.avatarId as GameData["pet"]["avatarId"]),
  ]);
  const pendingRewardIds = new Set(
    local.rewardClaims
      .filter((claim) => claim.status === "pending")
      .map((claim) => claim.rewardId),
  );
  const penaltyDates = new Set(local.care.penaltyDates);
  const incomingClaims = new Map<string, RewardClaim[]>();
  for (const claim of incoming.rewardClaims) {
    const claims = incomingClaims.get(claim.id) ?? [];
    claims.push(claim);
    incomingClaims.set(claim.id, claims);
  }

  let coins = Math.max(0, balanceFromLedger(local.transactions).coins);
  const acceptedTransactions: GameTransaction[] = [];
  const acceptedClaims: RewardClaim[] = [];
  const candidates = incoming.transactions
    .filter((entry) => !knownTransactionIds.has(entry.id))
    .sort((left, right) =>
      left.at.localeCompare(right.at) || left.id.localeCompare(right.id)
    );

  for (const entry of candidates) {
    if (
      knownTransactionIds.has(entry.id) ||
      entry.xpDelta !== 0 ||
      entry.heartsDelta !== 0 ||
      entry.coinsDelta > 0
    ) {
      continue;
    }

    let accepted: GameTransaction | null = null;
    if (entry.kind === "purchase") {
      const item = virtualShopItems.find((candidate) => candidate.id === entry.itemId);
      if (
        !item ||
        entry.coinsDelta !== -item.price ||
        coins < item.price ||
        (item.permanent && ownedPermanentItems.has(item.id))
      ) {
        continue;
      }
      accepted = canonicalChildTransaction(entry, {
        coinsDelta: -item.price,
        itemId: item.id,
        itemName: item.name,
        note: `兑换：${item.name}`,
      });
      coins -= item.price;
      if (item.permanent) ownedPermanentItems.add(item.id);
    } else if (entry.kind === "avatar-unlock") {
      const avatar = avatarCatalog.find((candidate) => candidate.id === entry.avatarId);
      if (
        !avatar ||
        avatar.price <= 0 ||
        entry.coinsDelta !== -avatar.price ||
        coins < avatar.price ||
        ownedAvatars.has(avatar.id)
      ) {
        continue;
      }
      accepted = canonicalChildTransaction(entry, {
        coinsDelta: -avatar.price,
        itemId: avatar.id,
        itemName: avatar.name,
        avatarId: avatar.id,
        note: `解锁角色：${avatar.name}`,
      });
      coins -= avatar.price;
      ownedAvatars.add(avatar.id);
    } else if (entry.kind === "real-reward-reserve") {
      const reward = local.realRewards.find((candidate) => candidate.id === entry.rewardId);
      const claims = entry.claimId ? incomingClaims.get(entry.claimId) ?? [] : [];
      const claim = claims.length === 1 ? claims[0] : null;
      if (
        !reward ||
        !reward.active ||
        !claim ||
        claim.status !== "pending" ||
        claim.rewardId !== reward.id ||
        knownClaimIds.has(claim.id) ||
        entry.coinsDelta !== -reward.price ||
        coins < reward.price ||
        pendingRewardIds.has(reward.id)
      ) {
        continue;
      }
      accepted = canonicalChildTransaction(entry, {
        coinsDelta: -reward.price,
        itemId: reward.id,
        itemName: reward.name,
        rewardId: reward.id,
        claimId: claim.id,
        note: `申请现实奖励：${reward.name}`,
      });
      acceptedClaims.push({
        id: claim.id,
        rewardId: reward.id,
        rewardName: reward.name,
        rewardDescription: reward.description,
        rewardImage: reward.image,
        category: reward.category,
        price: reward.price,
        requestedAt: entry.at,
        status: "pending",
      });
      coins -= reward.price;
      knownClaimIds.add(claim.id);
      pendingRewardIds.add(reward.id);
    } else if (entry.kind === "care-penalty") {
      const expectedLoss = Math.min(coins, local.settings.missedFeedCoins);
      const today = new Date().toISOString().slice(0, 10);
      if (
        penaltyDates.has(entry.date) ||
        entry.date >= today ||
        entry.coinsDelta !== -expectedLoss
      ) {
        continue;
      }
      accepted = canonicalChildTransaction(entry, {
        coinsDelta: -expectedLoss,
        note: expectedLoss > 0
          ? `漏喂惩罚：扣除 ${expectedLoss} 枚金币`
          : "漏喂记录：金币已为 0",
      });
      coins -= expectedLoss;
      penaltyDates.add(entry.date);
    }

    if (accepted) {
      acceptedTransactions.push(accepted);
      knownTransactionIds.add(entry.id);
    }
  }

  return { acceptedTransactions, acceptedClaims };
}

function transactionRecordDate(
  entry: GameTransaction,
  submissions: readonly TaskSubmission[],
) {
  if (entry.recordDate) return entry.recordDate;
  if (entry.kind !== "task-reward" && entry.kind !== "task-undo") return entry.date;
  return submissions.find((submission) =>
    submission.taskId === entry.taskId && submission.reviewedAt === entry.at
  )?.date ?? entry.date;
}

function cloneRecord(record: DailyRecord): DailyRecord {
  return {
    completed: [...record.completed],
    rewards: structuredClone(record.rewards),
    fullBonus: record.fullBonus,
    fullComplete: record.fullComplete,
  };
}

/**
 * Record history is monotonic across parent devices. Absence in a stale parent
 * snapshot never deletes a record; only a later audited task-undo or
 * bonus-reversal transaction can reverse an approval.
 */
function mergeRecords(
  local: GameData,
  incoming: GameData,
  transactions: readonly GameTransaction[],
) {
  const records: GameData["records"] = {};
  for (const date of uniqueStrings(
    Object.keys(local.records),
    Object.keys(incoming.records),
  )) {
    const left = local.records[date];
    const right = incoming.records[date];
    if (!left) {
      records[date] = cloneRecord(right);
      continue;
    }
    if (!right) {
      records[date] = cloneRecord(left);
      continue;
    }
    records[date] = {
      completed: uniqueStrings(left.completed, right.completed),
      rewards: {
        ...structuredClone(left.rewards),
        ...structuredClone(right.rewards),
      },
      fullBonus: left.fullBonus || right.fullBonus,
      fullComplete: left.fullComplete || right.fullComplete,
    };
  }

  const submissions = mergeSubmissions(local.submissions, incoming.submissions, "parent");
  const actions = transactions
    .filter((entry) =>
      entry.kind === "task-reward" ||
      entry.kind === "task-undo" ||
      entry.kind === "full-bonus" ||
      entry.kind === "bonus-reversal"
    )
    .sort((left, right) =>
      left.at.localeCompare(right.at) || left.id.localeCompare(right.id)
    );
  for (const entry of actions) {
    const recordDate = transactionRecordDate(entry, submissions);
    const record = records[recordDate];
    if (!record) continue;
    if (entry.kind === "task-undo" && entry.taskId) {
      record.completed = record.completed.filter((taskId) => taskId !== entry.taskId);
      delete record.rewards[entry.taskId];
      record.fullBonus = false;
      record.fullComplete = false;
    } else if (entry.kind === "task-reward" && entry.taskId) {
      const sourceReward =
        local.records[recordDate]?.rewards[entry.taskId] ??
        incoming.records[recordDate]?.rewards[entry.taskId];
      const task =
        incoming.tasks.find((candidate) => candidate.id === entry.taskId) ??
        local.tasks.find((candidate) => candidate.id === entry.taskId);
      if (sourceReward || task) {
        record.completed = uniqueStrings(record.completed, [entry.taskId]);
        record.rewards[entry.taskId] = sourceReward ?? {
          title: task?.title ?? entry.note,
          category: task?.category ?? "custom",
          coins: entry.coinsDelta,
          xp: entry.xpDelta,
        };
      }
    } else if (entry.kind === "full-bonus") {
      record.fullBonus = true;
      record.fullComplete = true;
    } else if (entry.kind === "bonus-reversal") {
      record.fullBonus = false;
      record.fullComplete = false;
    }
  }
  return records;
}

/**
 * Merges an authenticated remote snapshot without deleting append-only history.
 * Parent snapshots own household rules; child snapshots may add child activity,
 * but cannot replace parent-configured tasks, rewards, PIN, or penalty settings.
 */
export function mergeSyncedGameData(
  localValue: GameData,
  snapshot: SyncedGameSnapshot,
) {
  const local = migrateGameData(localValue).data;
  const incoming = migrateGameData(snapshot.data).data;
  const childSpending = snapshot.role === "child"
    ? processChildSpending(local, incoming)
    : null;
  const incomingTransactions = snapshot.role === "parent"
    ? incoming.transactions
    : childSpending?.acceptedTransactions ?? [];
  const transactions = mergeById(
    local.transactions,
    incomingTransactions,
    () => false,
  )
    .sort((left, right) => left.at.localeCompare(right.at))
    .filter((entry, index, all) =>
      entry.kind !== "opening-balance" ||
      all.findIndex((candidate) => candidate.kind === "opening-balance") === index
    );
  const ledgerBalance = balanceFromLedger(transactions);
  const parentOwnsConfiguration = snapshot.role === "parent";
  const configurationSource = parentOwnsConfiguration ? incoming : local;
  const activitySource = incoming;
  const purchasedItemIds = new Set(transactions
    .filter((entry) =>
      entry.kind === "purchase" &&
      entry.itemId &&
      virtualShopItems.some((item) => item.id === entry.itemId && item.permanent)
    )
    .map((entry) => entry.itemId as string));
  const unlockedAvatarIds = new Set(transactions
    .filter((entry) => entry.kind === "avatar-unlock" && entry.avatarId)
    .map((entry) => entry.avatarId as GameData["pet"]["avatarId"]));
  const owned = uniqueStrings(
    local.pet.owned,
    incoming.pet.owned,
    [...purchasedItemIds],
  )
    .filter((itemId) => purchasedItemIds.has(itemId));
  const ownedAvatars = uniqueStrings(
    freeAvatarIds,
    local.pet.ownedAvatars,
    incoming.pet.ownedAvatars,
    [...unlockedAvatarIds],
  ).filter((avatarId) =>
    freeAvatarIds.includes(avatarId as GameData["pet"]["avatarId"]) ||
    unlockedAvatarIds.has(avatarId as GameData["pet"]["avatarId"])
  ) as GameData["pet"]["ownedAvatars"];
  const requestedAvatar = activitySource.pet.avatarId;
  const avatarId = ownedAvatars.includes(requestedAvatar)
    ? requestedAvatar
    : configurationSource.pet.avatarId;
  const equippedClothes = activitySource.pet.equippedClothes &&
    owned.includes(activitySource.pet.equippedClothes)
    ? activitySource.pet.equippedClothes
    : configurationSource.pet.equippedClothes;
  const equippedDecor = activitySource.pet.equippedDecor &&
    owned.includes(activitySource.pet.equippedDecor)
    ? activitySource.pet.equippedDecor
    : configurationSource.pet.equippedDecor;

  return {
    ...configurationSource,
    version: 4 as const,
    pet: {
      ...configurationSource.pet,
      nickname: activitySource.pet.nickname,
      type: activitySource.pet.type,
      avatarId,
      owned,
      ownedAvatars,
      equippedClothes,
      equippedDecor,
      chosen: local.pet.chosen || incoming.pet.chosen,
      hunger: activitySource.pet.hunger,
      happiness: activitySource.pet.happiness,
      coins: Math.max(0, ledgerBalance.coins),
      xp: Math.max(0, ledgerBalance.xp),
      hearts: Math.max(0, ledgerBalance.hearts),
    },
    records: parentOwnsConfiguration
      ? mergeRecords(local, incoming, transactions)
      : structuredClone(local.records),
    badges: parentOwnsConfiguration
      ? uniqueStrings(local.badges, incoming.badges)
      : [...local.badges],
    transactions,
    submissions: parentOwnsConfiguration
      ? mergeSubmissions(local.submissions, incoming.submissions, snapshot.role)
      : childSubmissions(local, incoming),
    rewardClaims: parentOwnsConfiguration
      ? mergeClaims(local.rewardClaims, incoming.rewardClaims, snapshot.role)
      : [...local.rewardClaims, ...(childSpending?.acceptedClaims ?? [])]
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt)),
    care: {
      startedAtDate: local.care.startedAtDate < incoming.care.startedAtDate
        ? local.care.startedAtDate
        : incoming.care.startedAtDate,
      fedDates: uniqueStrings(local.care.fedDates, incoming.care.fedDates).sort(),
      penaltyDates: uniqueStrings(local.care.penaltyDates, incoming.care.penaltyDates).sort(),
    },
    meta: {
      ...configurationSource.meta,
      createdAt: local.meta.createdAt < incoming.meta.createdAt
        ? local.meta.createdAt
        : incoming.meta.createdAt,
      updatedAt: snapshot.createdAt,
      lastMigratedAt: local.meta.lastMigratedAt > incoming.meta.lastMigratedAt
        ? local.meta.lastMigratedAt
        : incoming.meta.lastMigratedAt,
      taskTombstones: parentOwnsConfiguration
        ? uniqueStrings(local.meta.taskTombstones, incoming.meta.taskTombstones)
        : [...local.meta.taskTombstones],
    },
  } satisfies GameData;
}

export function newestSnapshot(
  snapshots: readonly SyncedGameSnapshot[],
  role?: SyncedGameSnapshot["role"],
) {
  return snapshots
    .filter((snapshot) => !role || snapshot.role === role)
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.eventId.localeCompare(left.eventId)
    )[0] ?? null;
}
