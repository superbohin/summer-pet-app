"use client";
/* eslint-disable @next/next/no-img-element -- local PWA pet assets are pre-cached for offline use */

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  APP_VERSION,
  CURRENT_SCHEMA_VERSION,
  DataSafetyError,
  FULL_BONUS_COINS,
  applyMissedFeedPenalties,
  approveTaskSubmissionsBatch,
  createInitialGameData,
  createSafetySnapshot,
  createTransaction,
  loadGameData,
  prepareImportedGameData,
  queueGameDataSave,
  requestRealReward,
  resolveRewardClaim,
  revokeTaskApproval,
  snapshotAndReplaceGameData,
  submitTaskForApproval,
  switchAvatar,
  unlockAvatar,
  type GameData,
  type RealReward,
  type Task,
  type TaskCategory,
} from "../lib/game-data";
import {
  avatarCatalog,
  freeAvatarIds,
  virtualShopItems,
  type AvatarCatalogItem,
  type AvatarId,
  type RealRewardCategory,
  type VirtualShopItem,
} from "../lib/game-catalog";

type Tab = "today" | "home" | "shop" | "growth";

const badgeDefinitions = [
  { id: "first", icon: "🌟", name: "第一次打卡", hint: "完成第一个任务" },
  { id: "reader", icon: "📚", name: "阅读小达人", hint: "累计阅读7天" },
  { id: "sport", icon: "🏃", name: "运动小健将", hint: "累计运动7天" },
  { id: "tidy", icon: "🧺", name: "整理小能手", hint: "累计整理7天" },
  { id: "helper", icon: "🙌", name: "劳动小帮手", hint: "累计帮助家人7天" },
  { id: "streak", icon: "🔥", name: "坚持之星", hint: "连续打卡7天" },
  { id: "hundred", icon: "🏆", name: "暑假成长家", hint: "累计完成100项" },
];

const defaultTasks: Task[] = [
  { id: "read", title: "阅读20分钟", icon: "📖", category: "reading", coins: 10, xp: 5, active: true, proofPrompt: "写下今天读的书名和页码", requiresProof: true },
  { id: "write", title: "练字一页", icon: "✍️", category: "writing", coins: 10, xp: 5, active: true, proofPrompt: "写下练习内容，把练字本交给家长", requiresProof: true },
  { id: "sport", title: "运动30分钟", icon: "⚽", category: "sport", coins: 10, xp: 5, active: true, proofPrompt: "完成后可以一键提交", requiresProof: false },
  { id: "homework", title: "完成暑假作业", icon: "📝", category: "homework", coins: 10, xp: 5, active: true, proofPrompt: "写下完成了哪一页或哪几题", requiresProof: true },
  { id: "tidy", title: "整理自己的物品", icon: "🧸", category: "tidy", coins: 10, xp: 5, active: true, proofPrompt: "完成后可以一键提交", requiresProof: false },
  { id: "help", title: "帮家里做一件小事", icon: "🧹", category: "help", coins: 10, xp: 5, active: true, proofPrompt: "完成后可以一键提交", requiresProof: false },
  { id: "sleep", title: "21:30前准备睡觉", icon: "🌙", category: "sleep", coins: 10, xp: 5, active: true, proofPrompt: "完成后可以一键提交", requiresProof: false },
];

const encouragements = [
  "做得真棒！",
  "又完成一项！",
  "今天也有进步！",
  "小主人，我也在长大！",
  "坚持就是胜利！",
];

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatChineseDate(date = new Date()) {
  const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日 · ${weekday}`;
}

function getLevel(totalXp: number) {
  return Math.floor(Math.max(0, totalXp) / 50) + 1;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

function totalCompleted(data: GameData) {
  return Object.values(data.records).reduce((sum, record) => sum + record.completed.length, 0);
}

function categoryDays(data: GameData, category: TaskCategory) {
  return Object.values(data.records).filter((record) =>
    Object.values(record.rewards).some((reward) => reward.category === category),
  ).length;
}

function calculateStreak(records: GameData["records"], today = new Date()) {
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!records[localDateKey(cursor)]?.completed.length) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (records[localDateKey(cursor)]?.completed.length) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function achievedBadges(data: GameData) {
  const achieved: string[] = [];
  if (totalCompleted(data) >= 1) achieved.push("first");
  if (categoryDays(data, "reading") >= 7) achieved.push("reader");
  if (categoryDays(data, "sport") >= 7) achieved.push("sport");
  if (categoryDays(data, "tidy") >= 7) achieved.push("tidy");
  if (categoryDays(data, "help") >= 7) achieved.push("helper");
  if (calculateStreak(data.records) >= 7) achieved.push("streak");
  if (totalCompleted(data) >= 100) achieved.push("hundred");
  return achieved;
}

function groupPendingSubmissions(submissions: GameData["submissions"]) {
  const groups = new Map<string, GameData["submissions"]>();
  submissions.forEach((submission) => {
    const group = groups.get(submission.date) ?? [];
    group.push(submission);
    groups.set(submission.date, group);
  });
  return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left));
}

const rewardCategoryLabels: Record<RealRewardCategory, string> = {
  privilege: "小特权",
  family: "家庭时光",
  outing: "外出活动",
  gift: "实物礼物",
};

const rewardCategoryImages: Record<RealRewardCategory, string> = {
  privilege: "/reward-categories/privilege.png",
  family: "/reward-categories/family.png",
  outing: "/reward-categories/outing.png",
  gift: "/reward-categories/gift.png",
};

function playTone(enabled: boolean, high = false) {
  if (!enabled || typeof window === "undefined") return;
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = high ? 660 : 520;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
  } catch {
    // Sound is a bonus; the game remains fully usable without it.
  }
}

function downloadTextFile(contents: string, filename: string) {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function PetApp() {
  const [data, setData] = useState<GameData>(() => createInitialGameData(defaultTasks));
  const [hydrated, setHydrated] = useState(false);
  const [storageIssue, setStorageIssue] = useState<DataSafetyError | null>(null);
  const [saveIssue, setSaveIssue] = useState("");
  const [migrationNotice, setMigrationNotice] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [tab, setTab] = useState<Tab>("today");
  const [toast, setToast] = useState("");
  const [celebrating, setCelebrating] = useState(false);
  const [parentStage, setParentStage] = useState<"closed" | "setup" | "challenge" | "open">("closed");
  const [pinInput, setPinInput] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [parentError, setParentError] = useState("");
  const [newTask, setNewTask] = useState("");
  const [submissionTask, setSubmissionTask] = useState<Task | null>(null);
  const [proofNote, setProofNote] = useState("");
  const [pendingBuy, setPendingBuy] = useState<VirtualShopItem | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<AvatarCatalogItem | null>(null);
  const [pendingReward, setPendingReward] = useState<RealReward | null>(null);
  const [reviewSelection, setReviewSelection] = useState<Record<string, boolean>>({});
  const [batchConfirmDate, setBatchConfirmDate] = useState<string | null>(null);
  const [newReward, setNewReward] = useState<{
    name: string;
    price: number;
    description: string;
    category: RealRewardCategory;
  }>({ name: "", price: 100, description: "", category: "family" });
  const [resetArmed, setResetArmed] = useState(false);
  const [eyeReminder, setEyeReminder] = useState(false);
  const [installHelp, setInstallHelp] = useState(false);
  const [todayKey, setTodayKey] = useState(() => localDateKey());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTasks = data.tasks.filter((task) => task.active);
  const todayRecord = data.records[todayKey] ?? { completed: [], rewards: {}, fullBonus: false, fullComplete: false };
  const completedCount = activeTasks.filter((task) => todayRecord.completed.includes(task.id)).length;
  const pendingSubmissions = data.submissions.filter((submission) => submission.status === "pending");
  const todayPending = pendingSubmissions.filter((submission) => submission.date === todayKey);
  const pendingClaims = data.rewardClaims.filter((claim) => claim.status === "pending");
  const submissionsByDate = groupPendingSubmissions(pendingSubmissions);
  const fedToday = data.care.fedDates.includes(todayKey);
  const level = getLevel(data.pet.xp);
  const levelProgress = data.pet.xp % 50;
  const streak = calculateStreak(data.records);

  useEffect(() => {
    let cancelled = false;
    loadGameData(defaultTasks)
      .then((result) => {
        if (cancelled) return;
        const careResult = applyMissedFeedPenalties(result.data, localDateKey());
        setData(careResult.data);
        const notices: string[] = [];
        if (result.migratedFrom !== null) {
          notices.push(`历史记录已从数据版本 v${result.migratedFrom} 安全升级到 v${CURRENT_SCHEMA_VERSION}`);
        } else if (result.recoveredFromSnapshot) {
          notices.push("检测到异常数据，已从最近的安全快照恢复");
        }
        if (careResult.appliedDates.length > 0) {
          notices.push(`有 ${careResult.appliedDates.length} 天忘记喂宠物，已按家长规则记录惩罚`);
        }
        setMigrationNotice(notices.join("；"));
        setHydrated(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const issue = error instanceof DataSafetyError
          ? error
          : new DataSafetyError("本地记录暂时无法安全读取，应用已停止写入。");
        setStorageIssue(issue);
        setHydrated(true);
      });

    void navigator.storage?.persist?.().catch(() => false);

    const initialController = Boolean(navigator.serviceWorker?.controller);
    const onControllerChange = () => {
      if (initialController) setUpdateAvailable(true);
    };
    const onServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === "APP_UPDATE_READY") setUpdateAvailable(true);
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
      navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
      navigator.serviceWorker.register("/sw.js").then((registration) => {
        if (registration.waiting) setUpdateAvailable(true);
        void registration.update();
      }).catch(() => undefined);
    }
    fetch("/version.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((versionInfo: { version?: string } | null) => {
        if (!cancelled && versionInfo?.version && versionInfo.version !== APP_VERSION) {
          setUpdateAvailable(true);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        navigator.serviceWorker.removeEventListener("message", onServiceWorkerMessage);
      }
    };
  }, []);

  useEffect(() => {
    if (!hydrated || storageIssue) return;
    queueGameDataSave(data)
      .then(() => setSaveIssue(""))
      .catch(() => setSaveIssue("本次记录暂未保存成功，请先不要关闭应用，并导出一份备份。"));
  }, [data, hydrated, storageIssue]);

  useEffect(() => {
    if (!hydrated || storageIssue) return;
    const reconcileDateAndCare = () => {
      const currentDate = localDateKey();
      setTodayKey(currentDate);
      setData((current) => applyMissedFeedPenalties(current, currentDate).data);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcileDateAndCare();
    };

    reconcileDateAndCare();
    const timer = window.setInterval(reconcileDateAndCare, 60 * 1000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", reconcileDateAndCare);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", reconcileDateAndCare);
    };
  }, [hydrated, storageIssue]);

  useEffect(() => {
    const timer = window.setTimeout(() => setEyeReminder(true), 20 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  };

  const updateWithBadges = (next: GameData, previousBadges: string[]) => {
    const badges = Array.from(new Set([...next.badges, ...achievedBadges(next)]));
    const newlyUnlocked = badges.find((id) => !previousBadges.includes(id));
    if (newlyUnlocked) {
      const badge = badgeDefinitions.find((item) => item.id === newlyUnlocked);
      setTimeout(() => showToast(`获得徽章：${badge?.name ?? "成长徽章"}！`), 200);
    }
    return { ...next, badges };
  };

  const openSubmission = (task: Task) => {
    if (!task.requiresProof) {
      const result = submitTaskForApproval(data, task.id, todayKey, "");
      if (!result.submitted) {
        showToast("这项任务已经提交或验收过了");
        return;
      }
      setData(result.data);
      showToast("已一键提交，等待家长今日批量验收");
      return;
    }
    setSubmissionTask(task);
    setProofNote("");
  };

  const submitTask = () => {
    if (!submissionTask) return;
    const note = proofNote.trim();
    if (submissionTask.requiresProof && note.length < 2) {
      showToast("请先写清楚完成情况");
      return;
    }
    const result = submitTaskForApproval(data, submissionTask.id, todayKey, note);
    if (!result.submitted) {
      showToast("这项任务已经提交或验收过了");
      return;
    }
    setData(result.data);
    setSubmissionTask(null);
    setProofNote("");
    showToast("已提交，等待家长验收");
  };

  const cancelSubmission = (submissionId: string) => {
    setData((current) => ({
      ...current,
      submissions: current.submissions.filter((submission) => submission.id !== submissionId || submission.status !== "pending"),
    }));
    showToast("已撤回这次申请");
  };

  const approveBatch = (date: string, confirmed = false) => {
    const submissions = pendingSubmissions.filter((submission) => submission.date === date);
    const selectedIds = submissions.filter((submission) => reviewSelection[submission.id] !== false).map((submission) => submission.id);
    const unselectedCount = submissions.length - selectedIds.length;
    if (unselectedCount > 0 && !confirmed) {
      setBatchConfirmDate(date);
      return;
    }
    const result = approveTaskSubmissionsBatch(data, date, selectedIds);
    if (result.processed === 0) {
      showToast("这一天没有可处理的任务");
      return;
    }
    setData(updateWithBadges(result.data, data.badges));
    setBatchConfirmDate(null);
    playTone(data.settings.sound, true);
    setCelebrating(true);
    setTimeout(() => setCelebrating(false), data.settings.animations ? 1200 : 0);
    const message = result.rejectedSubmissionIds.length
      ? `已通过 ${result.approvedSubmissionIds.length} 项，退回 ${result.rejectedSubmissionIds.length} 项`
      : `今日任务一次验收完成！${encouragements[(completedCount + data.pet.xp) % encouragements.length]}`;
    showToast(message);
  };

  const undoTask = (task: Task) => {
    setData((current) => revokeTaskApproval(current, task.id, todayKey).data);
    showToast("已取消这次打卡");
  };

  const petAction = (action: "feed" | "bath" | "play" | "pet") => {
    const messages = {
      feed: "吃饱啦，谢谢小主人！",
      bath: "香喷喷，真舒服！",
      play: "一起玩最开心！",
      pet: "我最喜欢你摸摸我！",
    };
    setData((current) => ({
      ...current,
      pet: {
        ...current.pet,
        hunger: clamp(current.pet.hunger + (action === "feed" ? 12 : 0)),
        happiness: clamp(current.pet.happiness + (action === "play" ? 12 : action === "pet" ? 6 : 2)),
      },
      care: action === "feed"
        ? { ...current.care, fedDates: Array.from(new Set([...current.care.fedDates, todayKey])) }
        : current.care,
    }));
    playTone(data.settings.sound);
    setCelebrating(true);
    setTimeout(() => setCelebrating(false), data.settings.animations ? 900 : 0);
    showToast(messages[action]);
  };

  const buyItem = (item: VirtualShopItem) => {
    if (data.pet.coins < item.price) {
      showToast("金币还不够，再完成几个任务吧！");
      return;
    }
    if (item.permanent && data.pet.owned.includes(item.id)) {
      equipItem(item);
      return;
    }
    setPendingBuy(item);
  };

  const confirmBuy = () => {
    if (!pendingBuy) return;
    setData((current) => {
      if (current.pet.coins < pendingBuy.price) return current;
      if (pendingBuy.permanent && current.pet.owned.includes(pendingBuy.id)) return current;
      const owned = pendingBuy.permanent ? [...current.pet.owned, pendingBuy.id] : current.pet.owned;
      return {
        ...current,
        pet: {
          ...current.pet,
          coins: current.pet.coins - pendingBuy.price,
          owned,
          hunger: clamp(current.pet.hunger + (pendingBuy.effect.hunger ?? 0)),
          happiness: clamp(current.pet.happiness + (pendingBuy.effect.happiness ?? 0)),
          equippedClothes: pendingBuy.type === "clothes" ? pendingBuy.id : current.pet.equippedClothes,
          equippedDecor: pendingBuy.type === "decor" ? pendingBuy.id : current.pet.equippedDecor,
        },
        care: pendingBuy.type === "food"
          ? { ...current.care, fedDates: Array.from(new Set([...current.care.fedDates, todayKey])) }
          : current.care,
        transactions: [
          ...current.transactions,
          createTransaction("purchase", {
            coinsDelta: -pendingBuy.price,
            xpDelta: 0,
            heartsDelta: 0,
            note: `兑换：${pendingBuy.name}`,
            itemId: pendingBuy.id,
            itemName: pendingBuy.name,
          }),
        ],
      };
    });
    playTone(data.settings.sound, true);
    showToast(`${pendingBuy.name}到手啦！`);
    setPendingBuy(null);
  };

  const equipItem = (item: VirtualShopItem) => {
    setData((current) => ({
      ...current,
      pet: {
        ...current.pet,
        equippedClothes: item.type === "clothes" ? item.id : current.pet.equippedClothes,
        equippedDecor: item.type === "decor" ? item.id : current.pet.equippedDecor,
      },
    }));
    showToast(`已经换上${item.name}！`);
  };

  const choosePet = (avatarId: AvatarId, nickname: string) => {
    const safeName = nickname.trim().slice(0, 8) || "小布丁";
    setData((current) => {
      const switched = switchAvatar(current, avatarId).data;
      return { ...switched, pet: { ...switched.pet, nickname: safeName, chosen: true } };
    });
    showToast(`你好呀，${safeName}！`);
  };

  const selectAvatar = (avatar: AvatarCatalogItem) => {
    if (data.pet.ownedAvatars.includes(avatar.id)) {
      const result = switchAvatar(data, avatar.id);
      if (result.switched) {
        setData(result.data);
        showToast(`已换成${avatar.name}，成长记录都还在`);
      }
      return;
    }
    if (data.pet.coins < avatar.price) {
      showToast("金币还不够，继续完成任务吧！");
      return;
    }
    setPendingAvatar(avatar);
  };

  const confirmAvatarUnlock = () => {
    if (!pendingAvatar) return;
    const unlocked = unlockAvatar(data, pendingAvatar.id);
    if (!unlocked.unlocked) {
      showToast(data.pet.ownedAvatars.includes(pendingAvatar.id) ? "这个角色已经拥有了" : "金币还不够");
      setPendingAvatar(null);
      return;
    }
    setData(switchAvatar(unlocked.data, pendingAvatar.id).data);
    playTone(data.settings.sound, true);
    showToast(`${pendingAvatar.name}加入冒险小队啦！`);
    setPendingAvatar(null);
  };

  const confirmRealReward = () => {
    if (!pendingReward) return;
    const result = requestRealReward(data, pendingReward.id);
    if (!result.requested) {
      const duplicate = data.rewardClaims.some((claim) => claim.rewardId === pendingReward.id && claim.status === "pending");
      showToast(duplicate ? "这个奖励已经在等待家长兑现" : "金币不够或奖励已停用");
      setPendingReward(null);
      return;
    }
    setData(result.data);
    playTone(data.settings.sound, true);
    showToast("兑换申请已提交，金币已预扣");
    setPendingReward(null);
  };

  const resolveClaim = (claimId: string, resolution: "fulfilled" | "refunded") => {
    const result = resolveRewardClaim(data, claimId, resolution);
    if (!result.resolved) {
      showToast("这条申请已经处理过了");
      return;
    }
    setData(result.data);
    showToast(resolution === "fulfilled" ? "已记录兑现，孩子会看到完成状态" : "已拒绝并按原价退还金币");
  };

  const updateRealReward = (id: string, patch: Partial<RealReward>) => {
    setData((current) => ({
      ...current,
      realRewards: current.realRewards.map((reward) => {
        if (reward.id !== id) return reward;
        const next = { ...reward, ...patch };
        return patch.category
          ? { ...next, image: rewardCategoryImages[patch.category] }
          : next;
      }),
    }));
  };

  const addRealReward = () => {
    const name = newReward.name.trim();
    const description = newReward.description.trim();
    if (!name || !description || newReward.price < 1) {
      showToast("请填好奖励名称、说明和价格");
      return;
    }
    const nextCustomNumber = data.realRewards.reduce((maximum, reward) => {
      const match = /^real-custom-(\d+)$/.exec(reward.id);
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0) + 1;
    const reward: RealReward = {
      id: `real-custom-${nextCustomNumber}`,
      name: name.slice(0, 30),
      price: Math.min(9999, Math.max(1, Math.round(newReward.price))),
      description: description.slice(0, 80),
      category: newReward.category,
      image: rewardCategoryImages[newReward.category],
      active: true,
    };
    setData((current) => ({ ...current, realRewards: [...current.realRewards, reward] }));
    setNewReward({ name: "", price: 100, description: "", category: "family" });
    showToast("新的现实奖励已加入商店");
  };

  const deleteRealReward = (id: string) => {
    if (data.rewardClaims.some((claim) => claim.rewardId === id)) {
      showToast("已有兑换历史，只能停用，不能删除");
      return;
    }
    setData((current) => ({ ...current, realRewards: current.realRewards.filter((reward) => reward.id !== id) }));
    showToast("奖励已删除");
  };

  const openParent = () => {
    setPinInput("");
    setPinConfirm("");
    setParentError("");
    setReviewSelection(Object.fromEntries(pendingSubmissions.map((submission) => [submission.id, true])));
    setBatchConfirmDate(null);
    setParentStage(data.settings.parentPin ? "challenge" : "setup");
  };

  const setCarePenaltyEnabled = (enabled: boolean) => {
    setData((current) => ({
      ...current,
      settings: { ...current.settings, carePenaltyEnabled: enabled },
      care: enabled && !current.settings.carePenaltyEnabled
        ? { ...current.care, startedAtDate: todayKey }
        : current.care,
    }));
  };

  const saveParentPin = () => {
    if (!/^\d{4}$/.test(pinInput)) {
      setParentError("请输入4位数字");
      return;
    }
    if (pinInput !== pinConfirm) {
      setParentError("两次输入不一致");
      return;
    }
    setData((current) => ({ ...current, settings: { ...current.settings, parentPin: pinInput } }));
    setParentStage("open");
    setParentError("");
    setPinInput("");
    setPinConfirm("");
    showToast("家长密码已设置");
  };

  const checkParentPin = () => {
    if (pinInput === data.settings.parentPin) {
      setParentStage("open");
      setParentError("");
      setPinInput("");
    } else {
      setParentError("家长密码不正确");
    }
  };

  const updateTask = (id: string, patch: Partial<Task>) => {
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, ...patch } : task),
    }));
  };

  const moveTask = (id: string, direction: -1 | 1) => {
    setData((current) => {
      const index = current.tasks.findIndex((task) => task.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.tasks.length) return current;
      const tasks = [...current.tasks];
      [tasks[index], tasks[target]] = [tasks[target], tasks[index]];
      return { ...current, tasks };
    });
  };

  const addTask = () => {
    const title = newTask.trim();
    if (!title) return;
    setData((current) => ({
      ...current,
      tasks: [
        ...current.tasks,
        {
          id: `custom-${Date.now()}`,
          title: title.slice(0, 20),
          icon: "⭐",
          category: "custom",
          coins: 10,
          xp: 5,
          active: true,
          proofPrompt: "写下完成情况，交给家长检查",
          requiresProof: true,
        },
      ],
    }));
    setNewTask("");
  };

  const deleteTask = (id: string) => {
    const hasPending = data.submissions.some((submission) =>
      submission.taskId === id && submission.status === "pending"
    );
    const approvedToday = data.records[todayKey]?.completed.includes(id);
    if (hasPending || approvedToday) {
      showToast(hasPending ? "请先处理这项任务的待验收申请" : "请先撤销今天的验收，再删除任务");
      return;
    }
    setData((current) => ({
      ...current,
      tasks: current.tasks.filter((task) => task.id !== id),
      meta: {
        ...current.meta,
        taskTombstones: Array.from(new Set([...current.meta.taskTombstones, id])),
      },
    }));
  };

  const exportData = () => {
    downloadTextFile(JSON.stringify(data, null, 2), `暑假小伙伴备份-${todayKey}.json`);
    showToast("备份文件已经准备好");
  };

  const importData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const imported = await prepareImportedGameData(parsed);
      await snapshotAndReplaceGameData(imported, "before-manual-import");
      setData(imported);
      showToast("记录已经恢复！");
    } catch {
      showToast("这个备份文件无法使用，原记录没有改变");
    }
  };

  const resetData = async () => {
    if (!resetArmed) {
      setResetArmed(true);
      showToast("再点一次，才会清空全部记录");
      return;
    }
    try {
      const initial = createInitialGameData(defaultTasks);
      await snapshotAndReplaceGameData(initial, "before-reset-to-default");
      setData(initial);
      setResetArmed(false);
      setParentStage("closed");
      showToast("已恢复默认设置，旧记录已保留安全快照");
    } catch {
      showToast("无法创建安全快照，已取消恢复默认设置");
    }
  };

  const applyPreparedUpdate = async () => {
    setUpdating(true);
    try {
      await createSafetySnapshot(data, `before-app-update-${APP_VERSION}`);
      await queueGameDataSave(data);
      window.location.reload();
    } catch {
      setUpdating(false);
      showToast("安全快照尚未完成，暂不更新");
    }
  };

  const calendarDays = useMemo(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const count = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return [
      ...Array(first.getDay()).fill(null),
      ...Array.from({ length: count }, (_, index) => index + 1),
    ];
  }, []);

  const pet = avatarCatalog.find((avatar) => avatar.id === data.pet.avatarId) ?? avatarCatalog[0];
  const equippedClothes = virtualShopItems.find((item) => item.id === data.pet.equippedClothes);
  const equippedDecor = virtualShopItems.find((item) => item.id === data.pet.equippedDecor);

  if (!hydrated) {
    return <main className="loading-screen" aria-live="polite"><div className="loading-paw">🐾</div><p>正在叫醒你的小伙伴…</p></main>;
  }

  if (storageIssue) {
    return (
      <main className="safety-screen">
        <section className="safety-card">
          <span className="safety-icon">🛟</span>
          <p className="eyebrow">DATA PROTECTION MODE</p>
          <h1>记录保护模式</h1>
          <p>{storageIssue.message}</p>
          <p>应用没有创建空白记录，也没有覆盖原始数据。请先保存原始记录，再进行修复。</p>
          {storageIssue.rawData && (
            <button onClick={() => downloadTextFile(storageIssue.rawData ?? "", `暑假小伙伴-待修复原始数据-${todayKey}.json`)}>
              下载原始记录
            </button>
          )}
          <small>数据结构版本 v{CURRENT_SCHEMA_VERSION} · 应用版本 {APP_VERSION}</small>
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell ${celebrating && data.settings.animations ? "is-celebrating" : ""}`}>
      <div className="sky-decoration sky-one" />
      <div className="sky-decoration sky-two" />

      {updateAvailable && (
        <aside className="update-banner" role="status">
          <div><span>✨</span><p><strong>新版本已经准备好</strong><small>更新前会自动保存记录和安全快照</small></p></div>
          <button onClick={applyPreparedUpdate} disabled={updating}>{updating ? "正在保护数据…" : "安全更新"}</button>
        </aside>
      )}

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">🐾</div>
          <div>
            <p className="eyebrow">我的暑假小伙伴</p>
            <h1>{tab === "today" ? formatChineseDate() : tab === "home" ? `${data.pet.nickname}的小屋` : tab === "shop" ? "阳光小商店" : "我的成长足迹"}</h1>
          </div>
        </div>
        <button className="parent-button" onClick={openParent} aria-label="打开家长设置">
          ⚙️ <span>家长</span>
        </button>
      </header>

      <section className="status-strip" aria-label="宠物状态">
        <button className="mini-pet" onClick={() => setTab("home")} aria-label={`去看看${data.pet.nickname}`}>
          <img src={pet.image} alt="" />
          <strong>{data.pet.nickname}</strong>
        </button>
        <div className="status-chip"><span>⭐</span><strong>{level}级</strong></div>
        <div className="status-chip coin-chip"><span>🪙</span><strong>{data.pet.coins}</strong></div>
        <div className="status-chip"><span>💗</span><strong>{data.pet.hearts}</strong></div>
        <div className="xp-compact">
          <span>成长 {levelProgress}/50</span>
          <div className="tiny-progress"><i style={{ width: `${levelProgress * 2}%` }} /></div>
        </div>
      </section>

      {(migrationNotice || saveIssue) && (
        <aside className={`data-notice ${saveIssue ? "warning" : ""}`} role="status">
          <span>{saveIssue ? "⚠️" : "🛡️"}</span>
          <p>{saveIssue || migrationNotice}</p>
          {migrationNotice && !saveIssue && <button onClick={() => setMigrationNotice("")} aria-label="关闭提示">×</button>}
        </aside>
      )}

      <div className="page-content">
        {tab === "today" && (
          <section className="today-page page-enter">
            <div className="hero-card">
              <div>
                <p className="hero-kicker">今天的小目标</p>
                <h2>{completedCount === activeTasks.length && activeTasks.length > 0 ? "全部完成，太厉害啦！" : `已经完成 ${completedCount} 项`}</h2>
                <div className="main-progress" aria-label={`今日进度 ${completedCount}/${activeTasks.length}`}>
                  <i style={{ width: `${activeTasks.length ? completedCount / activeTasks.length * 100 : 0}%` }} />
                </div>
                <p className="progress-copy">{completedCount}/{activeTasks.length} · 连续打卡 <strong>{streak}</strong> 天</p>
              </div>
              <div className="hero-pet" aria-hidden="true">
                <span className="sun-ray">☀️</span>
                <img className="hero-pet-face" src={pet.image} alt="" />
              </div>
            </div>

            <div className="section-heading">
              <div><span className="section-label">TODAY</span><h2>今天要做这些事</h2></div>
              <p>重点任务写说明，其他任务一键提交；家长每天批量验收</p>
            </div>

            {activeTasks.length === 0 ? (
              <div className="empty-card">今天没有安排任务，好好享受假期吧！🌈</div>
            ) : (
              <div className="task-grid">
                {activeTasks.map((task) => {
                  const done = todayRecord.completed.includes(task.id);
                  const pending = todayPending.find((submission) => submission.taskId === task.id);
                  return (
                    <article className={`task-card ${done ? "done" : pending ? "pending" : ""}`} key={task.id}>
                      <div className="task-icon" aria-hidden="true">{task.icon}</div>
                      <div className="task-copy">
                        <h3>{task.title}</h3>
                        <p><span>🪙 +{task.coins}</span><span>⭐ +{task.xp}</span></p>
                        <small>{task.requiresProof ? `📝 ${task.proofPrompt}` : "⚡ 完成后可一键提交"}</small>
                      </div>
                      {done ? (
                        <div className="done-button" aria-label={`${task.title}已经家长验收`}>
                          <span>✓</span> 已验收
                          <small>奖励已发放</small>
                        </div>
                      ) : pending ? (
                        <button className="pending-button" onClick={() => cancelSubmission(pending.id)} aria-label={`撤回${task.title}的验收申请`}>
                          <span>⏳</span> 待验收
                          <small>点此撤回</small>
                        </button>
                      ) : (
                        <button className="complete-button" onClick={() => openSubmission(task)}>
                          {task.requiresProof ? "填写并提交" : "一键提交"}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            )}

            <aside className="bonus-note">
              <span>🎁</span>
              <div><strong>全部完成还有惊喜</strong><p>额外获得 {FULL_BONUS_COINS} 枚金币和 1 颗爱心</p></div>
            </aside>
          </section>
        )}

        {tab === "home" && (
          <section className="home-page page-enter">
            <div className={`pet-room decor-${data.pet.equippedDecor ?? "default"}`}>
              <div className="room-window"><span>☁️</span><span>☀️</span></div>
              <div className="room-shelf"><span>📚</span><span>🪴</span></div>
              {equippedDecor && <div className="equipped-decor" aria-label={equippedDecor.name}>{equippedDecor.icon}</div>}
              <button className="big-pet" onClick={() => petAction("pet")} aria-label={`摸摸${data.pet.nickname}`}>
                {equippedClothes && <span className="pet-clothes">{equippedClothes.icon}</span>}
                <img className="pet-emoji" src={pet.image} alt={pet.name} />
                <span className="pet-shadow" />
              </button>
              <div className={`speech-bubble ${fedToday ? "fed" : "hungry"}`}>
                {fedToday ? "今天吃过啦，谢谢小主人！" : "今天还没喂我，别忘记哦！"}
              </div>
              <div className="room-rug" />
            </div>

            <div className="pet-stats">
              <div className="meter-card">
                <div><span>🍎 饱食度</span><strong>{data.pet.hunger}</strong></div>
                <div className="meter orange"><i style={{ width: `${data.pet.hunger}%` }} /></div>
              </div>
              <div className="meter-card">
                <div><span>😊 开心值</span><strong>{data.pet.happiness}</strong></div>
                <div className="meter green"><i style={{ width: `${data.pet.happiness}%` }} /></div>
              </div>
            </div>

            <div className="action-grid">
              <button className={fedToday ? "care-done" : "care-needed"} onClick={() => petAction("feed")}><span>{fedToday ? "✅" : "🍎"}</span><strong>{fedToday ? "今日已喂" : "喂食"}</strong><small>{fedToday ? "再喂也可以" : `漏喂将扣 ${data.settings.missedFeedCoins} 金币`}</small></button>
              <button onClick={() => petAction("bath")}><span>🛁</span><strong>洗澡</strong><small>变得香喷喷</small></button>
              <button onClick={() => petAction("play")}><span>🪀</span><strong>玩耍</strong><small>一起开心玩</small></button>
              <button onClick={() => petAction("pet")}><span>🖐️</span><strong>摸摸它</strong><small>给它一个拥抱</small></button>
            </div>

            {(data.pet.owned.length > 0) && (
              <section className="wardrobe">
                <div className="section-heading compact"><div><span className="section-label">MY ITEMS</span><h2>我的衣柜和装饰</h2></div></div>
                <div className="owned-list">
                  {virtualShopItems.filter((item) => data.pet.owned.includes(item.id)).map((item) => (
                    <button key={item.id} onClick={() => equipItem(item)} className={(item.id === data.pet.equippedClothes || item.id === data.pet.equippedDecor) ? "equipped" : ""}>
                      <span>{item.icon}</span>{item.name}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {data.rewardClaims.length > 0 && (
              <section className="pending-claims-card">
                <div className="section-heading compact">
                  <div><span className="section-label">REAL REWARD STATUS</span><h2>现实奖励进度</h2></div>
                  <p>{pendingClaims.length ? `${pendingClaims.length} 个愿望正在排队` : "最近的奖励都处理完了"}</p>
                </div>
                <div className="pending-claims-list">
                  {[...data.rewardClaims].reverse().slice(0, 6).map((claim) => (
                    <article key={claim.id}>
                      <img src={claim.rewardImage} alt="" />
                      <div><strong>{claim.rewardName}</strong><p>{claim.rewardDescription}</p><small>{claim.price} 金币已预扣</small></div>
                      <span className="claim-status">
                        {claim.status === "pending" ? "⏳ 待兑现" : claim.status === "fulfilled" ? "✅ 已兑现" : "↩️ 已退款"}
                      </span>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </section>
        )}

        {tab === "shop" && (
          <section className="shop-page page-enter">
            <div className="shop-banner">
              <div><span className="section-label">SUNNY SHOP</span><h2>用努力换来的金币<br />解锁伙伴和现实愿望</h2></div>
              <div className="shop-coin"><span>🪙</span><strong>{data.pet.coins}</strong><small>我的金币</small></div>
            </div>

            <section className="avatar-showcase">
              <div className="section-heading compact">
                <div><span className="section-label">AVATAR BOOK</span><h2>冒险伙伴图鉴</h2></div>
                <p>切换外观不会改变昵称、等级、金币或历史</p>
              </div>
              {(["pet", "anime", "eggy"] as const).map((group) => (
                <div className="avatar-group" key={group}>
                  <div className="avatar-group-title">
                    <h3>{group === "pet" ? "宠物原形" : group === "anime" ? "拟人伙伴" : "蛋仔角色"}</h3>
                    <p>{group === "pet" ? "四只原形全部免费" : group === "anime" ? "二次元 Q 版少年冒险小队" : "家庭私用角色"}</p>
                  </div>
                  <div className="avatar-grid">
                    {avatarCatalog.filter((avatar) => avatar.group === group).map((avatar) => {
                      const owned = data.pet.ownedAvatars.includes(avatar.id);
                      const current = data.pet.avatarId === avatar.id;
                      return (
                        <article className={`avatar-card ${current ? "current" : ""}`} key={avatar.id}>
                          <img className="avatar-art" src={avatar.image} alt={avatar.name} />
                          <div>
                            <h4>{avatar.name}</h4>
                            <p>{current ? "现在正在一起冒险" : owned ? "已经加入我的图鉴" : `需要 ${avatar.price} 枚金币解锁`}</p>
                          </div>
                          <button onClick={() => selectAvatar(avatar)} disabled={current || (!owned && data.pet.coins < avatar.price)}>
                            {current ? "正在使用" : owned ? "切换角色" : <>🪙 {avatar.price} 解锁</>}
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="family-ip-note">蛋仔角色仅用于私有家庭站点。《蛋仔派对》角色属于网易商业 IP；若公开仓库或站点，请先替换为原创素材。</p>
            </section>

            {(["food", "toy", "clothes", "decor"] as const).map((type) => (
              <section className="shop-section" key={type}>
                <div className="section-heading compact">
                  <div><h2>{type === "food" ? "好吃的" : type === "toy" ? "好玩的" : type === "clothes" ? "漂亮衣服" : "小屋装饰"}</h2></div>
                  <p>{type === "food" ? "补充饱食度" : type === "toy" ? "增加开心值" : "买一次就永久拥有"}</p>
                </div>
                <div className="shop-grid">
                  {virtualShopItems.filter((item) => item.type === type).map((item) => {
                    const owned = item.permanent && data.pet.owned.includes(item.id);
                    const equipped = item.id === data.pet.equippedClothes || item.id === data.pet.equippedDecor;
                    return (
                      <article className="shop-card" key={item.id}>
                        <div className="shop-icon"><img className="shop-art" src={item.image} alt="" /></div>
                        <h3>{item.name}</h3>
                        <p>{item.description}</p>
                        <button onClick={() => buyItem(item)} disabled={!owned && data.pet.coins < item.price}>
                          {equipped ? "使用中" : owned ? "换上" : <><span>🪙</span> {item.price}</>}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}

            <section className="real-reward-section">
              <div className="section-heading compact">
                <div><span className="section-label">REAL WORLD REWARDS</span><h2>把坚持换成现实里的快乐</h2></div>
                <p>兑换后立即预扣金币，家长兑现或拒绝退款</p>
              </div>
              <div className="reward-grid">
                {data.realRewards.filter((reward) => reward.active).length === 0 && (
                  <div className="review-empty">家长暂时没有开启现实奖励</div>
                )}
                {data.realRewards.filter((reward) => reward.active).map((reward) => {
                  const pending = pendingClaims.some((claim) => claim.rewardId === reward.id);
                  return (
                    <article className={`reward-card ${pending ? "pending" : ""}`} key={reward.id}>
                      <div className="reward-art-wrap"><img className="reward-art" src={reward.image} alt="" /></div>
                      <h3>{reward.name}</h3>
                      <span className="reward-price">🪙 {reward.price} · {rewardCategoryLabels[reward.category]}</span>
                      <p>{reward.description}</p>
                      <button
                        disabled={pending || data.pet.coins < reward.price}
                        onClick={() => setPendingReward(reward)}
                      >
                        {pending ? "已申请，待兑现" : data.pet.coins < reward.price ? "金币还不够" : "申请兑换"}
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          </section>
        )}

        {tab === "growth" && (
          <section className="growth-page page-enter">
            <div className="growth-summary">
              <div className="growth-title"><span className="section-label">SUMMER STORY</span><h2>每一点努力<br />都闪闪发光</h2><p>这个暑假，你已经完成了好多事！</p></div>
              <div className="stat-bubbles">
                <div><strong>{totalCompleted(data)}</strong><span>累计任务</span></div>
                <div><strong>{categoryDays(data, "reading")}</strong><span>阅读天数</span></div>
                <div><strong>{categoryDays(data, "sport")}</strong><span>运动天数</span></div>
                <div><strong>{streak}</strong><span>连续天数</span></div>
              </div>
            </div>

            <section className="calendar-card">
              <div className="calendar-header"><h2>{new Date().getMonth() + 1}月成长日历</h2><p><span>⭐ 全部完成</span><span>● 完成一部分</span></p></div>
              <div className="calendar-grid weekday">
                {["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}
              </div>
              <div className="calendar-grid days">
                {calendarDays.map((day, index) => {
                  if (!day) return <span className="blank" key={`blank-${index}`} />;
                  const date = new Date(new Date().getFullYear(), new Date().getMonth(), day);
                  const record = data.records[localDateKey(date)];
                  const isToday = day === new Date().getDate();
                  return (
                    <span className={`${isToday ? "today" : ""} ${record?.fullComplete ? "full" : record?.completed.length ? "partial" : ""}`} key={day}>
                      <b>{day}</b>{record?.fullComplete ? <i>⭐</i> : record?.completed.length ? <i>●</i> : null}
                    </span>
                  );
                })}
              </div>
            </section>

            <section className="badges-card">
              <div className="section-heading compact"><div><span className="section-label">BADGES</span><h2>我的成长徽章</h2></div><p>{data.badges.length}/{badgeDefinitions.length} 已获得</p></div>
              <div className="badge-grid">
                {badgeDefinitions.map((badge) => {
                  const unlocked = data.badges.includes(badge.id);
                  return (
                    <article className={unlocked ? "unlocked" : "locked"} key={badge.id}>
                      <span>{unlocked ? badge.icon : "🔒"}</span>
                      <strong>{badge.name}</strong>
                      <small>{badge.hint}</small>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="ledger-card">
              <div className="section-heading compact">
                <div><span className="section-label">HISTORY LEDGER</span><h2>成长与兑换流水</h2></div>
                <p>共 {data.transactions.length} 条 · 更新不会删除</p>
              </div>
              <div className="ledger-list">
                {[...data.transactions].reverse().slice(0, 12).map((transaction) => (
                  <article key={transaction.id}>
                    <span className="ledger-icon">
                      {transaction.kind === "purchase" ? "🛍️"
                        : transaction.kind === "care-penalty" ? "🍂"
                          : transaction.kind === "avatar-unlock" ? "🧑‍🚀"
                            : transaction.kind === "real-reward-reserve" ? "🎟️"
                              : transaction.kind === "real-reward-fulfilled" ? "✅"
                                : transaction.kind === "real-reward-refund" ? "↩️"
                                  : transaction.coinsDelta < 0 ? "↩️" : "⭐"}
                    </span>
                    <div><strong>{transaction.note}</strong><small>{transaction.date}</small></div>
                    <p className={transaction.coinsDelta < 0 ? "negative" : "positive"}>
                      {transaction.coinsDelta > 0 ? "+" : ""}{transaction.coinsDelta} 🪙
                      {transaction.xpDelta !== 0 && <small>{transaction.xpDelta > 0 ? "+" : ""}{transaction.xpDelta} 经验</small>}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          </section>
        )}
      </div>

      <nav className="bottom-nav" aria-label="主要页面">
        <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}><span>✅</span><strong>今日</strong></button>
        <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}><span>🏠</span><strong>小屋</strong></button>
        <button className={tab === "shop" ? "active" : ""} onClick={() => setTab("shop")}><span>🛍️</span><strong>商店</strong></button>
        <button className={tab === "growth" ? "active" : ""} onClick={() => setTab("growth")}><span>🌱</span><strong>成长</strong></button>
      </nav>

      {!data.pet.chosen && <PetPicker onChoose={choosePet} />}

      {submissionTask && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="submission-title">
          <div className="modal-card submission-card">
            <button className="modal-close" onClick={() => setSubmissionTask(null)} aria-label="关闭">×</button>
            <span className="modal-icon">{submissionTask.icon}</span>
            <p className="eyebrow">ASK FOR CHECK</p>
            <h2 id="submission-title">申请家长验收</h2>
            <p><strong>{submissionTask.title}</strong></p>
            <label className="proof-field">
              {submissionTask.proofPrompt}
              <textarea
                value={proofNote}
                onChange={(event) => setProofNote(event.target.value.slice(0, 120))}
                placeholder="例如：读了《昆虫记》第12—28页"
                aria-label="完成情况说明"
              />
            </label>
            <p className="reward-hold">家长点“通过”后，才会发放 🪙 {submissionTask.coins} 和 ⭐ {submissionTask.xp}</p>
            <button className="primary-wide" onClick={submitTask}>提交给家长</button>
          </div>
        </div>
      )}

      {parentStage === "setup" && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="parent-setup-title">
          <div className="modal-card challenge-card">
            <button className="modal-close" onClick={() => setParentStage("closed")} aria-label="关闭">×</button>
            <span className="modal-icon">🔐</span>
            <h2 id="parent-setup-title">设置家长密码</h2>
            <p>设置4位数字。以后只有家长能验收任务、修改奖励和惩罚规则。</p>
            <input type="password" autoComplete="new-password" value={pinInput} onChange={(event) => setPinInput(event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" pattern="[0-9]*" aria-label="设置4位家长密码" placeholder="输入4位数字" />
            <input type="password" autoComplete="new-password" value={pinConfirm} onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" pattern="[0-9]*" aria-label="再次输入家长密码" placeholder="再次输入" onKeyDown={(event) => event.key === "Enter" && saveParentPin()} />
            {parentError && <p className="form-error">{parentError}</p>}
            <button className="primary-wide" onClick={saveParentPin}>保存并进入</button>
            <small>密码只保存在这台设备，用于防止孩子自行验收。</small>
          </div>
        </div>
      )}

      {parentStage === "challenge" && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="parent-title">
          <div className="modal-card challenge-card">
            <button className="modal-close" onClick={() => setParentStage("closed")} aria-label="关闭">×</button>
            <span className="modal-icon">🔐</span>
            <h2 id="parent-title">家长验证</h2>
            <p>请输入家长设置的4位密码。</p>
            <input type="password" autoComplete="current-password" value={pinInput} onChange={(event) => setPinInput(event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" pattern="[0-9]*" aria-label="家长密码" onKeyDown={(event) => event.key === "Enter" && checkParentPin()} />
            {parentError && <p className="form-error">{parentError}</p>}
            <button className="primary-wide" onClick={checkParentPin}>进入家长设置</button>
            <small>这能防止孩子自行发奖励，但不是联网账户认证。</small>
          </div>
        </div>
      )}

      {parentStage === "open" && (
        <div className="modal-backdrop parent-backdrop" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="parent-panel">
            <header><div><span className="section-label">FOR PARENTS</span><h2 id="settings-title">家长设置</h2></div><button className="modal-close" onClick={() => setParentStage("closed")} aria-label="关闭">×</button></header>

            <section className="settings-section review-section">
              <div className="review-heading">
                <div><h3>每日一次批量验收</h3><p className="settings-help">默认全选通过；只有任务有问题时才取消勾选。漏审日期会一直保留。</p></div>
                <span>{pendingSubmissions.length}</span>
              </div>
              {pendingSubmissions.length === 0 ? (
                <div className="review-empty">暂时没有待验收任务</div>
              ) : (
                <div className="batch-review-list">
                  {submissionsByDate.map(([date, submissions]) => {
                    const selectedCount = submissions.filter((submission) => reviewSelection[submission.id] !== false).length;
                    const allSelected = selectedCount === submissions.length;
                    const confirming = batchConfirmDate === date;
                    return (
                      <section className="batch-review-group" key={date}>
                        <div className="batch-review-head">
                          <div><h4>{date === todayKey ? `今天 · ${date}` : date}</h4><p>{submissions.length} 项待验收，已选 {selectedCount} 项</p></div>
                          <label className="batch-select-all">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={(event) => setReviewSelection((current) => ({
                                ...current,
                                ...Object.fromEntries(submissions.map((submission) => [submission.id, event.target.checked])),
                              }))}
                            />
                            全选
                          </label>
                        </div>
                        <div className="batch-review-items">
                          {submissions.map((submission) => (
                            <label className="batch-review-item" key={submission.id}>
                              <input
                                type="checkbox"
                                checked={reviewSelection[submission.id] !== false}
                                onChange={(event) => {
                                  setReviewSelection((current) => ({ ...current, [submission.id]: event.target.checked }));
                                  setBatchConfirmDate(null);
                                }}
                              />
                              <div>
                                <strong>{submission.taskTitle}</strong>
                                <small>{submission.proofNote ? "孩子说明" : "普通任务 · 一键提交"}</small>
                                {submission.proofNote && <p>{submission.proofNote}</p>}
                              </div>
                            </label>
                          ))}
                        </div>
                        {confirming && <p className="batch-warning">未勾选的 {submissions.length - selectedCount} 项将统一退回。请再点一次确认。</p>}
                        <button
                          className="batch-approve-button"
                          onClick={() => approveBatch(date, confirming)}
                          disabled={selectedCount === 0 && submissions.length === 0}
                        >
                          {confirming ? "确认通过并退回未选项" : `通过已勾选任务（${selectedCount}）`}
                        </button>
                      </section>
                    );
                  })}
                </div>
              )}
              {todayRecord.completed.length > 0 && (
                <details className="approved-details">
                  <summary>查看今天已验收任务</summary>
                  {data.tasks.filter((task) => todayRecord.completed.includes(task.id)).map((task) => (
                    <div key={task.id}><span>✓ {task.title}</span><button onClick={() => undoTask(task)}>撤销验收</button></div>
                  ))}
                </details>
              )}
            </section>

            <section className="settings-section pet-care-settings">
              <div>
                <h3>当前伙伴和照料规则</h3>
                <p className="settings-help">角色统一在商店图鉴里解锁和切换；换外观不会影响昵称、等级、金币或历史。</p>
                <div className="parent-pet-picker">
                  <button className="selected" onClick={() => {
                    setParentStage("closed");
                    setTab("shop");
                  }}>
                    <img src={pet.image} alt="" /><span>{pet.name} · 打开图鉴</span>
                  </button>
                </div>
              </div>
              <div className="penalty-controls">
                <label className="switch-row"><span>🍎 启用漏喂惩罚</span><input type="checkbox" checked={data.settings.carePenaltyEnabled} onChange={(event) => setCarePenaltyEnabled(event.target.checked)} /></label>
                <label className="penalty-number">每漏喂一天扣金币
                  <input type="number" min="0" max="20" value={data.settings.missedFeedCoins} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, missedFeedCoins: Math.max(0, Math.min(20, Number(event.target.value) || 0)) } }))} />
                </label>
                <p>漏喂还会让饱食度降低15、开心值降低8；金币不会扣成负数，宠物不会死亡。每天只计算一次，关闭期间不会补扣。</p>
              </div>
            </section>

            <section className="settings-section">
              <div className="review-heading">
                <div><h3>现实奖励兑现</h3><p className="settings-help">孩子兑换时已经扣除金币；兑现后留档，拒绝则按兑换原价退款。</p></div>
                <span>{pendingClaims.length}</span>
              </div>
              {pendingClaims.length === 0 ? (
                <div className="review-empty">暂时没有待兑现奖励</div>
              ) : (
                <div className="claim-admin-list">
                  {pendingClaims.map((claim) => (
                    <article className="claim-admin-item" key={claim.id}>
                      <img src={claim.rewardImage} alt="" />
                      <div>
                        <strong>{claim.rewardName}</strong>
                        <p>{claim.rewardDescription}</p>
                        <small>{claim.requestedAt.slice(0, 10)} · 已预扣 {claim.price} 金币</small>
                      </div>
                      <div className="claim-admin-actions">
                        <button className="claim-refund" onClick={() => resolveClaim(claim.id, "refunded")}>拒绝并退款</button>
                        <button className="claim-fulfill" onClick={() => resolveClaim(claim.id, "fulfilled")}>已兑现</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="settings-section">
              <h3>现实奖励商店</h3>
              <p className="settings-help">可修改名称、价格、说明、分类图片和启用状态。已有兑换历史的奖励只能停用，不能删除。</p>
              <div className="reward-admin-list">
                {data.realRewards.map((reward) => {
                  const hasClaims = data.rewardClaims.some((claim) => claim.rewardId === reward.id);
                  return (
                    <div className="reward-admin-item" key={reward.id}>
                      <label>名称<input value={reward.name} onChange={(event) => updateRealReward(reward.id, { name: event.target.value.slice(0, 30) })} /></label>
                      <label>价格<input type="number" min="1" max="9999" step="1" value={reward.price} onChange={(event) => updateRealReward(reward.id, { price: Math.min(9999, Math.max(1, Math.round(Number(event.target.value) || 1))) })} /></label>
                      <label>说明<input value={reward.description} onChange={(event) => updateRealReward(reward.id, { description: event.target.value.slice(0, 80) })} /></label>
                      <label>分类
                        <select value={reward.category} onChange={(event) => updateRealReward(reward.id, { category: event.target.value as RealRewardCategory })}>
                          {(Object.keys(rewardCategoryLabels) as RealRewardCategory[]).map((category) => <option key={category} value={category}>{rewardCategoryLabels[category]}</option>)}
                        </select>
                      </label>
                      <div>
                        <label className="reward-active-toggle"><span>启用</span><input type="checkbox" checked={reward.active} onChange={(event) => updateRealReward(reward.id, { active: event.target.checked })} /></label>
                        <button onClick={() => deleteRealReward(reward.id)} disabled={hasClaims} title={hasClaims ? "已有兑换历史，只能停用" : "删除奖励"}>删除</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="custom-reward-form">
                <label>新奖励名称<input value={newReward.name} onChange={(event) => setNewReward((current) => ({ ...current, name: event.target.value }))} placeholder="例如：选择周末早餐" /></label>
                <label>价格<input type="number" min="1" max="9999" step="1" value={newReward.price} onChange={(event) => setNewReward((current) => ({ ...current, price: Math.min(9999, Math.max(1, Math.round(Number(event.target.value) || 1))) }))} /></label>
                <label>说明<input value={newReward.description} onChange={(event) => setNewReward((current) => ({ ...current, description: event.target.value }))} placeholder="家长兑现时需要知道的内容" /></label>
                <label>分类
                  <select value={newReward.category} onChange={(event) => setNewReward((current) => ({ ...current, category: event.target.value as RealRewardCategory }))}>
                    {(Object.keys(rewardCategoryLabels) as RealRewardCategory[]).map((category) => <option key={category} value={category}>{rewardCategoryLabels[category]}</option>)}
                  </select>
                </label>
                <button className="soft-button" onClick={addRealReward}>＋ 添加奖励</button>
              </div>
            </section>

            <section className="settings-section">
              <h3>每日任务</h3>
              <p className="settings-help">可以修改任务、验收提示、奖励和顺序。历史记录不会被改变。</p>
              <div className="task-editor">
                {data.tasks.map((task, index) => (
                  <div className="task-edit-row" key={task.id}>
                    <button className={`toggle-task ${task.active ? "on" : ""}`} onClick={() => updateTask(task.id, { active: !task.active })} aria-label={`${task.active ? "关闭" : "开启"}${task.title}`}>{task.active ? "✓" : "—"}</button>
                    <input value={task.title} onChange={(event) => updateTask(task.id, { title: event.target.value.slice(0, 20) })} aria-label="任务名称" />
                    <label>金币<input type="number" min="0" max="99" value={task.coins} onChange={(event) => updateTask(task.id, { coins: Math.max(0, Number(event.target.value) || 0) })} /></label>
                    <label>经验<input type="number" min="0" max="99" value={task.xp} onChange={(event) => updateTask(task.id, { xp: Math.max(0, Number(event.target.value) || 0) })} /></label>
                    <div className="row-actions">
                      <button onClick={() => moveTask(task.id, -1)} disabled={index === 0} aria-label="上移">↑</button>
                      <button onClick={() => moveTask(task.id, 1)} disabled={index === data.tasks.length - 1} aria-label="下移">↓</button>
                      <button onClick={() => deleteTask(task.id)} aria-label={`删除${task.title}`}>🗑️</button>
                    </div>
                    <label className="proof-prompt-input">
                      <span className="proof-toggle">
                        <input type="checkbox" checked={task.requiresProof} onChange={(event) => updateTask(task.id, { requiresProof: event.target.checked })} />
                        需要孩子填写完成说明
                      </span>
                      <input disabled={!task.requiresProof} value={task.proofPrompt} onChange={(event) => updateTask(task.id, { proofPrompt: event.target.value.slice(0, 60) })} aria-label={`${task.title}验收提示`} />
                    </label>
                  </div>
                ))}
              </div>
              <div className="add-task">
                <input value={newTask} onChange={(event) => setNewTask(event.target.value)} placeholder="例如：背古诗一首" aria-label="新任务名称" onKeyDown={(event) => event.key === "Enter" && addTask()} />
                <button onClick={addTask}>＋ 添加任务</button>
              </div>
            </section>

            <section className="settings-section settings-two-column">
              <div>
                <h3>使用偏好</h3>
                <label className="switch-row"><span>🔊 音效</span><input type="checkbox" checked={data.settings.sound} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, sound: event.target.checked } }))} /></label>
                <label className="switch-row"><span>✨ 动画</span><input type="checkbox" checked={data.settings.animations} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, animations: event.target.checked } }))} /></label>
                <button className="soft-button" onClick={() => {
                  setPinInput("");
                  setPinConfirm("");
                  setParentStage("setup");
                }}>🔐 重设家长密码</button>
                <button className="soft-button" onClick={() => setInstallHelp(true)}>📲 iPad安装方法</button>
              </div>
              <div>
                <h3>记录与备份</h3>
                <button className="soft-button" onClick={exportData}>⬇️ 导出备份</button>
                <label className="soft-button upload-button">⬆️ 恢复备份<input type="file" accept="application/json,.json" onChange={importData} /></label>
                <button className="soft-button" onClick={() => window.print()}>🖨️ 打印成长记录</button>
              </div>
            </section>

            <section className="settings-section data-safety-section">
              <div className="data-safety-heading">
                <span className="safety-shield">🛡️</span>
                <div>
                  <h3>数据安全与升级</h3>
                  <p>应用版本 {APP_VERSION} · 数据结构 v{CURRENT_SCHEMA_VERSION} · 已保存 {data.transactions.length} 条收支流水</p>
                </div>
              </div>
              <ul>
                <li>程序更新只替换界面和功能，不会清除 IndexedDB 中的打卡、金币和兑换记录。</li>
                <li>每次数据迁移、导入、重置和版本更新前都会先创建本地安全快照。</li>
                <li>必须长期使用同一个网址；更换域名后，浏览器不会自动带入原网址的数据。</li>
              </ul>
              <p className="backup-reminder"><strong>建议每周导出一次备份，保存到 iPad“文件”或 iCloud Drive。</strong> 删除应用、清除 Safari 网站数据或设备损坏仍可能清除纯本地记录。</p>
            </section>

            <section className="settings-section danger-zone">
              <h3>恢复默认设置</h3>
              <p>会把当前界面恢复为初始状态；操作前会保留一份内部安全快照。</p>
              <button onClick={resetData}>{resetArmed ? "确认清空全部记录" : "恢复默认设置"}</button>
            </section>
          </div>
        </div>
      )}

      {pendingBuy && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="buy-title">
          <div className="modal-card buy-card">
            <img className="reward-confirm-art" src={pendingBuy.image} alt="" />
            <h2 id="buy-title">带走{pendingBuy.name}？</h2>
            <p>需要使用 <strong>{pendingBuy.price}</strong> 枚金币</p>
            <div className="modal-actions"><button onClick={() => setPendingBuy(null)}>再想想</button><button className="primary-wide" onClick={confirmBuy}>确认购买</button></div>
          </div>
        </div>
      )}

      {pendingAvatar && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="avatar-unlock-title">
          <div className="modal-card buy-card">
            <img className="reward-confirm-art" src={pendingAvatar.image} alt="" />
            <h2 id="avatar-unlock-title">让{pendingAvatar.name}加入小队？</h2>
            <p>一次解锁需要 <strong>{pendingAvatar.price}</strong> 枚金币，以后可以随时切换。</p>
            <div className="modal-actions"><button onClick={() => setPendingAvatar(null)}>再想想</button><button className="primary-wide" onClick={confirmAvatarUnlock}>确认解锁</button></div>
          </div>
        </div>
      )}

      {pendingReward && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reward-request-title">
          <div className="modal-card buy-card">
            <img className="reward-confirm-art" src={pendingReward.image} alt="" />
            <h2 id="reward-request-title">申请兑换“{pendingReward.name}”？</h2>
            <p>{pendingReward.description}</p>
            <p>现在会预扣 <strong>{pendingReward.price}</strong> 枚金币。家长兑现后留档；如果拒绝，会自动按原价退款。</p>
            <div className="modal-actions"><button onClick={() => setPendingReward(null)}>再想想</button><button className="primary-wide" onClick={confirmRealReward}>确认申请</button></div>
          </div>
        </div>
      )}

      {eyeReminder && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="eye-title">
          <div className="modal-card eye-card">
            <span className="modal-icon">🌳</span><h2 id="eye-title">让眼睛休息一下吧</h2><p>看看远处，眨眨眼睛，过一会儿再回来。</p>
            <button className="primary-wide" onClick={() => setEyeReminder(false)}>好，我去休息</button>
          </div>
        </div>
      )}

      {installHelp && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="install-title">
          <div className="modal-card install-card">
            <button className="modal-close" onClick={() => setInstallHelp(false)} aria-label="关闭">×</button>
            <span className="modal-icon">📲</span><h2 id="install-title">安装到 iPad</h2>
            <ol><li>用 Safari 打开这个页面</li><li>点击浏览器顶部的“分享”按钮</li><li>选择“添加到主屏幕”</li><li>以后点桌面图标就能打开</li></ol>
            <p>第一次成功打开后，断网也能继续打卡。</p>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
      {celebrating && data.settings.animations && <div className="confetti" aria-hidden="true"><i>⭐</i><i>💛</i><i>✨</i><i>🌈</i><i>⭐</i></div>}
    </main>
  );
}

function PetPicker({ onChoose }: { onChoose: (avatarId: AvatarId, nickname: string) => void }) {
  const [avatarId, setAvatarId] = useState<AvatarId>("pet-snake");
  const [name, setName] = useState("小青");
  const freeAvatars = avatarCatalog.filter((avatar) => freeAvatarIds.includes(avatar.id));
  return (
    <div className="modal-backdrop welcome-backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="welcome-card">
        <span className="welcome-sun">☀️</span>
        <p className="eyebrow">WELCOME, LITTLE EXPLORER</p>
        <h2 id="welcome-title">选一个暑假小伙伴</h2>
        <p>先从五位免费伙伴中选一位，之后还可以在图鉴里切换。</p>
        <div className="pet-options">
          {freeAvatars.map((avatar) => (
            <button
              key={avatar.id}
              className={avatarId === avatar.id ? "selected" : ""}
              onClick={() => {
                setAvatarId(avatar.id);
                setName(avatar.defaultNickname);
              }}
            >
              <img src={avatar.image} alt="" /><strong>{avatar.name}</strong><i>{avatarId === avatar.id ? "✓" : ""}</i>
            </button>
          ))}
        </div>
        <label className="name-field">给它取个名字<input value={name} onChange={(event) => setName(event.target.value.slice(0, 8))} placeholder="最多8个字" /></label>
        <button className="start-button" onClick={() => onChoose(avatarId, name)}>一起开始暑假冒险！</button>
        <small>不需要注册，也不会收集个人信息</small>
      </div>
    </div>
  );
}
