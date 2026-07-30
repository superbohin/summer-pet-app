import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  DataSafetyError,
  migrateGameData,
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

test("normalizing v2 data is idempotent and never duplicates ledger entries", () => {
  const once = migrateGameData(legacyV1Fixture()).data;
  const twice = migrateGameData(once);

  assert.equal(twice.migratedFrom, null);
  assert.deepEqual(
    twice.data.transactions.map((entry) => entry.id),
    once.transactions.map((entry) => entry.id),
  );
  assert.deepEqual(twice.data.records, once.records);
  assert.deepEqual(transactionTotals(twice.data.transactions), transactionTotals(once.transactions));
});

test("rejects damaged and future data instead of replacing it with defaults", () => {
  assert.throws(
    () => migrateGameData({ version: 2, pet: { coins: 1 } }),
    (error) => error instanceof DataSafetyError && /停止写入/.test(error.message),
  );

  const future = { ...legacyV1Fixture(), version: CURRENT_SCHEMA_VERSION + 1 };
  assert.throws(
    () => migrateGameData(future),
    (error) => error instanceof DataSafetyError && /更高版本/.test(error.message),
  );
});

