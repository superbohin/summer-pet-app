import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  DataSafetyError,
  applyMissedFeedPenalties,
  approveTaskSubmission,
  createInitialGameData,
  migrateGameData,
  revokeTaskApproval,
  submitTaskForApproval,
} from "../lib/game-data.ts";

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
