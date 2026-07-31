import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  DataSafetyError,
  applyMissedFeedPenalties,
  approveTaskSubmission,
  approveTaskSubmissionsBatch,
  createInitialGameData,
  migrateGameData,
  requestRealReward,
  resolveRewardClaim,
  revokeTaskApproval,
  submitTaskForApproval,
  switchAvatar,
  unlockAvatar,
} from "../lib/game-data.ts";
import {
  avatarCatalog,
  defaultRealRewards,
  freeAvatarIds,
  virtualShopItems,
} from "../lib/game-catalog.ts";

function legacyV1Fixture() {
  return {
    version: 1,
    pet: {
      chosen: true,
      type: "dog",
      nickname: "团团",
      coins: 22,
      xp: 12,
      hearts: 4,
      hunger: 90,
      happiness: 91,
      owned: ["hat"],
      equippedClothes: "hat",
      equippedDecor: null,
    },
    tasks: [
      {
        id: "read",
        title: "阅读20分钟",
        icon: "📚",
        category: "reading",
        coins: 8,
        xp: 5,
        active: true,
      },
    ],
    records: {
      "2026-07-29": {
        completed: ["read"],
        rewards: {
          read: {
            title: "阅读20分钟",
            category: "reading",
            coins: 8,
            xp: 5,
          },
        },
        fullBonus: false,
        fullComplete: false,
      },
    },
    badges: ["first-step"],
    settings: { sound: true, animations: true },
  };
}

function transactionTotals(transactions) {
  return transactions.reduce(
    (sum, entry) => ({
      coins: sum.coins + entry.coinsDelta,
      xp: sum.xp + entry.xpDelta,
      hearts: sum.hearts + entry.heartsDelta,
    }),
    { coins: 0, xp: 0, hearts: 0 },
  );
}

function legacyV2Fixture() {
  const v1 = legacyV1Fixture();
  return {
    ...v1,
    version: 2,
    transactions: [
      {
        id: "legacy-v2-ledger",
        at: "2026-07-29T12:00:00.000Z",
        date: "2026-07-29",
        kind: "legacy-balance-adjustment",
        coinsDelta: 22,
        xpDelta: 12,
        heartsDelta: 4,
        note: "v2原始流水",
      },
    ],
    meta: {
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      lastMigratedAt: "2026-07-01T00:00:00.000Z",
      appVersion: "0.2.0",
      taskSeedVersion: 1,
      taskTombstones: ["old-task"],
    },
  };
}

function legacyV3Fixture() {
  const current = createInitialGameData([
    {
      id: "read",
      title: "阅读",
      icon: "📖",
      category: "reading",
      coins: 10,
      xp: 5,
      active: true,
      proofPrompt: "写下书名",
      requiresProof: true,
    },
    {
      id: "sport",
      title: "运动",
      icon: "⚽",
      category: "sport",
      coins: 8,
      xp: 4,
      active: true,
      proofPrompt: "家长现场查看",
      requiresProof: false,
    },
  ]);
  const legacyPet = { ...current.pet };
  delete legacyPet.avatarId;
  delete legacyPet.ownedAvatars;
  const legacy = { ...current };
  delete legacy.realRewards;
  delete legacy.rewardClaims;
  return {
    ...legacy,
    version: 3,
    pet: {
      ...legacyPet,
      type: "snake",
      nickname: "青宝",
      coins: 77,
      xp: 44,
      hearts: 6,
      owned: ["hat", "plant"],
      equippedClothes: "hat",
      equippedDecor: "plant",
    },
    tasks: current.tasks.map((task) => {
      const legacyTask = { ...task };
      delete legacyTask.requiresProof;
      return legacyTask;
    }),
    records: {
      "2026-07-30": {
        completed: ["read"],
        rewards: {
          read: { title: "阅读", category: "reading", coins: 10, xp: 5 },
        },
        fullBonus: false,
        fullComplete: false,
      },
    },
    badges: ["first"],
    transactions: [
      ...current.transactions,
      {
        id: "legacy-v3-purchase",
        at: "2026-07-30T09:00:00.000Z",
        date: "2026-07-30",
        kind: "purchase",
        coinsDelta: -40,
        xpDelta: 0,
        heartsDelta: 0,
        note: "兑换：夏日草帽",
        itemId: "hat",
        itemName: "夏日草帽",
      },
    ],
    submissions: [
      {
        id: "legacy-v3-submission",
        taskId: "read",
        taskTitle: "阅读",
        date: "2026-07-30",
        proofNote: "《昆虫记》12-20页",
        submittedAt: "2026-07-30T08:00:00.000Z",
        activeTaskIds: ["read", "sport"],
        status: "approved",
        reviewedAt: "2026-07-30T09:00:00.000Z",
      },
    ],
    care: {
      startedAtDate: "2026-07-01",
      fedDates: ["2026-07-29", "2026-07-30"],
      penaltyDates: ["2026-07-28"],
    },
  };
}

test("migrates v1 history without changing balances or completed records", () => {
  const legacy = legacyV1Fixture();
  const { data, migratedFrom } = migrateGameData(legacy);

  assert.equal(data.version, CURRENT_SCHEMA_VERSION);
  assert.equal(migratedFrom, 1);
  assert.deepEqual(data.records, legacy.records);
  assert.equal(data.pet.coins, legacy.pet.coins);
  assert.equal(data.pet.xp, legacy.pet.xp);
  assert.equal(data.pet.hearts, legacy.pet.hearts);
  assert.deepEqual(transactionTotals(data.transactions), {
    coins: legacy.pet.coins,
    xp: legacy.pet.xp,
    hearts: legacy.pet.hearts,
  });
  assert.ok(data.transactions.some((entry) => entry.kind === "task-reward" && entry.taskId === "read"));
  assert.ok(data.transactions.some((entry) => entry.kind === "purchase" && entry.itemId === "hat"));
  assert.equal(data.tasks[0].requiresProof, true);
  assert.equal(data.pet.avatarId, "pet-dog");
  assert.deepEqual(data.pet.ownedAvatars, freeAvatarIds);
  assert.deepEqual(data.realRewards, defaultRealRewards);
  assert.deepEqual(data.rewardClaims, []);
});

test("migrates v2 and v3 while preserving all existing history and balances", () => {
  const v2 = legacyV2Fixture();
  const migratedV2 = migrateGameData(v2);
  assert.equal(migratedV2.migratedFrom, 2);
  assert.equal(migratedV2.data.pet.coins, v2.pet.coins);
  assert.equal(migratedV2.data.transactions[0].id, "legacy-v2-ledger");
  assert.deepEqual(migratedV2.data.meta.taskTombstones, ["old-task"]);
  assert.equal(migratedV2.data.submissions[0].status, "approved");

  const v3 = legacyV3Fixture();
  const migratedV3 = migrateGameData(v3);
  assert.equal(migratedV3.migratedFrom, 3);
  assert.equal(migratedV3.data.pet.coins, 77);
  assert.equal(migratedV3.data.pet.xp, 44);
  assert.equal(migratedV3.data.pet.hearts, 6);
  assert.equal(migratedV3.data.pet.nickname, "青宝");
  assert.deepEqual(migratedV3.data.pet.owned, ["hat", "plant"]);
  assert.equal(migratedV3.data.pet.equippedClothes, "hat");
  assert.equal(migratedV3.data.pet.equippedDecor, "plant");
  assert.equal(migratedV3.data.pet.avatarId, "pet-snake");
  assert.deepEqual(migratedV3.data.pet.ownedAvatars, freeAvatarIds);
  assert.deepEqual(migratedV3.data.records, v3.records);
  assert.deepEqual(migratedV3.data.badges, v3.badges);
  assert.deepEqual(migratedV3.data.transactions, v3.transactions);
  assert.deepEqual(migratedV3.data.submissions, v3.submissions);
  assert.deepEqual(migratedV3.data.care, v3.care);
  assert.equal(migratedV3.data.tasks[0].requiresProof, true);
  assert.equal(migratedV3.data.tasks[1].requiresProof, false);
});

test("normalizing current data is idempotent and never duplicates ledger entries", () => {
  const once = migrateGameData(legacyV1Fixture()).data;
  const twice = migrateGameData(once);

  assert.equal(twice.migratedFrom, null);
  assert.deepEqual(
    twice.data.transactions.map((entry) => entry.id),
    once.transactions.map((entry) => entry.id),
  );
  assert.deepEqual(twice.data.records, once.records);
  assert.deepEqual(transactionTotals(twice.data.transactions), transactionTotals(once.transactions));
  assert.equal(once.submissions[0].status, "approved");
  assert.equal(once.submissions[0].taskId, "read");
  assert.equal(once.tasks[0].proofPrompt, "写下今天读的书名和页码");
  assert.equal(once.settings.parentPin, null);
});

test("applies each missed-feed penalty once and never makes coins negative", () => {
  const initial = createInitialGameData([
    {
      id: "read",
      title: "阅读",
      icon: "📖",
      category: "reading",
      coins: 10,
      xp: 5,
      active: true,
      proofPrompt: "写下书名",
      requiresProof: true,
    },
  ]);
  initial.pet.coins = 5;
  initial.pet.hunger = 80;
  initial.pet.happiness = 80;
  initial.care.startedAtDate = "2026-07-28";
  initial.care.fedDates = ["2026-07-29"];
  initial.settings.missedFeedCoins = 3;

  const once = applyMissedFeedPenalties(initial, "2026-07-31");
  assert.deepEqual(once.appliedDates, ["2026-07-28", "2026-07-30"]);
  assert.equal(once.data.pet.coins, 0);
  assert.equal(once.data.pet.hunger, 50);
  assert.equal(once.data.pet.happiness, 64);
  assert.deepEqual(once.data.care.penaltyDates.sort(), ["2026-07-28", "2026-07-30"]);
  assert.equal(once.data.transactions.filter((entry) => entry.kind === "care-penalty").length, 2);

  const twice = applyMissedFeedPenalties(once.data, "2026-07-31");
  assert.deepEqual(twice.appliedDates, []);
  assert.equal(twice.data.transactions.length, once.data.transactions.length);
  assert.equal(twice.data.pet.coins, 0);

  const longGap = createInitialGameData(initial.tasks);
  longGap.care.startedAtDate = "2026-01-01";
  longGap.settings.missedFeedCoins = 0;
  const bounded = applyMissedFeedPenalties(longGap, "2026-07-01");
  assert.equal(bounded.appliedDates.length, 120);
  assert.equal(bounded.appliedDates[0], "2026-03-03");
  assert.equal(bounded.appliedDates.at(-1), "2026-06-30");
});

test("holds rewards until parent approval and cannot approve twice", () => {
  const tasks = [
    {
      id: "read",
      title: "阅读",
      icon: "📖",
      category: "reading",
      coins: 10,
      xp: 5,
      active: true,
      proofPrompt: "写下书名",
      requiresProof: true,
    },
    {
      id: "sport",
      title: "运动",
      icon: "⚽",
      category: "sport",
      coins: 10,
      xp: 5,
      active: true,
      proofPrompt: "写下项目",
      requiresProof: false,
    },
  ];
  const initial = createInitialGameData(tasks);
  const submitted = submitTaskForApproval(
    initial,
    "read",
    "2026-07-31",
    "读了《昆虫记》第12—28页",
    "2026-07-31T08:00:00.000Z",
  );

  assert.equal(submitted.submitted, true);
  assert.equal(submitted.data.pet.coins, initial.pet.coins);
  assert.equal(submitted.data.pet.xp, initial.pet.xp);
  assert.equal(submitted.data.records["2026-07-31"], undefined);
  assert.equal(submitted.data.submissions[0].status, "pending");
  assert.deepEqual(submitted.data.submissions[0].activeTaskIds, ["read", "sport"]);

  const changedAfterSubmission = {
    ...submitted.data,
    tasks: submitted.data.tasks.map((task) =>
      task.id === "sport" ? { ...task, active: false } : task
    ),
  };
  const approved = approveTaskSubmission(
    changedAfterSubmission,
    submitted.data.submissions[0].id,
    "2026-07-31T09:00:00.000Z",
  );
  assert.equal(approved.approved, true);
  assert.equal(approved.data.pet.coins, 40);
  assert.equal(approved.data.pet.xp, 5);
  assert.deepEqual(approved.data.records["2026-07-31"].completed, ["read"]);
  assert.equal(approved.data.submissions[0].status, "approved");

  const repeated = approveTaskSubmission(
    approved.data,
    submitted.data.submissions[0].id,
    "2026-07-31T09:01:00.000Z",
  );
  assert.equal(repeated.approved, false);
  assert.equal(repeated.data.transactions.length, approved.data.transactions.length);
  assert.equal(repeated.data.pet.coins, approved.data.pet.coins);

  const spent = { ...approved.data, pet: { ...approved.data.pet, coins: 2 } };
  const revoked = revokeTaskApproval(
    spent,
    "read",
    "2026-07-31",
    "2026-07-31T10:00:00.000Z",
  );
  const reversal = revoked.data.transactions.slice(spent.transactions.length);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.data.pet.coins, 0);
  assert.equal(reversal.reduce((sum, entry) => sum + entry.coinsDelta, 0), -2);
  assert.deepEqual(revoked.data.records["2026-07-31"].completed, []);
  assert.equal(revoked.data.submissions[0].status, "rejected");
});

test("enforces proof only where configured and batch approval pays atomically", () => {
  const initial = createInitialGameData([
    {
      id: "read",
      title: "阅读",
      icon: "📖",
      category: "reading",
      coins: 10,
      xp: 5,
      active: true,
      proofPrompt: "写下书名",
      requiresProof: true,
    },
    {
      id: "sport",
      title: "运动",
      icon: "⚽",
      category: "sport",
      coins: 8,
      xp: 4,
      active: true,
      proofPrompt: "家长现场查看",
      requiresProof: false,
    },
  ]);
  const missingProof = submitTaskForApproval(
    initial,
    "read",
    "2026-07-31",
    "   ",
    "2026-07-31T08:00:00.000Z",
  );
  assert.equal(missingProof.submitted, false);
  assert.equal(missingProof.data, initial);

  const readSubmitted = submitTaskForApproval(
    initial,
    "read",
    "2026-07-31",
    "《昆虫记》12-20页",
    "2026-07-31T08:01:00.000Z",
  );
  const bothSubmitted = submitTaskForApproval(
    readSubmitted.data,
    "sport",
    "2026-07-31",
    "",
    "2026-07-31T08:02:00.000Z",
  );
  assert.equal(bothSubmitted.submitted, true);
  assert.equal(bothSubmitted.data.submissions[1].proofNote, "");
  assert.equal(bothSubmitted.data.pet.coins, initial.pet.coins);

  const invalidBatch = approveTaskSubmissionsBatch(
    bothSubmitted.data,
    "2026-07-31",
    ["not-a-submission"],
    "2026-07-31T09:00:00.000Z",
  );
  assert.equal(invalidBatch.processed, 0);
  assert.equal(invalidBatch.data, bothSubmitted.data);

  const readId = bothSubmitted.data.submissions[0].id;
  const sportId = bothSubmitted.data.submissions[1].id;
  const partial = approveTaskSubmissionsBatch(
    bothSubmitted.data,
    "2026-07-31",
    [readId],
    "2026-07-31T09:01:00.000Z",
  );
  assert.deepEqual(partial.approvedSubmissionIds, [readId]);
  assert.deepEqual(partial.rejectedSubmissionIds, [sportId]);
  assert.equal(partial.grantedFullBonus, false);
  assert.equal(partial.data.pet.coins, 40);
  assert.equal(partial.data.submissions[1].status, "rejected");

  const sportResubmitted = submitTaskForApproval(
    partial.data,
    "sport",
    "2026-07-31",
    "",
    "2026-07-31T09:02:00.000Z",
  );
  const secondSportId = sportResubmitted.data.submissions.at(-1).id;
  const completed = approveTaskSubmissionsBatch(
    sportResubmitted.data,
    "2026-07-31",
    [secondSportId],
    "2026-07-31T09:03:00.000Z",
  );
  assert.equal(completed.grantedFullBonus, true);
  assert.equal(completed.data.pet.coins, 68);
  assert.equal(completed.data.pet.xp, 9);
  assert.equal(completed.data.pet.hearts, 4);
  assert.deepEqual(completed.data.records["2026-07-31"].completed, ["read", "sport"]);
  assert.equal(completed.data.records["2026-07-31"].fullBonus, true);
  assert.equal(completed.data.transactions.filter((entry) => entry.kind === "full-bonus").length, 1);

  const repeated = approveTaskSubmissionsBatch(
    completed.data,
    "2026-07-31",
    [secondSportId],
    "2026-07-31T09:04:00.000Z",
  );
  assert.equal(repeated.processed, 0);
  assert.equal(repeated.data.transactions.length, completed.data.transactions.length);
  assert.equal(repeated.data.pet.coins, completed.data.pet.coins);
});

test("catalogs expose all avatars, virtual goods, and default real rewards", () => {
  assert.equal(avatarCatalog.length, 16);
  assert.equal(new Set(avatarCatalog.map((avatar) => avatar.id)).size, 16);
  assert.deepEqual(freeAvatarIds, [
    "pet-dog",
    "pet-cat",
    "pet-snake",
    "pet-dino",
    "eggy-yellow",
  ]);
  assert.deepEqual(
    Object.fromEntries(avatarCatalog.filter((avatar) => avatar.price > 0).map((avatar) => [avatar.id, avatar.price])),
    {
      "anime-dog": 180,
      "anime-cat": 200,
      "anime-snake": 220,
      "anime-dino": 240,
      "anime-girl-star": 260,
      "anime-girl-bloom": 280,
      "anime-girl-ocean": 300,
      "anime-girl-moon": 320,
      "eggy-heart-bear": 260,
      "eggy-zai-bear": 280,
      "eggy-blue-cap": 300,
    },
  );
  assert.equal(virtualShopItems.length, 8);
  assert.ok(virtualShopItems.every((item) => item.image.startsWith("/shop/")));
  assert.deepEqual(defaultRealRewards.map((reward) => reward.price), [
    80,
    90,
    120,
    140,
    220,
    320,
    420,
    520,
    630,
  ]);
  assert.ok(defaultRealRewards.every((reward) =>
    reward.image === `/reward-categories/${reward.category}.png`
  ));
});

test("avatar unlock and switch never double charge or change growth history", () => {
  const initial = createInitialGameData([]);
  initial.pet.coins = 200;
  initial.pet.nickname = "青宝";
  initial.pet.xp = 45;
  initial.pet.hearts = 6;
  const unownedSwitch = switchAvatar(initial, "anime-dog");
  assert.equal(unownedSwitch.switched, false);
  assert.equal(unownedSwitch.data, initial);

  const unlocked = unlockAvatar(
    initial,
    "anime-dog",
    "2026-07-31T10:00:00.000Z",
  );
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.data.pet.coins, 20);
  assert.ok(unlocked.data.pet.ownedAvatars.includes("anime-dog"));
  assert.equal(unlocked.data.transactions.at(-1).kind, "avatar-unlock");
  assert.equal(unlocked.data.transactions.at(-1).coinsDelta, -180);

  const repeated = unlockAvatar(
    unlocked.data,
    "anime-dog",
    "2026-07-31T10:01:00.000Z",
  );
  assert.equal(repeated.unlocked, false);
  assert.equal(repeated.data.transactions.length, unlocked.data.transactions.length);
  assert.equal(repeated.data.pet.coins, 20);

  const insufficient = unlockAvatar(
    unlocked.data,
    "anime-cat",
    "2026-07-31T10:02:00.000Z",
  );
  assert.equal(insufficient.unlocked, false);
  assert.equal(insufficient.data.pet.coins, 20);

  const switched = switchAvatar(unlocked.data, "anime-dog");
  assert.equal(switched.switched, true);
  assert.equal(switched.data.pet.avatarId, "anime-dog");
  assert.equal(switched.data.pet.nickname, "青宝");
  assert.equal(switched.data.pet.xp, 45);
  assert.equal(switched.data.pet.hearts, 6);
  assert.deepEqual(switched.data.records, initial.records);
});

test("new anime heroines stay paid and preserve history when unlocked and switched", () => {
  const initial = createInitialGameData([]);
  initial.pet.coins = 400;
  initial.pet.nickname = "小队长";
  initial.records["2026-07-31"] = {
    completed: ["read"],
    rewards: {},
    fullBonus: false,
    fullComplete: false,
  };
  assert.ok(!initial.pet.ownedAvatars.includes("anime-girl-star"));

  const unlocked = unlockAvatar(
    initial,
    "anime-girl-star",
    "2026-07-31T10:10:00.000Z",
  );
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.data.pet.coins, 140);
  assert.equal(unlocked.data.transactions.at(-1).coinsDelta, -260);
  assert.equal(unlocked.data.transactions.at(-1).itemName, "星月魔法师");

  const switched = switchAvatar(unlocked.data, "anime-girl-star");
  assert.equal(switched.switched, true);
  assert.equal(switched.data.pet.avatarId, "anime-girl-star");
  assert.equal(switched.data.pet.nickname, "小队长");
  assert.deepEqual(switched.data.records, initial.records);
});

test("real reward claims reserve coins, preserve snapshots, fulfill, and refund idempotently", () => {
  const initial = createInitialGameData([]);
  initial.pet.coins = 500;
  const invalidPrice = {
    ...initial,
    realRewards: initial.realRewards.map((reward) =>
      reward.id === "real-family-menu" ? { ...reward, price: 1.5 } : reward
    ),
  };
  const rejectedInvalidPrice = requestRealReward(
    invalidPrice,
    "real-family-menu",
    "2026-07-31T10:59:00.000Z",
  );
  assert.equal(rejectedInvalidPrice.requested, false);
  assert.equal(rejectedInvalidPrice.data.pet.coins, 500);

  const requested = requestRealReward(
    initial,
    "real-family-menu",
    "2026-07-31T11:00:00.000Z",
  );
  assert.equal(requested.requested, true);
  assert.equal(requested.data.pet.coins, 420);
  assert.equal(requested.data.rewardClaims[0].rewardName, "选择一次家庭餐单");
  assert.equal(requested.data.rewardClaims[0].price, 80);
  assert.equal(requested.data.transactions.at(-1).kind, "real-reward-reserve");
  assert.equal(requested.data.transactions.at(-1).coinsDelta, -80);

  const duplicate = requestRealReward(
    requested.data,
    "real-family-menu",
    "2026-07-31T11:01:00.000Z",
  );
  assert.equal(duplicate.requested, false);
  assert.equal(duplicate.data.transactions.length, requested.data.transactions.length);

  const renamed = {
    ...requested.data,
    realRewards: requested.data.realRewards.map((reward) =>
      reward.id === "real-family-menu"
        ? { ...reward, name: "后来改名", price: 1 }
        : reward
    ),
  };
  const fulfilled = resolveRewardClaim(
    renamed,
    requested.claimId,
    "fulfilled",
    "2026-07-31T12:00:00.000Z",
  );
  assert.equal(fulfilled.resolved, true);
  assert.equal(fulfilled.data.pet.coins, 420);
  assert.equal(fulfilled.data.rewardClaims[0].status, "fulfilled");
  assert.equal(fulfilled.data.rewardClaims[0].rewardName, "选择一次家庭餐单");
  assert.equal(fulfilled.data.rewardClaims[0].price, 80);
  assert.equal(fulfilled.data.transactions.at(-1).kind, "real-reward-fulfilled");
  assert.equal(fulfilled.data.transactions.at(-1).coinsDelta, 0);
  assert.match(fulfilled.data.transactions.at(-1).note, /选择一次家庭餐单/);

  const repeatedFulfillment = resolveRewardClaim(
    fulfilled.data,
    requested.claimId,
    "refunded",
    "2026-07-31T12:01:00.000Z",
  );
  assert.equal(repeatedFulfillment.resolved, false);
  assert.equal(repeatedFulfillment.data.transactions.length, fulfilled.data.transactions.length);
  assert.equal(repeatedFulfillment.data.pet.coins, 420);

  const snackRequested = requestRealReward(
    fulfilled.data,
    "real-snack",
    "2026-07-31T13:00:00.000Z",
  );
  assert.equal(snackRequested.data.pet.coins, 280);
  const refunded = resolveRewardClaim(
    snackRequested.data,
    snackRequested.claimId,
    "refunded",
    "2026-07-31T14:00:00.000Z",
  );
  assert.equal(refunded.resolved, true);
  assert.equal(refunded.data.pet.coins, 420);
  assert.equal(refunded.data.rewardClaims.at(-1).status, "refunded");
  assert.equal(refunded.data.transactions.at(-1).kind, "real-reward-refund");
  assert.equal(refunded.data.transactions.at(-1).coinsDelta, 140);
});

test("rejects damaged and future data instead of replacing it with defaults", () => {
  assert.throws(
    () => migrateGameData({ version: 2, pet: { coins: 1 } }),
    (error) => error instanceof DataSafetyError && /停止写入/.test(error.message),
  );

  const future = { version: CURRENT_SCHEMA_VERSION + 1, futurePayload: { changedShape: true } };
  assert.throws(
    () => migrateGameData(future),
    (error) => error instanceof DataSafetyError &&
      error.reason === "future-schema" &&
      /更高版本/.test(error.message),
  );
});
