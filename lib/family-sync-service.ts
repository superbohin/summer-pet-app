import {
  canonicalStringify,
  createEncryptedEvent,
  decryptEvent,
  validateEventEnvelope,
  verifyConfig,
  type FamilyEventEnvelope,
} from "./github-family-sync.ts";
import {
  compactFamilyOutboxSnapshots,
  confirmQueuedFamilyEvents,
  enqueueFamilyEvent,
  getFamilyOutboxStatus,
  listQueuedFamilyEvents,
  markFamilyEventAttempt,
  markFamilyEventDispatched,
  saveFamilyConnectionProfile,
  type FamilyConnectionProfile,
  type QueuedFamilyEvent,
} from "./family-device-store.ts";
import {
  mergeSyncedGameData,
  type SyncedGameSnapshot,
} from "./family-game-sync.ts";
import { createFamilyRemoteClient } from "./family-sync-provider.ts";
import type { GameData } from "./game-data.ts";

type SnapshotPayload = {
  schemaVersion: 1;
  data: GameData;
};

type FamilySnapshotCandidate = SyncedGameSnapshot & {
  confirmationOnly?: boolean;
};

type FamilySyncPersistence = {
  getLatestData?: () => GameData;
  getMutationRevision?: () => number;
  persistData?: (data: GameData, revision: string) => Promise<void>;
  applyData?: (data: GameData, revision: string) => Promise<void> | void;
};

const CONFIRMATION_RETRY_MS = 15 * 60 * 1_000;
const MAX_REBASE_ATTEMPTS = 8;

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replayChangedObject<T extends Record<string, unknown>>(
  baseline: T,
  latest: T,
  remote: T,
) {
  const result = structuredClone(remote);
  for (const key of Object.keys(latest) as Array<keyof T>) {
    if (!sameValue(baseline[key], latest[key])) {
      result[key] = structuredClone(latest[key]);
    }
  }
  return result;
}

function replayChangedItems<T extends { id: string }>(
  baseline: readonly T[],
  latest: readonly T[],
  remote: readonly T[],
) {
  const baselineById = new Map(baseline.map((item) => [item.id, item]));
  const latestById = new Map(latest.map((item) => [item.id, item]));
  const result = new Map(remote.map((item) => [item.id, structuredClone(item)]));
  for (const id of new Set([...baselineById.keys(), ...latestById.keys()])) {
    const before = baselineById.get(id);
    const after = latestById.get(id);
    if (sameValue(before, after)) continue;
    if (after) result.set(id, structuredClone(after));
    else result.delete(id);
  }
  return [...result.values()];
}

/**
 * A locally-authored event is already represented by the current cumulative
 * state. On confirmation, recover only monotonic history from its old payload;
 * never let that payload roll current settings or appearance backward.
 */
function mergeConfirmedLocalSnapshot(
  current: GameData,
  snapshot: SyncedGameSnapshot,
) {
  const historical = structuredClone(snapshot.data);
  historical.pet = structuredClone(current.pet);
  historical.tasks = structuredClone(current.tasks);
  historical.realRewards = structuredClone(current.realRewards);
  historical.settings = structuredClone(current.settings);
  historical.meta = structuredClone(current.meta);
  return mergeSyncedGameData(current, { ...snapshot, data: historical });
}

/** Replays only fields changed locally after the sync baseline was captured. */
function replayConcurrentLocalChanges(
  baseline: GameData,
  latest: GameData,
  remote: GameData,
  localRole: SyncedGameSnapshot["role"],
  revision: string,
) {
  if (sameValue(baseline, latest)) return remote;
  const replay = structuredClone(remote);
  replay.pet = replayChangedObject(
    baseline.pet as unknown as Record<string, unknown>,
    latest.pet as unknown as Record<string, unknown>,
    remote.pet as unknown as Record<string, unknown>,
  ) as unknown as GameData["pet"];
  replay.records = structuredClone(latest.records);
  replay.badges = structuredClone(latest.badges);
  replay.transactions = structuredClone(latest.transactions);
  replay.submissions = structuredClone(latest.submissions);
  replay.rewardClaims = structuredClone(latest.rewardClaims);
  replay.care = structuredClone(latest.care);

  let merged = mergeSyncedGameData(remote, {
    eventId: `local-replay:${revision}`,
    role: localRole,
    createdAt: new Date().toISOString(),
    data: replay,
  });
  if (localRole === "parent") {
    merged = {
      ...merged,
      tasks: replayChangedItems(baseline.tasks, latest.tasks, merged.tasks),
      realRewards: replayChangedItems(
        baseline.realRewards,
        latest.realRewards,
        merged.realRewards,
      ),
      settings: replayChangedObject(
        baseline.settings,
        latest.settings,
        merged.settings,
      ),
      meta: {
        ...merged.meta,
        taskSeedVersion: baseline.meta.taskSeedVersion === latest.meta.taskSeedVersion
          ? merged.meta.taskSeedVersion
          : latest.meta.taskSeedVersion,
        taskTombstones: Array.from(new Set([
          ...merged.meta.taskTombstones,
          ...latest.meta.taskTombstones,
        ])),
      },
    };
  }
  return merged;
}

/**
 * Rebase authenticated snapshots onto the newest in-memory state. If a local
 * save lands while IndexedDB is being replaced, repeat the merge so neither
 * side can overwrite the other.
 */
export async function settleFamilySnapshots(
  localData: GameData,
  snapshots: readonly FamilySnapshotCandidate[],
  persistence: FamilySyncPersistence = {},
  revision = new Date().toISOString(),
  localRole: SyncedGameSnapshot["role"] = "child",
) {
  if (snapshots.length === 0) {
    return structuredClone(persistence.getLatestData?.() ?? localData);
  }
  const ordered = [...snapshots].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) ||
    left.eventId.localeCompare(right.eventId)
  );
  let remote = structuredClone(localData);
  for (const snapshot of ordered) {
    remote = snapshot.confirmationOnly
      ? mergeConfirmedLocalSnapshot(remote, snapshot)
      : mergeSyncedGameData(remote, snapshot);
  }
  for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt += 1) {
    const mutationRevision = persistence.getMutationRevision?.();
    const latest = structuredClone(persistence.getLatestData?.() ?? localData);
    if (
      mutationRevision !== undefined &&
      persistence.getMutationRevision?.() !== mutationRevision
    ) {
      continue;
    }
    const merged = replayConcurrentLocalChanges(
      localData,
      latest,
      remote,
      localRole,
      revision,
    );
    if (persistence.persistData) {
      await persistence.persistData(merged, revision);
    }
    if (
      mutationRevision !== undefined &&
      persistence.getMutationRevision?.() !== mutationRevision
    ) {
      continue;
    }
    await persistence.applyData?.(merged, revision);
    return merged;
  }
  throw new Error("本机记录仍在变化，本次同步已安全暂停，请稍后重试");
}

export function selectFamilyEventToDispatch(
  events: readonly QueuedFamilyEvent[],
  now = Date.now(),
) {
  const active = events.filter((item) => !item.supersededBy);
  const hasRecentAwaiting = active.some((item) => {
    if (!item.dispatchedAt) return false;
    const dispatchedAt = Date.parse(item.dispatchedAt);
    return Number.isFinite(dispatchedAt) &&
      now - dispatchedAt < CONFIRMATION_RETRY_MS;
  });
  if (hasRecentAwaiting) return null;
  return active.find((item) => item.dispatchedAt) ??
    active.find((item) => !item.dispatchedAt) ??
    null;
}

function assertReady(profile: FamilyConnectionProfile) {
  if (!profile.householdKey || !profile.config) {
    throw new Error("家庭同步尚未完成配对");
  }
  const device = profile.config.devices.find(
    (candidate) => candidate.deviceId === profile.identity.deviceId,
  );
  if (!device || device.status !== "active") {
    throw new Error("这台设备尚未获得家长批准，或已被撤销");
  }
  if (device.role !== profile.requestedRole) {
    throw new Error("当前入口与家长批准的设备角色不一致");
  }
  return device;
}

export async function flushFamilyOutbox(profile: FamilyConnectionProfile) {
  await compactFamilyOutboxSnapshots();
  const client = createFamilyRemoteClient(profile);
  const candidate = selectFamilyEventToDispatch(await listQueuedFamilyEvents());
  if (!candidate) {
    return { sent: 0, status: await getFamilyOutboxStatus(), lastError: null };
  }
  try {
    await client.dispatchEvent(candidate.envelope);
    await markFamilyEventDispatched(candidate.id);
    return { sent: 1, status: await getFamilyOutboxStatus(), lastError: null };
  } catch (error) {
    await markFamilyEventAttempt(candidate.id, error);
    return {
      sent: 0,
      status: await getFamilyOutboxStatus(),
      lastError: error instanceof Error ? error.message : "同步事件发送失败",
    };
  }
}

export async function publishFamilySnapshot(
  profile: FamilyConnectionProfile,
  data: GameData,
  options: { flush?: boolean } = {},
) {
  assertReady(profile);
  const event = await createEncryptedEvent<SnapshotPayload>({
    device: profile.identity,
    role: profile.requestedRole,
    op: "state.snapshot",
    payload: { schemaVersion: 1, data: structuredClone(data) },
    householdKey: profile.householdKey as CryptoKey,
  });
  await enqueueFamilyEvent(event);
  let syncError: string | null = null;
  if (
    options.flush !== false &&
    typeof navigator !== "undefined" &&
    navigator.onLine
  ) {
    const flushed = await flushFamilyOutbox(profile);
    syncError = flushed.lastError;
  }
  return { eventId: event.id, syncError };
}

export async function pullFamilySnapshots(
  profile: FamilyConnectionProfile,
  localData: GameData,
  persistence: FamilySyncPersistence = {},
) {
  await compactFamilyOutboxSnapshots();
  const client = createFamilyRemoteClient(profile);
  const { config, revision } = await client.readConfig();
  const trustedRoot = profile.trustedRootPublicKey ?? config.rootPublicKey;
  if (!(await verifyConfig(config, trustedRoot))) {
    throw new Error("家庭配置签名不正确，已拒绝同步");
  }
  if (profile.config && config.version < profile.config.version) {
    throw new Error("检测到家庭配置版本回退，已拒绝同步");
  }
  const nextProfile: FamilyConnectionProfile = {
    ...profile,
    config,
    configSha: revision,
    trustedRootPublicKey: trustedRoot,
  };
  assertReady(nextProfile);

  const applied = new Set(profile.lastAppliedEventIds);
  const queued = await listQueuedFamilyEvents();
  const queuedById = new Map(queued.map((item) => [item.id, item]));
  const excludeIds = new Set(profile.lastAppliedEventIds);
  for (const item of queued) excludeIds.delete(item.id);
  const eventBatch = await client.listEventsWithIndex<SnapshotPayload>(excludeIds);
  const snapshots: FamilySnapshotCandidate[] = [];
  const appliedNow: string[] = [];
  const confirmedQueueIds: string[] = [];
  for (const event of eventBatch.events) {
    await validateEventEnvelope(event, config, { trustedRootPublicKey: trustedRoot });
    const localQueueItem = queuedById.get(event.id);
    if (localQueueItem) {
      if (canonicalStringify(localQueueItem.envelope) !== canonicalStringify(event)) {
        throw new Error(`同步事件 ${event.id} 与本机待确认记录不一致`);
      }
      if (event.op === "state.snapshot") {
        const payload = await decryptEvent<SnapshotPayload>(
          event,
          profile.householdKey as CryptoKey,
        );
        if (payload.schemaVersion !== 1 || !payload.data) {
          throw new Error(`同步事件 ${event.id} 的数据格式无法识别`);
        }
        snapshots.push({
          eventId: event.id,
          role: event.role,
          createdAt: event.timestamp,
          data: payload.data,
          confirmationOnly: true,
        });
      }
      confirmedQueueIds.push(event.id);
      appliedNow.push(event.id);
      continue;
    }
    if (applied.has(event.id)) continue;
    if (event.op !== "state.snapshot") {
      appliedNow.push(event.id);
      continue;
    }
    const payload = await decryptEvent<SnapshotPayload>(event, profile.householdKey as CryptoKey);
    if (payload.schemaVersion !== 1 || !payload.data) {
      throw new Error(`同步事件 ${event.id} 的数据格式无法识别`);
    }
    snapshots.push({
      eventId: event.id,
      role: event.role,
      createdAt: event.timestamp,
      data: payload.data,
    });
    appliedNow.push(event.id);
  }

  const mergeRevision = appliedNow.at(-1) ?? new Date().toISOString();
  const merged = await settleFamilySnapshots(
    localData,
    snapshots,
    persistence,
    mergeRevision,
    profile.requestedRole,
  );

  nextProfile.lastAppliedEventIds = Array.from(new Set([
    ...profile.lastAppliedEventIds,
    ...appliedNow,
  ])).slice(-2_000);
  nextProfile.lastSyncAt = new Date().toISOString();
  await saveFamilyConnectionProfile(nextProfile);
  await confirmQueuedFamilyEvents(confirmedQueueIds);
  return {
    profile: nextProfile,
    data: merged,
    appliedEventIds: appliedNow,
    eventCount: eventBatch.remoteEventIds.length,
    outboxStatus: await getFamilyOutboxStatus(),
  };
}

export async function syncFamilyNow(
  profile: FamilyConnectionProfile,
  localData: GameData,
  persistence: FamilySyncPersistence = {},
) {
  if (typeof navigator === "undefined" || !navigator.onLine) {
    throw new Error("当前离线，操作已留在本机，联网后再同步");
  }
  const pulled = await pullFamilySnapshots(profile, localData, persistence);
  const flushed = await flushFamilyOutbox(pulled.profile);
  return {
    ...pulled,
    outboxStatus: flushed.status,
    syncError: flushed.lastError,
  };
}

export function familyDeviceRequestId(event: FamilyEventEnvelope | { deviceId: string }) {
  return `request:${event.deviceId}`;
}
