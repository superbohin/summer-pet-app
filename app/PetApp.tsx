"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  APP_VERSION,
  CURRENT_SCHEMA_VERSION,
  DataSafetyError,
  FULL_BONUS_COINS,
  createInitialGameData,
  createSafetySnapshot,
  createTransaction,
  loadGameData,
  prepareImportedGameData,
  queueGameDataSave,
  snapshotAndReplaceGameData,
  type GameData,
  type PetType,
  type Task,
  type TaskCategory,
} from "../lib/game-data";

type Tab = "today" | "home" | "shop" | "growth";

type ShopItem = {
  id: string;
  name: string;
  icon: string;
  price: number;
  type: "food" | "toy" | "clothes" | "decor";
  description: string;
  permanent: boolean;
};

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
  { id: "read", title: "阅读20分钟", icon: "📖", category: "reading", coins: 10, xp: 5, active: true },
  { id: "write", title: "练字一页", icon: "✍️", category: "writing", coins: 10, xp: 5, active: true },
  { id: "sport", title: "运动30分钟", icon: "⚽", category: "sport", coins: 10, xp: 5, active: true },
  { id: "homework", title: "完成暑假作业", icon: "📝", category: "homework", coins: 10, xp: 5, active: true },
  { id: "tidy", title: "整理自己的物品", icon: "🧸", category: "tidy", coins: 10, xp: 5, active: true },
  { id: "help", title: "帮家里做一件小事", icon: "🧹", category: "help", coins: 10, xp: 5, active: true },
  { id: "sleep", title: "21:30前准备睡觉", icon: "🌙", category: "sleep", coins: 10, xp: 5, active: true },
];

const shopItems: ShopItem[] = [
  { id: "apple", name: "脆脆苹果", icon: "🍎", price: 8, type: "food", description: "饱食度 +12", permanent: false },
  { id: "cake", name: "星星蛋糕", icon: "🧁", price: 16, type: "food", description: "饱食度 +25", permanent: false },
  { id: "ball", name: "彩虹皮球", icon: "⚽", price: 25, type: "toy", description: "开心值 +20", permanent: false },
  { id: "blocks", name: "积木小城", icon: "🧱", price: 35, type: "toy", description: "开心值 +28", permanent: false },
  { id: "cape", name: "勇气披风", icon: "🦸", price: 45, type: "clothes", description: "穿上它去冒险", permanent: true },
  { id: "hat", name: "夏日草帽", icon: "👒", price: 40, type: "clothes", description: "清凉又神气", permanent: true },
  { id: "plant", name: "向日葵盆栽", icon: "🌻", price: 50, type: "decor", description: "小屋充满阳光", permanent: true },
  { id: "tent", name: "星空帐篷", icon: "⛺", price: 65, type: "decor", description: "在家也能露营", permanent: true },
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

function petFace(type: PetType) {
  if (type === "cat") return { emoji: "🐱", label: "小猫" };
  if (type === "dino") return { emoji: "🦖", label: "小恐龙" };
  return { emoji: "🐶", label: "小狗" };
}

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
  const [parentStage, setParentStage] = useState<"closed" | "challenge" | "open">("closed");
  const [answer, setAnswer] = useState("");
  const [parentError, setParentError] = useState("");
  const [newTask, setNewTask] = useState("");
  const [pendingBuy, setPendingBuy] = useState<ShopItem | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [eyeReminder, setEyeReminder] = useState(false);
  const [installHelp, setInstallHelp] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const todayKey = localDateKey();
  const activeTasks = data.tasks.filter((task) => task.active);
  const todayRecord = data.records[todayKey] ?? { completed: [], rewards: {}, fullBonus: false, fullComplete: false };
  const completedCount = activeTasks.filter((task) => todayRecord.completed.includes(task.id)).length;
  const level = getLevel(data.pet.xp);
  const levelProgress = data.pet.xp % 50;
  const streak = calculateStreak(data.records);

  useEffect(() => {
    let cancelled = false;
    loadGameData(defaultTasks)
      .then((result) => {
        if (cancelled) return;
        setData(result.data);
        if (result.migratedFrom !== null) {
          setMigrationNotice(`历史记录已从数据版本 v${result.migratedFrom} 安全升级到 v${CURRENT_SCHEMA_VERSION}`);
        } else if (result.recoveredFromSnapshot) {
          setMigrationNotice("检测到异常数据，已从最近的安全快照恢复");
        }
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

  const completeTask = (task: Task) => {
    if (todayRecord.completed.includes(task.id)) return;
    setData((current) => {
      const record = current.records[todayKey] ?? { completed: [], rewards: {}, fullBonus: false, fullComplete: false };
      if (record.completed.includes(task.id)) return current;
      const completed = [...record.completed, task.id];
      const currentActive = current.tasks.filter((item) => item.active);
      const isFull = currentActive.length > 0 && currentActive.every((item) => completed.includes(item.id));
      const grantBonus = isFull && !record.fullBonus;
      const next: GameData = {
        ...current,
        pet: {
          ...current.pet,
          coins: current.pet.coins + task.coins + (grantBonus ? FULL_BONUS_COINS : 0),
          xp: current.pet.xp + task.xp,
          hearts: current.pet.hearts + (grantBonus ? 1 : 0),
        },
        records: {
          ...current.records,
          [todayKey]: {
            completed,
            rewards: {
              ...record.rewards,
              [task.id]: { title: task.title, category: task.category, coins: task.coins, xp: task.xp },
            },
            fullBonus: record.fullBonus || grantBonus,
            fullComplete: isFull,
          },
        },
        transactions: [
          ...current.transactions,
          createTransaction("task-reward", {
            coinsDelta: task.coins,
            xpDelta: task.xp,
            heartsDelta: 0,
            note: `完成：${task.title}`,
            taskId: task.id,
          }),
          ...(grantBonus ? [
            createTransaction("full-bonus", {
              coinsDelta: FULL_BONUS_COINS,
              xpDelta: 0,
              heartsDelta: 1,
              note: "今日全勤奖励",
            }),
          ] : []),
        ],
      };
      return updateWithBadges(next, current.badges);
    });
    playTone(data.settings.sound, true);
    setCelebrating(true);
    setTimeout(() => setCelebrating(false), data.settings.animations ? 1200 : 0);
    showToast(encouragements[(completedCount + data.pet.xp) % encouragements.length]);
  };

  const undoTask = (task: Task) => {
    setData((current) => {
      const record = current.records[todayKey];
      const reward = record?.rewards[task.id];
      if (!record || !reward) return current;
      const completed = record.completed.filter((id) => id !== task.id);
      const rewards = { ...record.rewards };
      delete rewards[task.id];
      const removeBonus = record.fullBonus;
      return {
        ...current,
        pet: {
          ...current.pet,
          coins: Math.max(0, current.pet.coins - reward.coins - (removeBonus ? FULL_BONUS_COINS : 0)),
          xp: Math.max(0, current.pet.xp - reward.xp),
          hearts: Math.max(0, current.pet.hearts - (removeBonus ? 1 : 0)),
        },
        records: {
          ...current.records,
          [todayKey]: { completed, rewards, fullBonus: false, fullComplete: false },
        },
        transactions: [
          ...current.transactions,
          createTransaction("task-undo", {
            coinsDelta: -reward.coins,
            xpDelta: -reward.xp,
            heartsDelta: 0,
            note: `取消打卡：${reward.title}`,
            taskId: task.id,
          }),
          ...(removeBonus ? [
            createTransaction("bonus-reversal", {
              coinsDelta: -FULL_BONUS_COINS,
              xpDelta: 0,
              heartsDelta: -1,
              note: "取消今日全勤奖励",
            }),
          ] : []),
        ],
      };
    });
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
    }));
    playTone(data.settings.sound);
    setCelebrating(true);
    setTimeout(() => setCelebrating(false), data.settings.animations ? 900 : 0);
    showToast(messages[action]);
  };

  const buyItem = (item: ShopItem) => {
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
          hunger: clamp(current.pet.hunger + (pendingBuy.type === "food" ? (pendingBuy.id === "cake" ? 25 : 12) : 0)),
          happiness: clamp(current.pet.happiness + (pendingBuy.type === "toy" ? (pendingBuy.id === "blocks" ? 28 : 20) : 0)),
          equippedClothes: pendingBuy.type === "clothes" ? pendingBuy.id : current.pet.equippedClothes,
          equippedDecor: pendingBuy.type === "decor" ? pendingBuy.id : current.pet.equippedDecor,
        },
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

  const equipItem = (item: ShopItem) => {
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

  const choosePet = (type: PetType, nickname: string) => {
    const safeName = nickname.trim().slice(0, 8) || "小布丁";
    setData((current) => ({ ...current, pet: { ...current.pet, type, nickname: safeName, chosen: true } }));
    showToast(`你好呀，${safeName}！`);
  };

  const openParent = () => {
    setAnswer("");
    setParentError("");
    setParentStage("challenge");
  };

  const checkParentAnswer = () => {
    if (answer.trim() === "21") {
      setParentStage("open");
      setParentError("");
    } else {
      setParentError("再算一算，答案不对哦");
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
        { id: `custom-${Date.now()}`, title: title.slice(0, 20), icon: "⭐", category: "custom", coins: 10, xp: 5, active: true },
      ],
    }));
    setNewTask("");
  };

  const deleteTask = (id: string) => {
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

  const pet = petFace(data.pet.type);
  const equippedClothes = shopItems.find((item) => item.id === data.pet.equippedClothes);
  const equippedDecor = shopItems.find((item) => item.id === data.pet.equippedDecor);

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
          <span>{pet.emoji}</span>
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
                <span className="hero-pet-face">{pet.emoji}</span>
              </div>
            </div>

            <div className="section-heading">
              <div><span className="section-label">TODAY</span><h2>今天要做这些事</h2></div>
              <p>每完成一项，就向前走一步</p>
            </div>

            {activeTasks.length === 0 ? (
              <div className="empty-card">今天没有安排任务，好好享受假期吧！🌈</div>
            ) : (
              <div className="task-grid">
                {activeTasks.map((task) => {
                  const done = todayRecord.completed.includes(task.id);
                  return (
                    <article className={`task-card ${done ? "done" : ""}`} key={task.id}>
                      <div className="task-icon" aria-hidden="true">{task.icon}</div>
                      <div className="task-copy">
                        <h3>{task.title}</h3>
                        <p><span>🪙 +{task.coins}</span><span>⭐ +{task.xp}</span></p>
                      </div>
                      {done ? (
                        <button className="done-button" onClick={() => undoTask(task)} aria-label={`${task.title}已完成，点击取消`}>
                          <span>✓</span> 完成啦
                          <small>点此取消</small>
                        </button>
                      ) : (
                        <button className="complete-button" onClick={() => completeTask(task)}>完成</button>
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
                <span className="pet-emoji">{pet.emoji}</span>
                <span className="pet-shadow" />
              </button>
              <div className="speech-bubble">小主人，今天想一起做什么？</div>
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
              <button onClick={() => petAction("feed")}><span>🍎</span><strong>喂食</strong><small>填饱小肚子</small></button>
              <button onClick={() => petAction("bath")}><span>🛁</span><strong>洗澡</strong><small>变得香喷喷</small></button>
              <button onClick={() => petAction("play")}><span>🪀</span><strong>玩耍</strong><small>一起开心玩</small></button>
              <button onClick={() => petAction("pet")}><span>🖐️</span><strong>摸摸它</strong><small>给它一个拥抱</small></button>
            </div>

            {(data.pet.owned.length > 0) && (
              <section className="wardrobe">
                <div className="section-heading compact"><div><span className="section-label">MY ITEMS</span><h2>我的衣柜和装饰</h2></div></div>
                <div className="owned-list">
                  {shopItems.filter((item) => data.pet.owned.includes(item.id)).map((item) => (
                    <button key={item.id} onClick={() => equipItem(item)} className={(item.id === data.pet.equippedClothes || item.id === data.pet.equippedDecor) ? "equipped" : ""}>
                      <span>{item.icon}</span>{item.name}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </section>
        )}

        {tab === "shop" && (
          <section className="shop-page page-enter">
            <div className="shop-banner">
              <div><span className="section-label">SUNNY SHOP</span><h2>用努力换来的金币<br />装扮你的小伙伴</h2></div>
              <div className="shop-coin"><span>🪙</span><strong>{data.pet.coins}</strong><small>我的金币</small></div>
            </div>
            {(["food", "toy", "clothes", "decor"] as const).map((type) => (
              <section className="shop-section" key={type}>
                <div className="section-heading compact">
                  <div><h2>{type === "food" ? "好吃的" : type === "toy" ? "好玩的" : type === "clothes" ? "漂亮衣服" : "小屋装饰"}</h2></div>
                  <p>{type === "food" ? "补充饱食度" : type === "toy" ? "增加开心值" : "买一次就永久拥有"}</p>
                </div>
                <div className="shop-grid">
                  {shopItems.filter((item) => item.type === type).map((item) => {
                    const owned = item.permanent && data.pet.owned.includes(item.id);
                    const equipped = item.id === data.pet.equippedClothes || item.id === data.pet.equippedDecor;
                    return (
                      <article className="shop-card" key={item.id}>
                        <div className="shop-icon">{item.icon}</div>
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
                      {transaction.kind === "purchase" ? "🛍️" : transaction.coinsDelta < 0 ? "↩️" : "⭐"}
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

      {parentStage === "challenge" && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="parent-title">
          <div className="modal-card challenge-card">
            <button className="modal-close" onClick={() => setParentStage("closed")} aria-label="关闭">×</button>
            <span className="modal-icon">🔐</span>
            <h2 id="parent-title">家长验证</h2>
            <p>为了避免小朋友误操作，请回答：</p>
            <strong className="math-question">12 ＋ 9 ＝ ？</strong>
            <input value={answer} onChange={(event) => setAnswer(event.target.value)} inputMode="numeric" pattern="[0-9]*" aria-label="算术题答案" onKeyDown={(event) => event.key === "Enter" && checkParentAnswer()} />
            {parentError && <p className="form-error">{parentError}</p>}
            <button className="primary-wide" onClick={checkParentAnswer}>进入家长设置</button>
            <small>这只是防误触，不是真正的安全认证。</small>
          </div>
        </div>
      )}

      {parentStage === "open" && (
        <div className="modal-backdrop parent-backdrop" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="parent-panel">
            <header><div><span className="section-label">FOR PARENTS</span><h2 id="settings-title">家长设置</h2></div><button className="modal-close" onClick={() => setParentStage("closed")} aria-label="关闭">×</button></header>

            <section className="settings-section">
              <h3>每日任务</h3>
              <p className="settings-help">可以修改名称、奖励和顺序。历史记录不会被改变。</p>
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
            <span className="buy-emoji">{pendingBuy.icon}</span>
            <h2 id="buy-title">带走{pendingBuy.name}？</h2>
            <p>需要使用 <strong>{pendingBuy.price}</strong> 枚金币</p>
            <div className="modal-actions"><button onClick={() => setPendingBuy(null)}>再想想</button><button className="primary-wide" onClick={confirmBuy}>确认购买</button></div>
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

function PetPicker({ onChoose }: { onChoose: (type: PetType, nickname: string) => void }) {
  const [type, setType] = useState<PetType>("dog");
  const [name, setName] = useState("小布丁");
  return (
    <div className="modal-backdrop welcome-backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="welcome-card">
        <span className="welcome-sun">☀️</span>
        <p className="eyebrow">WELCOME, LITTLE EXPLORER</p>
        <h2 id="welcome-title">选一个暑假小伙伴</h2>
        <p>每天完成一点小任务，陪它一起快乐长大！</p>
        <div className="pet-options">
          {(["dog", "cat", "dino"] as const).map((petType) => {
            const pet = petFace(petType);
            return <button key={petType} className={type === petType ? "selected" : ""} onClick={() => setType(petType)}><span>{pet.emoji}</span><strong>{pet.label}</strong><i>{type === petType ? "✓" : ""}</i></button>;
          })}
        </div>
        <label className="name-field">给它取个名字<input value={name} onChange={(event) => setName(event.target.value.slice(0, 8))} placeholder="最多8个字" /></label>
        <button className="start-button" onClick={() => onChoose(type, name)}>一起开始暑假冒险！</button>
        <small>不需要注册，也不会收集个人信息</small>
      </div>
    </div>
  );
}
