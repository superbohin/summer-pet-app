"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FamilyAccessGate, {
  type CreateFamilyDeviceRequestInput,
  type FamilyAccessStatus,
  type FamilyDeviceRequest as FamilyDeviceRequestView,
} from "./FamilyAccessGate";
import FamilyDevicePanel from "./FamilyDevicePanel";
import PetApp, { type PetAppSurface } from "./PetApp";
import {
  approveOrRevokeDevice,
  canonicalStringify,
  createDeviceIdentity,
  createEncryptedEvent,
  createHouseholdKdfParameters,
  createInitialFamilyConfig,
  decryptFamilyConfig,
  deriveHouseholdKey,
  deriveHouseholdRequestProofKey,
  exportDeviceRequest,
  verifyConfig,
  type DeviceRequest,
  type FamilyConfig,
} from "../lib/github-family-sync";
import {
  confirmQueuedFamilyEvents,
  enqueueFamilyEvent,
  getFamilyOutboxStatus,
  loadFamilyConnectionProfile,
  saveFamilyConnectionProfile,
  type FamilyConnectionProfile,
  type FamilyOutboxStatus,
} from "../lib/family-device-store";
import {
  publishFamilySnapshot,
  syncFamilyNow,
} from "../lib/family-sync-service";
import { snapshotAndReplaceGameData, type GameData } from "../lib/game-data";
import { readCloudBaseBuildConfig } from "../lib/cloudbase-build-config";
import { createCloudBaseFamilyClient } from "../lib/cloudbase-family-sync";
import {
  createFamilyRemoteClient,
  familySyncProvider,
} from "../lib/family-sync-provider";

type FamilyAppProps = {
  initialSurface?: PetAppSurface;
};

function requestView(request: DeviceRequest): FamilyDeviceRequestView {
  return {
    requestId: `request:${request.deviceId}`,
    deviceId: request.deviceId,
    deviceName: request.label ?? "未命名设备",
    requestedRole: request.requestedRole,
    publicKey: JSON.stringify(request.publicKey),
    createdAt: request.requestedAt,
    requestJson: JSON.stringify(request, null, 2),
  };
}

function profileStatus(
  profile: FamilyConnectionProfile | null,
  surface: "child" | "parent",
): FamilyAccessStatus {
  if (!profile) return "unconfigured";
  const device = profile.config?.devices.find(
    (candidate) => candidate.deviceId === profile.identity.deviceId,
  );
  if (!device) return "pending";
  if (device.status === "revoked") return "error";
  return device.role === surface ? "approved" : "denied";
}

function hasSurfaceAccess(
  profile: FamilyConnectionProfile | null,
  surface: "child" | "parent",
) {
  const device = profile?.config?.devices.find(
    (candidate) => candidate.deviceId === profile.identity.deviceId,
  );
  return device?.status === "active" && device.role === surface;
}

function lightweightDigest(data: GameData) {
  const value = JSON.stringify(data);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function isMissingRemoteConfig(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /404|not[ -]?found|not initialized|尚未初始化|config[-_ ]missing/i.test(
    message,
  );
}

const EMPTY_OUTBOX_STATUS: FamilyOutboxStatus = {
  unsentCount: 0,
  awaitingConfirmationCount: 0,
  retryableCount: 0,
  supersededCount: 0,
  totalActiveCount: 0,
};

export default function FamilyApp({
  initialSurface = "combined",
}: FamilyAppProps) {
  const surface = initialSurface;
  const [profile, setProfile] = useState<FamilyConnectionProfile | null>(null);
  const [status, setStatus] = useState<FamilyAccessStatus>(
    surface === "combined" ? "approved" : "loading",
  );
  const [online, setOnline] = useState(true);
  const [outboxStatus, setOutboxStatus] = useState<FamilyOutboxStatus>(
    EMPTY_OUTBOX_STATUS,
  );
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [remoteData, setRemoteData] = useState<GameData | null>(null);
  const [remoteRevision, setRemoteRevision] = useState("");
  const [syncReady, setSyncReady] = useState(surface === "combined");
  const [localHydrated, setLocalHydrated] = useState(false);
  const currentData = useRef<GameData | null>(null);
  const dataMutationRevision = useRef(0);
  const remoteApplySequence = useRef(0);
  const publishQueue = useRef<Promise<void>>(Promise.resolve());
  const lastPublishedDigest = useRef("");
  const hydrationBaselineDigest = useRef<string | null>(null);
  const profileRef = useRef<FamilyConnectionProfile | null>(null);
  const initialSyncStarted = useRef(false);
  const syncInFlight = useRef<Promise<void> | null>(null);
  const migrationInProgress = useRef(false);
  const lastAutomaticSyncAt = useRef(0);
  const cloudBaseSettings = useMemo(() => readCloudBaseBuildConfig(), []);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const refreshPendingCount = useCallback(async () => {
    try {
      setOutboxStatus(await getFamilyOutboxStatus());
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "无法读取本机同步队列",
      );
    }
  }, []);

  useEffect(() => {
    if (surface === "combined") return;
    let cancelled = false;
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    void loadFamilyConnectionProfile()
      .then(async (stored) => {
        if (cancelled) return;
        setProfile(stored);
        profileRef.current = stored;
        lastPublishedDigest.current = stored?.lastPublishedDigest ?? "";
        setStatus(profileStatus(stored, surface));
        await refreshPendingCount();
        setSyncReady(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "无法读取本机家庭配置");
        setStatus("error");
      });
    return () => {
      cancelled = true;
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, [refreshPendingCount, surface]);

  const adoptProfile = useCallback((next: FamilyConnectionProfile) => {
    profileRef.current = next;
    setProfile(next);
    setStatus(profileStatus(next, surface === "combined" ? "child" : surface));
  }, [surface]);

  const persistProfile = useCallback(async (next: FamilyConnectionProfile) => {
    await saveFamilyConnectionProfile(next);
    adoptProfile(next);
  }, [adoptProfile]);

  const runFamilySync = useCallback((
    activeProfile: FamilyConnectionProfile,
    local: GameData,
    interactive: boolean,
  ) => {
    if (migrationInProgress.current) return Promise.resolve();
    if (syncInFlight.current) return syncInFlight.current;
    if (interactive) setBusy(true);
    const task = (async () => {
      const result = await syncFamilyNow(activeProfile, local, {
        getLatestData: () => currentData.current ?? local,
        getMutationRevision: () => dataMutationRevision.current,
        persistData: (next, revision) =>
          snapshotAndReplaceGameData(next, `before-family-sync-${revision}`),
        applyData: (next, revision) => {
          currentData.current = structuredClone(next);
          remoteApplySequence.current += 1;
          setRemoteData(structuredClone(next));
          setRemoteRevision(
            `family-sync:${revision}:${remoteApplySequence.current}`,
          );
        },
      });
      const latestProfile = profileRef.current;
      const nextProfile = latestProfile &&
        latestProfile.identity.deviceId === result.profile.identity.deviceId
        ? {
            ...result.profile,
            config: (latestProfile.config?.version ?? -1) >
                (result.profile.config?.version ?? -1)
              ? latestProfile.config
              : result.profile.config,
            configSha: (latestProfile.config?.version ?? -1) >
                (result.profile.config?.version ?? -1)
              ? latestProfile.configSha
              : result.profile.configSha,
            lastPublishedDigest: latestProfile.lastPublishedDigest ??
              result.profile.lastPublishedDigest,
            lastObservedDigest: latestProfile.lastObservedDigest ??
              result.profile.lastObservedDigest,
            lastAppliedEventIds: Array.from(new Set([
              ...result.profile.lastAppliedEventIds,
              ...latestProfile.lastAppliedEventIds,
            ])).slice(-2_000),
            pendingDeviceRequests: latestProfile.pendingDeviceRequests,
          }
        : result.profile;
      await saveFamilyConnectionProfile(nextProfile);
      adoptProfile(nextProfile);
      setOutboxStatus(result.outboxStatus);
      setSyncReady(true);
      setErrorMessage(result.syncError ?? "");
      lastAutomaticSyncAt.current = Date.now();
    })()
      .finally(async () => {
        syncInFlight.current = null;
        if (interactive) setBusy(false);
        await refreshPendingCount();
      });
    syncInFlight.current = task;
    return task;
  }, [adoptProfile, refreshPendingCount]);

  const refreshAccess = useCallback(async () => {
    const activeProfile = profileRef.current;
    if (!activeProfile) {
      setStatus("unconfigured");
      return;
    }
    setBusy(true);
    setErrorMessage("");
    try {
      const client = createFamilyRemoteClient(activeProfile);
      const result = await client.readConfig();
      const trustedRoot = activeProfile.trustedRootPublicKey ?? result.config.rootPublicKey;
      if (!(await verifyConfig(result.config, trustedRoot))) {
        throw new Error("家庭配置签名无法验证");
      }
      if (
        activeProfile.config &&
        result.config.version < activeProfile.config.version
      ) {
        throw new Error("检测到家庭配置版本回退，已拒绝同步");
      }
      let pendingDeviceRequests = activeProfile.pendingDeviceRequests;
      if (
        familySyncProvider(activeProfile) === "cloudbase" &&
        client.listDeviceRequests &&
        activeProfile.identity.deviceId === result.config.rootDeviceId
      ) {
        const remoteRequests = await client.listDeviceRequests();
        const configuredIds = new Set(
          result.config.devices.map((candidate) => candidate.deviceId),
        );
        pendingDeviceRequests = remoteRequests.filter(
          (candidate) => !configuredIds.has(candidate.deviceId),
        );
      }
      const next = {
        ...activeProfile,
        config: result.config,
        configSha: result.revision,
        trustedRootPublicKey: trustedRoot,
        pendingDeviceRequests: pendingDeviceRequests.filter(
          (candidate) => candidate.deviceId !== activeProfile.identity.deviceId ||
            !result.config.devices.some(
              (device) =>
                device.deviceId === candidate.deviceId && device.status === "active",
            ),
        ),
      };
      await persistProfile(next);
      const device = result.config.devices.find(
        (candidate) => candidate.deviceId === next.identity.deviceId,
      );
      if (!device) {
        setStatus("pending");
        return;
      }
      if (device.status !== "active") {
        throw new Error("这台设备已被家庭管理员撤销");
      }
      const requestedSurface = surface === "combined" ? "child" : surface;
      setStatus(profileStatus(next, requestedSurface));
      if (device.role !== requestedSurface) return;
      if (currentData.current) {
        await runFamilySync(next, currentData.current, false);
      } else {
        // A newly approved device has not mounted and hydrated PetApp yet.
        // Keep the first-pull gate closed so its default/old local snapshot
        // cannot be published before remote household state is applied.
        setSyncReady(false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "检查设备授权失败";
      setErrorMessage(message);
      const accessFailure =
        message.includes("撤销") ||
        message.includes("签名") ||
        message.includes("版本回退");
      setStatus(
        accessFailure
          ? "error"
          : profileStatus(activeProfile, surface === "combined" ? "child" : surface),
      );
      throw error;
    } finally {
      setBusy(false);
      await refreshPendingCount();
    }
  }, [persistProfile, refreshPendingCount, runFamilySync, surface]);

  const createDeviceRequest = useCallback(async (
    input: CreateFamilyDeviceRequestInput,
  ) => {
    if (!input.familyPassphrase) throw new Error("请输入家庭口令");
    if (!cloudBaseSettings) {
      throw new Error("发布版尚未配置 CloudBase EnvId 和 Publishable Key");
    }
    setBusy(true);
    setErrorMessage("");
    try {
      const identity = await createDeviceIdentity();
      const client = createCloudBaseFamilyClient(cloudBaseSettings);
      let config: FamilyConfig;
      let configSha: string;
      let householdKey: CryptoKey;
      let deviceRequestKey: CryptoKey;
      let trustedRootPublicKey: JsonWebKey;
      let approved = false;

      try {
        const existing = await client.readConfig();
        if (!(await verifyConfig(existing.config))) {
          throw new Error("CloudBase 中的家庭配置签名无效");
        }
        householdKey = await deriveHouseholdKey(
          input.familyPassphrase,
          existing.config.kdf,
        );
        await decryptFamilyConfig(existing.config, householdKey);
        deviceRequestKey = (
          await deriveHouseholdRequestProofKey(
            householdKey,
            existing.config.householdId,
          )
        ).key;
        config = existing.config;
        configSha = existing.revision;
        trustedRootPublicKey = existing.config.rootPublicKey;
      } catch (error) {
        if (input.requestedRole !== "parent" || !isMissingRemoteConfig(error)) {
          throw error;
        }
        if (input.familyPassphrase.trim().length < 10) {
          throw new Error("首次创建家庭时，家庭口令请至少使用 10 个字符");
        }
        const kdf = createHouseholdKdfParameters();
        householdKey = await deriveHouseholdKey(input.familyPassphrase, kdf);
        const householdId = `family_${crypto.randomUUID()}`;
        config = await createInitialFamilyConfig({
          householdId,
          rootDevice: identity,
          householdKey,
          kdf,
          household: {
            schemaVersion: 1,
            name: "家庭暑假成长记录",
            createdAt: new Date().toISOString(),
          },
          rootDeviceLabel: input.deviceName,
        });
        const requestProof = await deriveHouseholdRequestProofKey(
          householdKey,
          config.householdId,
        );
        deviceRequestKey = requestProof.key;
        const initialized = await client.initializeConfigWithRequestKey(
          config,
          requestProof.encodedKey,
        );
        configSha = initialized.revision;
        trustedRootPublicKey = config.rootPublicKey;
        approved = true;
      }

      const request = exportDeviceRequest(identity, input.requestedRole, {
        label: input.deviceName,
      });
      const existingDevice = config.devices.find(
        (candidate) => candidate.deviceId === identity.deviceId,
      );
      approved = approved || existingDevice?.status === "active";
      if (!approved) {
        await createCloudBaseFamilyClient(cloudBaseSettings, {
          deviceRequestKey,
        }).submitDeviceRequest(request);
      }
      const next: FamilyConnectionProfile = {
        id: "current",
        provider: "cloudbase",
        cloudbase: cloudBaseSettings,
        owner: "",
        repo: "",
        branch: "",
        workflowRef: "",
        token: "",
        deviceLabel: input.deviceName,
        requestedRole: input.requestedRole,
        identity,
        householdKey,
        deviceRequestKey,
        trustedRootPublicKey,
        config,
        configSha,
        lastSyncAt: null,
        lastPublishedDigest: null,
        lastObservedDigest: null,
        lastAppliedEventIds: [],
        pendingDeviceRequests: approved ? [] : [request],
      };
      await persistProfile(next);
      setStatus(approved ? "approved" : "pending");
      setSyncReady(approved);
    } finally {
      setBusy(false);
    }
  }, [cloudBaseSettings, persistProfile]);

  const handleDataChange = useCallback((data: GameData) => {
    dataMutationRevision.current += 1;
    currentData.current = data;
    setLocalHydrated(true);
    if (surface === "combined") return;
    const activeProfile = profileRef.current;
    if (!activeProfile || !hasSurfaceAccess(activeProfile, surface)) return;
    const digest = lightweightDigest(data);
    const recoverSavedState =
      activeProfile.lastObservedDigest === digest &&
      activeProfile.lastPublishedDigest !== digest;
    if (
      !syncReady &&
      hydrationBaselineDigest.current === null &&
      !recoverSavedState
    ) {
      hydrationBaselineDigest.current = digest;
      return;
    }
    if (
      digest === lastPublishedDigest.current ||
      digest === activeProfile.lastPublishedDigest
    ) return;
    publishQueue.current = publishQueue.current
      .catch(() => undefined)
      .then(async () => {
      const latestProfile = profileRef.current;
      if (
        !latestProfile ||
        !hasSurfaceAccess(latestProfile, surface) ||
        latestProfile.lastPublishedDigest === digest
      ) {
        return;
      }
      const observedProfile = {
        ...latestProfile,
        lastObservedDigest: digest,
      };
      await saveFamilyConnectionProfile(observedProfile);
      profileRef.current = observedProfile;
      setProfile(observedProfile);

      try {
        await publishFamilySnapshot(observedProfile, data, { flush: false });
        const queuedProfile = {
          ...observedProfile,
          lastPublishedDigest: digest,
        };
        lastPublishedDigest.current = digest;
        await persistProfile(queuedProfile);
        if (navigator.onLine) {
          await runFamilySync(queuedProfile, data, false);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "家庭记录暂未进入同步队列");
      } finally {
        await refreshPendingCount();
      }
    });
  }, [persistProfile, refreshPendingCount, runFamilySync, surface, syncReady]);

  const syncNow = useCallback(async () => {
    const activeProfile = profileRef.current;
    const local = currentData.current;
    if (!activeProfile || !local) throw new Error("本机记录尚未读取完成");
    setErrorMessage("");
    await runFamilySync(activeProfile, local, true);
  }, [runFamilySync]);

  useEffect(() => {
    if (
      surface === "combined" ||
      !online ||
      !localHydrated ||
      status !== "approved" ||
      syncReady ||
      initialSyncStarted.current
    ) {
      return;
    }
    initialSyncStarted.current = true;
    void syncNow().catch((error: unknown) => {
      initialSyncStarted.current = false;
      setErrorMessage(error instanceof Error ? error.message : "首次家庭同步失败");
    });
  }, [localHydrated, online, status, surface, syncNow, syncReady]);

  useEffect(() => {
    if (
      surface === "combined" ||
      !online ||
      !localHydrated ||
      status !== "approved" ||
      !syncReady
    ) {
      return;
    }
    const trigger = () => {
      if (
        document.visibilityState !== "visible" ||
        Date.now() - lastAutomaticSyncAt.current < 20_000
      ) {
        return;
      }
      const activeProfile = profileRef.current;
      const local = currentData.current;
      if (!activeProfile || !local) return;
      lastAutomaticSyncAt.current = Date.now();
      void runFamilySync(activeProfile, local, false).catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : "自动同步暂时失败");
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") trigger();
    };
    trigger();
    const timer = window.setInterval(trigger, 60_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", trigger);
    window.addEventListener("online", trigger);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", trigger);
      window.removeEventListener("online", trigger);
    };
  }, [localHydrated, online, runFamilySync, status, surface, syncReady]);

  const addPendingRequest = useCallback(async (requestJson: string) => {
    const activeProfile = profileRef.current;
    if (!activeProfile) throw new Error("家长设备尚未配置");
    const parsed = JSON.parse(requestJson) as DeviceRequest;
    if (
      !parsed.deviceId ||
      !parsed.publicKey ||
      !parsed.requestedRole ||
      !parsed.requestedAt
    ) {
      throw new Error("设备申请缺少必要字段");
    }
    const next = {
      ...activeProfile,
      pendingDeviceRequests: [
        ...activeProfile.pendingDeviceRequests.filter(
          (request) => request.deviceId !== parsed.deviceId,
        ),
        parsed,
      ],
    };
    await persistProfile(next);
  }, [persistProfile]);

  const updateDevice = useCallback(async (
    action: "approve" | "revoke",
    deviceId: string,
    role?: "child" | "parent",
  ) => {
    const activeProfile = profileRef.current;
    if (!activeProfile?.config || !activeProfile.configSha) {
      throw new Error("家庭设备配置尚未同步");
    }
    if (activeProfile.identity.deviceId !== activeProfile.config.rootDeviceId) {
      throw new Error("只有最初创建家庭的根家长设备可以修改设备授权");
    }
    const request = activeProfile.pendingDeviceRequests.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (action === "approve" && !request) throw new Error("找不到这条设备申请");
    const config = await approveOrRevokeDevice(
      activeProfile.config,
      action === "approve"
        ? { action: "approve", request: request as DeviceRequest, role: role ?? "child" }
        : { action: "revoke", deviceId },
      activeProfile.identity.privateKey,
    );
    const client = createFamilyRemoteClient(activeProfile);
    const updated = await client.updateConfig(
      config,
      activeProfile.configSha,
    );
    const next = {
      ...activeProfile,
      config: updated.config,
      configSha: updated.revision,
      pendingDeviceRequests: activeProfile.pendingDeviceRequests.filter(
        (candidate) => candidate.deviceId !== deviceId,
      ),
    };
    await persistProfile(next);
    if (client.resolveDeviceRequest) {
      try {
        await client.resolveDeviceRequest(deviceId);
      } catch {
        // The signed config is authoritative; a stale queue entry is harmless
        // and will be filtered from the parent view on the next refresh.
      }
    }
  }, [persistProfile]);

  const migrateToCloudBase = useCallback(async () => {
    if (!cloudBaseSettings) {
      throw new Error("发布版尚未配置 CloudBase EnvId 和 Publishable Key");
    }
    setBusy(true);
    setErrorMessage("");
    migrationInProgress.current = true;
    const migrationTask = publishQueue.current
      .catch(() => undefined)
      .then(async () => {
      if (syncInFlight.current) {
        await syncInFlight.current;
      }
      const activeProfile = profileRef.current;
      if (!activeProfile) throw new Error("本机家庭配置尚未读取");
      if (familySyncProvider(activeProfile) === "cloudbase") return;
      if (!activeProfile.config || !activeProfile.householdKey) {
        throw new Error("请先完成原有家庭设备配对，再迁移同步通道");
      }

      const trustedRoot = activeProfile.trustedRootPublicKey ??
        activeProfile.config.rootPublicKey;
      if (!(await verifyConfig(activeProfile.config, trustedRoot))) {
        throw new Error("本机家庭配置签名验证失败，未执行迁移");
      }

      const requestProof = await deriveHouseholdRequestProofKey(
        activeProfile.householdKey,
        activeProfile.config.householdId,
      );
      const targetClient = createCloudBaseFamilyClient(cloudBaseSettings, {
        deviceRequestKey: requestProof.key,
      });
      let target: { config: FamilyConfig; revision: string };
      const isRoot =
        activeProfile.identity.deviceId === activeProfile.config.rootDeviceId;

      if (isRoot) {
        try {
          target = await targetClient.readConfig();
          if (!(await verifyConfig(target.config, trustedRoot))) {
            throw new Error("CloudBase 已有配置无法通过本家庭根密钥验证");
          }
          if (
            target.config.householdId !== activeProfile.config.householdId ||
            target.config.rootDeviceId !== activeProfile.config.rootDeviceId
          ) {
            throw new Error("CloudBase 环境已被另一个家庭初始化");
          }
          if (target.config.version < activeProfile.config.version) {
            target = await targetClient.updateConfig(
              activeProfile.config,
              target.revision,
            );
          } else if (
            target.config.version === activeProfile.config.version &&
            canonicalStringify(target.config) !== canonicalStringify(activeProfile.config)
          ) {
            throw new Error("CloudBase 与 GitHub 存在同版本但内容不同的家庭配置");
          }
        } catch (error) {
          if (!isMissingRemoteConfig(error)) throw error;
          target = await targetClient.initializeConfigWithRequestKey(
            activeProfile.config,
            requestProof.encodedKey,
          );
        }
      } else {
        target = await targetClient.readConfig();
        if (
          target.config.householdId !== activeProfile.config.householdId ||
          target.config.rootDeviceId !== activeProfile.config.rootDeviceId ||
          !(await verifyConfig(target.config, trustedRoot))
        ) {
          throw new Error("CloudBase 家庭空间与本机原家庭不匹配，请先迁移根家长设备");
        }
      }

      const activeDevice = target.config.devices.find(
        (candidate) => candidate.deviceId === activeProfile.identity.deviceId,
      );
      if (!activeDevice || activeDevice.status !== "active") {
        throw new Error("CloudBase 尚未包含本设备，请先迁移并刷新根家长设备");
      }
      const local = currentData.current;
      if (!local) throw new Error("本机记录尚未读取完成，请稍后再迁移");
      const migrationDataRevision = dataMutationRevision.current;
      const migrationEvent = await createEncryptedEvent({
        device: activeProfile.identity,
        role: activeProfile.requestedRole,
        op: "state.snapshot",
        payload: { schemaVersion: 1, data: structuredClone(local) },
        householdKey: activeProfile.householdKey,
      });
      await enqueueFamilyEvent(migrationEvent);
      await targetClient.dispatchEvent(migrationEvent);
      const confirmation = await targetClient.listEventsWithIndex(new Set());
      const confirmedEvent = confirmation.events.find(
        (candidate) => candidate.id === migrationEvent.id,
      );
      if (
        !confirmedEvent ||
        canonicalStringify(confirmedEvent) !== canonicalStringify(migrationEvent)
      ) {
        throw new Error("CloudBase 未能回读确认完整历史快照，本机仍保留 GitHub 同步");
      }
      if (dataMutationRevision.current !== migrationDataRevision) {
        throw new Error("迁移期间本机记录发生了变化，请再次点击迁移以发送最新记录");
      }
      await confirmQueuedFamilyEvents([migrationEvent.id]);
      if (dataMutationRevision.current !== migrationDataRevision) {
        throw new Error("迁移提交前本机记录发生了变化，请再次点击迁移");
      }
      const digest = lightweightDigest(local);
      const next: FamilyConnectionProfile = {
        ...activeProfile,
        provider: "cloudbase",
        cloudbase: cloudBaseSettings,
        deviceRequestKey: requestProof.key,
        config: target.config,
        configSha: target.revision,
        trustedRootPublicKey: trustedRoot,
        pendingDeviceRequests: [],
        lastSyncAt: new Date().toISOString(),
        lastPublishedDigest: digest,
        lastObservedDigest: digest,
        lastAppliedEventIds: Array.from(new Set([
          ...activeProfile.lastAppliedEventIds,
          migrationEvent.id,
        ])).slice(-2_000),
      };
      await persistProfile(next);
      lastPublishedDigest.current = digest;
      if (
        dataMutationRevision.current !== migrationDataRevision &&
        currentData.current
      ) {
        const latest = structuredClone(currentData.current);
        const latestDigest = lightweightDigest(latest);
        await publishFamilySnapshot(next, latest, { flush: false });
        const queuedLatestProfile: FamilyConnectionProfile = {
          ...next,
          lastPublishedDigest: latestDigest,
          lastObservedDigest: latestDigest,
        };
        await persistProfile(queuedLatestProfile);
        lastPublishedDigest.current = latestDigest;
      }
      setSyncReady(true);
    });
    publishQueue.current = migrationTask.catch(() => undefined);
    try {
      await migrationTask;
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "迁移到 CloudBase 失败",
      );
      throw error;
    } finally {
      migrationInProgress.current = false;
      setBusy(false);
      await refreshPendingCount();
    }
  }, [
    cloudBaseSettings,
    persistProfile,
    refreshPendingCount,
  ]);

  const parentDevicePanel = useMemo(() => {
    if (surface !== "parent" || !profile?.config) return null;
    const isRoot = profile.identity.deviceId === profile.config.rootDeviceId;
    const originMigrationNote = (
      <section className="settings-section">
        <h3>第一次从旧网址迁移</h3>
        <p className="settings-help">
          浏览器不能跨网址读取 IndexedDB。请先在旧站家长设置中导出 JSON，再到本页“记录与备份”选择“恢复备份”；以后保持同一个 GitHub Pages 地址，程序更新不会清除记录。
        </p>
      </section>
    );
    if (!isRoot) {
      return (
        <>
          {originMigrationNote}
          <section className="settings-section">
            <h3>家庭设备</h3>
            <p className="settings-help">设备授权由最初创建家庭的家长设备管理；本机可以正常验收和同步记录。</p>
          </section>
        </>
      );
    }
    return (
      <>
        {originMigrationNote}
        <section className="settings-section">
          <FamilyDevicePanel
            devices={profile.config.devices.map((device) => ({
              deviceId: device.deviceId,
              deviceName: device.label ?? device.deviceId.slice(0, 14),
              role: device.role,
              status: device.status === "active" ? "approved" : "revoked",
              publicKey: JSON.stringify(device.publicKey),
              createdAt: device.addedAt,
              lastSyncedAt: device.deviceId === profile.identity.deviceId
                ? profile.lastSyncAt
                : null,
            }))}
            pendingRequests={profile.pendingDeviceRequests.map(requestView)}
            currentDeviceId={profile.identity.deviceId}
            online={online}
            busy={busy}
            automaticRequests={familySyncProvider(profile) === "cloudbase"}
            onAddDeviceRequest={addPendingRequest}
            onApproveDevice={(input) =>
              updateDevice("approve", input.deviceId, input.role)
            }
            onRevokeDevice={(deviceId) => updateDevice("revoke", deviceId)}
            onRefresh={refreshAccess}
          />
        </section>
      </>
    );
  }, [
    addPendingRequest,
    busy,
    online,
    profile,
    refreshAccess,
    surface,
    updateDevice,
  ]);

  if (surface === "combined") {
    return <PetApp surface="combined" />;
  }

  const activeDevice = profile?.config?.devices.find(
    (candidate) => candidate.deviceId === profile.identity.deviceId,
  );
  const pendingRequest = profile?.pendingDeviceRequests.find(
    (candidate) => candidate.deviceId === profile.identity.deviceId,
  );

  return (
    <FamilyAccessGate
      surface={surface}
      status={status}
      device={profile ? {
        deviceId: profile.identity.deviceId,
        deviceName: profile.deviceLabel,
        role: activeDevice?.role,
        publicKey: JSON.stringify(profile.identity.publicKeyJwk),
      } : null}
      request={pendingRequest ? requestView(pendingRequest) : null}
      online={online}
      pendingEventCount={outboxStatus.totalActiveCount}
      unsentEventCount={outboxStatus.unsentCount}
      awaitingConfirmationCount={outboxStatus.awaitingConfirmationCount}
      retryableEventCount={outboxStatus.retryableCount}
      supersededEventCount={outboxStatus.supersededCount}
      lastSyncedAt={profile?.lastSyncAt}
      errorMessage={errorMessage}
      initialDeviceName={profile?.deviceLabel}
      cloudBaseReady={Boolean(cloudBaseSettings)}
      syncProvider={profile ? familySyncProvider(profile) : "cloudbase"}
      migrationAvailable={Boolean(
        profile &&
          cloudBaseSettings &&
          familySyncProvider(profile) === "github",
      )}
      onCreateDeviceRequest={createDeviceRequest}
      onRefresh={refreshAccess}
      onSyncNow={syncNow}
      onMigrateToCloudBase={migrateToCloudBase}
      busy={busy}
      renderApp={() => (
        <PetApp
          surface={surface}
          remoteData={remoteData}
          remoteRevision={remoteRevision}
          onDataChange={handleDataChange}
          parentDevicePanel={parentDevicePanel}
        />
      )}
    />
  );
}
