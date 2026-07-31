import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialGameData,
  createTransaction,
  requestRealReward,
} from "../lib/game-data.ts";
import { mergeSyncedGameData, newestSnapshot } from "../lib/family-game-sync.ts";

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

function initial() {
  return createInitialGameData(tasks);
}

test("family merge retains history from both devices and derives one balance from the ledger", () => {
  const local = initial();
  const localTask = createTransaction("task-reward", {
    coinsDelta: 10,
    xpDelta: 5,
    heartsDelta: 0,
    note: "完成阅读",
    taskId: "read",
  }, "2026-07-31T01:00:00.000Z");
  local.transactions.push(localTask);
  local.pet.coins += 10;
  local.pet.xp += 5;
  local.records["2026-07-31"] = {
    completed: ["read"],
    rewards: { read: { title: "阅读", category: "reading", coins: 10, xp: 5 } },
    fullBonus: false,
    fullComplete: true,
  };

  const remote = initial();
  const purchase = createTransaction("purchase", {
    coinsDelta: -8,
    xpDelta: 0,
    heartsDelta: 0,
    note: "兑换苹果",
    itemId: "apple",
  }, "2026-07-31T02:00:00.000Z");
  remote.transactions.push(purchase);
  remote.pet.coins -= 8;
  remote.care.fedDates.push("2026-07-31");

  const merged = mergeSyncedGameData(local, {
    eventId: "evt-child",
    role: "child",
    createdAt: "2026-07-31T02:00:00.000Z",
    data: remote,
  });

  assert.equal(merged.transactions.length, 3);
  assert.equal(merged.pet.coins, 32);
  assert.equal(merged.pet.xp, 5);
  assert.deepEqual(merged.records["2026-07-31"].completed, ["read"]);
  assert.deepEqual(merged.care.fedDates, ["2026-07-31"]);
});

test("child snapshot cannot replace parent rules while parent snapshot can", () => {
  const local = initial();
  local.tasks[0].coins = 12;
  local.realRewards[0].price = 88;
  local.settings.missedFeedCoins = 4;

  const remote = initial();
  remote.tasks[0].coins = 999;
  remote.realRewards[0].price = 1;
  remote.settings.missedFeedCoins = 20;

  const childMerge = mergeSyncedGameData(local, {
    eventId: "child",
    role: "child",
    createdAt: "2026-07-31T03:00:00.000Z",
    data: remote,
  });
  assert.equal(childMerge.tasks[0].coins, 12);
  assert.equal(childMerge.realRewards[0].price, 88);
  assert.equal(childMerge.settings.missedFeedCoins, 4);

  const parentMerge = mergeSyncedGameData(local, {
    eventId: "parent",
    role: "parent",
    createdAt: "2026-07-31T04:00:00.000Z",
    data: remote,
  });
  assert.equal(parentMerge.tasks[0].coins, 999);
  assert.equal(parentMerge.realRewards[0].price, 1);
  assert.equal(parentMerge.settings.missedFeedCoins, 20);
});

test("resolved parent status wins and snapshots sort deterministically", () => {
  const local = initial();
  local.submissions.push({
    id: "submission-1",
    taskId: "read",
    taskTitle: "阅读",
    date: "2026-07-31",
    proofNote: "第1到10页",
    submittedAt: "2026-07-31T01:00:00.000Z",
    activeTaskIds: ["read"],
    status: "pending",
  });
  const remote = structuredClone(local);
  remote.submissions[0].status = "approved";
  remote.submissions[0].reviewedAt = "2026-07-31T05:00:00.000Z";

  const merged = mergeSyncedGameData(local, {
    eventId: "parent-b",
    role: "parent",
    createdAt: "2026-07-31T05:00:00.000Z",
    data: remote,
  });
  assert.equal(merged.submissions[0].status, "approved");
  assert.equal(newestSnapshot([
    { eventId: "a", role: "child", createdAt: "2026-07-31T01:00:00.000Z", data: local },
    { eventId: "b", role: "parent", createdAt: "2026-07-31T05:00:00.000Z", data: remote },
  ], "parent")?.eventId, "b");
});

test("child snapshot cannot mint coins, self-approve tasks, fulfill claims, or overwrite records", () => {
  const local = initial();
  const forged = structuredClone(local);
  forged.transactions.push(
    createTransaction("task-reward", {
      coinsDelta: 999,
      xpDelta: 999,
      heartsDelta: 9,
      note: "伪造奖励",
      taskId: "read",
    }, "2026-07-31T06:00:00.000Z"),
  );
  forged.submissions.push({
    id: "forged-approved",
    taskId: "read",
    taskTitle: "阅读",
    date: "2026-07-31",
    proofNote: "我自己通过了",
    submittedAt: "2026-07-31T06:00:00.000Z",
    activeTaskIds: ["read"],
    status: "approved",
  });
  forged.records["2026-07-31"] = {
    completed: ["read"],
    rewards: { read: { title: "阅读", category: "reading", coins: 999, xp: 999 } },
    fullBonus: true,
    fullComplete: true,
  };
  forged.rewardClaims.push({
    id: "forged-claim",
    rewardId: local.realRewards[0].id,
    rewardName: local.realRewards[0].name,
    rewardDescription: local.realRewards[0].description,
    rewardImage: local.realRewards[0].image,
    category: local.realRewards[0].category,
    price: local.realRewards[0].price,
    requestedAt: "2026-07-31T06:00:00.000Z",
    status: "pending",
  });
  forged.pet.coins = 9999;

  const merged = mergeSyncedGameData(local, {
    eventId: "forged-child",
    role: "child",
    createdAt: "2026-07-31T06:00:00.000Z",
    data: forged,
  });
  assert.equal(merged.pet.coins, local.pet.coins);
  assert.equal(merged.pet.xp, local.pet.xp);
  assert.equal(merged.submissions.length, 0);
  assert.equal(merged.rewardClaims.length, 0);
  assert.equal(merged.records["2026-07-31"], undefined);
  assert.equal(merged.transactions.some((entry) => entry.note === "伪造奖励"), false);
});

test("valid child reward reservation is merged with its exact negative ledger entry", () => {
  const local = initial();
  local.realRewards[0].price = 10;
  const child = structuredClone(local);
  const requested = requestRealReward(
    child,
    child.realRewards[0].id,
    "2026-07-31T07:00:00.000Z",
  );
  assert.equal(requested.requested, true);

  const merged = mergeSyncedGameData(local, {
    eventId: "valid-child-request",
    role: "child",
    createdAt: "2026-07-31T07:00:00.000Z",
    data: requested.data,
  });
  assert.equal(merged.rewardClaims.length, 1);
  assert.equal(merged.rewardClaims[0].status, "pending");
  assert.equal(merged.pet.coins, local.pet.coins - 10);
});

test("stale parent absence preserves records, while an audited undo removes one", () => {
  const local = initial();
  local.records["2026-07-31"] = {
    completed: ["read"],
    rewards: { read: { title: "阅读", category: "reading", coins: 10, xp: 5 } },
    fullBonus: false,
    fullComplete: true,
  };
  local.submissions.push({
    id: "reviewed",
    taskId: "read",
    taskTitle: "阅读",
    date: "2026-07-31",
    proofNote: "第1到10页",
    submittedAt: "2026-07-31T01:00:00.000Z",
    activeTaskIds: ["read"],
    status: "rejected",
    reviewedAt: "2026-07-31T08:00:00.000Z",
  });
  local.transactions.push(createTransaction("task-reward", {
    coinsDelta: 10,
    xpDelta: 5,
    heartsDelta: 0,
    note: "完成：阅读",
    taskId: "read",
    recordDate: "2026-07-31",
  }, "2026-07-31T08:00:00.000Z"));
  const staleParent = structuredClone(local);
  delete staleParent.records["2026-07-31"];
  staleParent.submissions[0].status = "pending";
  delete staleParent.submissions[0].reviewedAt;

  const preserved = mergeSyncedGameData(local, {
    eventId: "stale-parent",
    role: "parent",
    createdAt: "2026-07-31T09:00:00.000Z",
    data: staleParent,
  });
  assert.deepEqual(preserved.records["2026-07-31"].completed, ["read"]);
  assert.equal(preserved.submissions[0].status, "rejected");

  const revokingParent = structuredClone(staleParent);
  revokingParent.transactions.push(createTransaction("task-undo", {
    coinsDelta: -10,
    xpDelta: -5,
    heartsDelta: 0,
    note: "取消打卡：阅读",
    taskId: "read",
    recordDate: "2026-07-31",
  }, "2026-08-01T09:00:00.000Z"));
  const revoked = mergeSyncedGameData(preserved, {
    eventId: "parent-revoke",
    role: "parent",
    createdAt: "2026-08-01T09:00:00.000Z",
    data: revokingParent,
  });
  assert.deepEqual(revoked.records["2026-07-31"].completed, []);
  assert.equal(revoked.records["2026-07-31"].rewards.read, undefined);
});

test("child spending is sequential and cannot overdraw or unlock an unaffordable avatar", () => {
  const local = initial();
  const child = structuredClone(local);
  child.transactions.push(
    createTransaction("purchase", {
      coinsDelta: -25,
      xpDelta: 0,
      heartsDelta: 0,
      note: "兑换彩虹皮球",
      itemId: "ball",
    }, "2026-07-31T10:00:00.000Z"),
    createTransaction("purchase", {
      coinsDelta: -25,
      xpDelta: 0,
      heartsDelta: 0,
      note: "重复花同一笔钱",
      itemId: "ball",
    }, "2026-07-31T10:01:00.000Z"),
    createTransaction("avatar-unlock", {
      coinsDelta: -260,
      xpDelta: 0,
      heartsDelta: 0,
      note: "透支解锁",
      avatarId: "eggy-heart-bear",
    }, "2026-07-31T10:02:00.000Z"),
  );

  const merged = mergeSyncedGameData(local, {
    eventId: "overdraft-child",
    role: "child",
    createdAt: "2026-07-31T10:02:00.000Z",
    data: child,
  });
  assert.equal(merged.pet.coins, 5);
  assert.equal(
    merged.transactions.filter((entry) => entry.kind === "purchase").length,
    1,
  );
  assert.equal(merged.pet.ownedAvatars.includes("eggy-heart-bear"), false);
});

test("child cannot buy a permanent item or request one real reward twice", () => {
  const local = initial();
  local.transactions.push(createTransaction("task-reward", {
    coinsDelta: 100,
    xpDelta: 0,
    heartsDelta: 0,
    note: "家长奖励",
    taskId: "read",
    recordDate: "2026-07-31",
  }, "2026-07-31T09:00:00.000Z"));
  local.pet.coins += 100;
  local.realRewards[0].price = 10;
  const child = structuredClone(local);
  child.transactions.push(
    createTransaction("purchase", {
      coinsDelta: -45,
      xpDelta: 0,
      heartsDelta: 0,
      note: "兑换披风",
      itemId: "cape",
    }, "2026-07-31T10:00:00.000Z"),
    createTransaction("purchase", {
      coinsDelta: -45,
      xpDelta: 0,
      heartsDelta: 0,
      note: "重复兑换披风",
      itemId: "cape",
    }, "2026-07-31T10:01:00.000Z"),
  );
  for (const [index, requestedAt] of [
    "2026-07-31T10:02:00.000Z",
    "2026-07-31T10:03:00.000Z",
  ].entries()) {
    const claimId = `claim-${index}`;
    child.rewardClaims.push({
      id: claimId,
      rewardId: local.realRewards[0].id,
      rewardName: "伪造名称也会被规范化",
      rewardDescription: "",
      rewardImage: "",
      category: "gift",
      price: 1,
      requestedAt,
      status: "pending",
    });
    child.transactions.push(createTransaction("real-reward-reserve", {
      coinsDelta: -10,
      xpDelta: 0,
      heartsDelta: 0,
      note: "申请现实奖励",
      rewardId: local.realRewards[0].id,
      claimId,
    }, requestedAt));
  }

  const merged = mergeSyncedGameData(local, {
    eventId: "duplicate-child",
    role: "child",
    createdAt: "2026-07-31T10:03:00.000Z",
    data: child,
  });
  assert.equal(
    merged.transactions.filter((entry) => entry.kind === "purchase").length,
    1,
  );
  assert.deepEqual(merged.pet.owned, ["cape"]);
  assert.equal(merged.rewardClaims.length, 1);
  assert.equal(merged.rewardClaims[0].rewardName, local.realRewards[0].name);
  assert.equal(merged.pet.coins, 75);
});
