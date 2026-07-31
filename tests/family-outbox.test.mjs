import assert from "node:assert/strict";
import test from "node:test";

import { summarizeFamilyOutbox } from "../lib/family-device-store.ts";
import {
  selectFamilyEventToDispatch,
  settleFamilySnapshots,
} from "../lib/family-sync-service.ts";
import { createInitialGameData } from "../lib/game-data.ts";

const NOW = Date.parse("2026-07-31T16:00:00.000Z");

function queued(id, values = {}) {
  return {
    id,
    createdAt: values.createdAt ?? "2026-07-31T15:00:00.000Z",
    envelope: {
      id,
      deviceId: "device-child",
      role: "child",
      op: "state.snapshot",
      timestamp: values.createdAt ?? "2026-07-31T15:00:00.000Z",
      iv: "iv",
      ciphertext: "ciphertext",
      signature: "signature",
    },
    attempts: 0,
    ...values,
  };
}

test("outbox status separates unsent, awaiting, retryable and superseded snapshots", () => {
  const status = summarizeFamilyOutbox([
    queued("unsent"),
    queued("awaiting", { dispatchedAt: "2026-07-31T15:55:00.000Z" }),
    queued("retryable", { dispatchedAt: "2026-07-31T15:20:00.000Z" }),
    queued("old", { supersededBy: "unsent" }),
  ], NOW);

  assert.deepEqual(status, {
    unsentCount: 1,
    awaitingConfirmationCount: 1,
    retryableCount: 1,
    supersededCount: 1,
    totalActiveCount: 3,
  });
});

test("one recent in-flight event blocks every later dispatch", () => {
  const waiting = queued("waiting", {
    dispatchedAt: "2026-07-31T15:55:00.000Z",
  });
  const newer = queued("newer", { createdAt: "2026-07-31T15:58:00.000Z" });
  assert.equal(selectFamilyEventToDispatch([waiting, newer], NOW), null);
});

test("confirmation timeout retries only the existing event before an unsent one", () => {
  const stale = queued("stale", {
    dispatchedAt: "2026-07-31T15:20:00.000Z",
  });
  const newer = queued("newer", { createdAt: "2026-07-31T15:58:00.000Z" });
  assert.equal(selectFamilyEventToDispatch([stale, newer], NOW)?.id, "stale");
});

test("superseded snapshots do not block or dispatch", () => {
  const old = queued("old", {
    dispatchedAt: "2026-07-31T15:59:00.000Z",
    supersededBy: "latest",
  });
  const latest = queued("latest", { createdAt: "2026-07-31T15:59:30.000Z" });
  assert.equal(selectFamilyEventToDispatch([old, latest], NOW)?.id, "latest");
});

test("snapshot persistence rebases when local data changes during sync", async () => {
  const tasks = [{
    id: "read",
    title: "阅读",
    icon: "📖",
    category: "reading",
    coins: 10,
    xp: 5,
    active: true,
    proofPrompt: "书名页码",
    requiresProof: true,
  }];
  let latest = createInitialGameData(tasks);
  let revision = 0;
  let persistCount = 0;
  let applied = null;
  const parent = createInitialGameData(tasks);
  parent.settings.missedFeedCoins = 9;

  const result = await settleFamilySnapshots(latest, [{
    eventId: "parent-settings",
    role: "parent",
    createdAt: "2026-07-31T15:30:00.000Z",
    data: parent,
  }], {
    getLatestData: () => latest,
    getMutationRevision: () => revision,
    persistData: async (next) => {
      persistCount += 1;
      if (persistCount === 1) {
        latest = createInitialGameData(tasks);
        latest.settings.missedFeedCoins = 7;
        revision += 1;
      } else {
        latest = structuredClone(next);
      }
    },
    applyData: (next) => {
      applied = structuredClone(next);
    },
  }, "race-test", "parent");

  assert.equal(persistCount, 2);
  assert.equal(result.settings.missedFeedCoins, 7);
  assert.deepEqual(applied, result);
});

test("confirmed old local snapshot restores history without rolling settings back", async () => {
  const tasks = [{
    id: "read",
    title: "阅读",
    icon: "📖",
    category: "reading",
    coins: 10,
    xp: 5,
    active: true,
    proofPrompt: "书名页码",
    requiresProof: true,
  }];
  const current = createInitialGameData(tasks);
  current.settings.missedFeedCoins = 7;
  const old = createInitialGameData(tasks);
  old.settings.missedFeedCoins = 4;
  old.care.fedDates.push("2026-07-30");

  const result = await settleFamilySnapshots(current, [{
    eventId: "confirmed-old",
    role: "parent",
    createdAt: "2026-07-30T12:00:00.000Z",
    data: old,
    confirmationOnly: true,
  }], {}, "confirmation-test", "parent");

  assert.equal(result.settings.missedFeedCoins, 7);
  assert.deepEqual(result.care.fedDates, ["2026-07-30"]);
});

test("a later parent snapshot cannot roll back the child's selected avatar", async () => {
  const local = createInitialGameData([]);
  const child = createInitialGameData([]);
  child.pet.avatarId = "pet-cat";
  child.pet.nickname = "小月亮";
  const parent = createInitialGameData([]);
  parent.pet.avatarId = "pet-dog";
  parent.pet.nickname = "旧名字";
  parent.settings.missedFeedCoins = 9;

  const result = await settleFamilySnapshots(local, [
    {
      eventId: "child-selects-cat",
      role: "child",
      createdAt: "2026-08-01T08:00:00.000Z",
      data: child,
    },
    {
      eventId: "parent-approves-later",
      role: "parent",
      createdAt: "2026-08-01T08:05:00.000Z",
      data: parent,
    },
  ], {}, "avatar-order-test", "child");

  assert.equal(result.pet.avatarId, "pet-cat");
  assert.equal(result.pet.nickname, "小月亮");
  assert.equal(result.settings.missedFeedCoins, 9);
});
