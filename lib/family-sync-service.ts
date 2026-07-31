import {
  createEncryptedEvent,
  createGithubFamilyClient,
  decryptEvent,
  validateEventEnvelope,
  verifyConfig,
  type FamilyEventEnvelope,
} from "./github-family-sync";
import {
  enqueueFamilyEvent,
  listQueuedFamilyEvents,
  markFamilyEventAttempt,
  markFamilyEventDispatched,
  removeQueuedFamilyEvent,
  saveFamilyConnectionProfile,
  type FamilyConnectionProfile,
} from "./family-device-store";
import {
  mergeSyncedGameData,
  type SyncedGameSnapshot,
} from "./family-game-sync";
import type { GameData } from "./game-data";

type SnapshotPayload = {
  schemaVersion: 1;
  data: GameData;
};

function clientFor(profile: FamilyConnectionProfile) {
  return createGithubFamilyClient({
    owner: profile.owner,
    repo: profile.repo,
    branch: profile.branch,
    workflowRef: profile.workflowRef,
  });
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
  const client = clientFor(profile);
  const queued = await listQueuedFamilyEvents();
  let sent = 0;
  for (const item of queued) {
    if (
      item.dispatchedAt &&
      Date.now() - Date.parse(item.dispatchedAt) < 10 * 60 * 1_000
    ) {
      continue;
    }
    try {
      await client.dispatchEvent(profile.token, item.envelope);
      await markFamilyEventDispatched(item.id);
      sent += 1;
    } catch (error) {
      await markFamilyEventAttempt(item.id, error);
      break;
    }
  }
  return { sent, remaining: (await listQueuedFamilyEvents()).length };
}

export async function publishFamilySnapshot(
  profile: FamilyConnectionProfile,
  data: GameData,
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
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      await flushFamilyOutbox(profile);
    } catch (error) {
      syncError = error instanceof Error ? error.message : "事件已安全入队，但暂时无法发送";
    }
  }
  return { eventId: event.id, syncError };
}

export async function pullFamilySnapshots(
  profile: FamilyConnectionProfile,
  localData: GameData,
) {
  const client = clientFor(profile);
  const { config, sha } = await client.readConfig(profile.token);
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
    configSha: sha,
    trustedRootPublicKey: trustedRoot,
  };
  assertReady(nextProfile);

  const applied = new Set(profile.lastAppliedEventIds);
  let merged = structuredClone(localData);
  const appliedNow: string[] = [];
  const events = await client.listEvents<SnapshotPayload>(profile.token);
  const confirmedEventIds = new Set(events.map((event) => event.id));
  const queued = await listQueuedFamilyEvents();
  await Promise.all(
    queued
      .filter((item) => confirmedEventIds.has(item.id))
      .map((item) => removeQueuedFamilyEvent(item.id)),
  );
  for (const event of events) {
    if (applied.has(event.id)) continue;
    await validateEventEnvelope(event, config, { trustedRootPublicKey: trustedRoot });
    if (event.op !== "state.snapshot") {
      appliedNow.push(event.id);
      continue;
    }
    const payload = await decryptEvent<SnapshotPayload>(event, profile.householdKey as CryptoKey);
    if (payload.schemaVersion !== 1 || !payload.data) {
      throw new Error(`同步事件 ${event.id} 的数据格式无法识别`);
    }
    const snapshot: SyncedGameSnapshot = {
      eventId: event.id,
      role: event.role,
      createdAt: event.timestamp,
      data: payload.data,
    };
    merged = mergeSyncedGameData(merged, snapshot);
    appliedNow.push(event.id);
  }

  nextProfile.lastAppliedEventIds = [
    ...profile.lastAppliedEventIds,
    ...appliedNow,
  ].slice(-2_000);
  nextProfile.lastSyncAt = new Date().toISOString();
  await saveFamilyConnectionProfile(nextProfile);
  return {
    profile: nextProfile,
    data: merged,
    appliedEventIds: appliedNow,
    eventCount: events.length,
  };
}

export async function syncFamilyNow(
  profile: FamilyConnectionProfile,
  localData: GameData,
) {
  if (typeof navigator === "undefined" || !navigator.onLine) {
    throw new Error("当前离线，操作已留在本机，联网后再同步");
  }
  await flushFamilyOutbox(profile);
  return pullFamilySnapshots(profile, localData);
}

export function familyDeviceRequestId(event: FamilyEventEnvelope | { deviceId: string }) {
  return `request:${event.deviceId}`;
}
