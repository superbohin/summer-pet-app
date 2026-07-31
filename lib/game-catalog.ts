export type AvatarId =
  | "pet-dog"
  | "pet-cat"
  | "pet-snake"
  | "pet-dino"
  | "anime-dog"
  | "anime-cat"
  | "anime-snake"
  | "anime-dino"
  | "anime-girl-star"
  | "anime-girl-bloom"
  | "anime-girl-ocean"
  | "anime-girl-moon"
  | "eggy-yellow"
  | "eggy-heart-bear"
  | "eggy-zai-bear"
  | "eggy-blue-cap";

export type AvatarGroup = "pet" | "anime" | "eggy";

export type AvatarCatalogItem = {
  id: AvatarId;
  name: string;
  group: AvatarGroup;
  defaultNickname: string;
  image: string;
  price: number;
};

export const avatarCatalog: readonly AvatarCatalogItem[] = [
  { id: "pet-dog", name: "阳光小狗", group: "pet", defaultNickname: "小布丁", image: "/pets/dog-v2.png", price: 0 },
  { id: "pet-cat", name: "星夜小猫", group: "pet", defaultNickname: "小月亮", image: "/pets/cat-v2.png", price: 0 },
  { id: "pet-snake", name: "翡翠小蛇", group: "pet", defaultNickname: "小青", image: "/pets/snake-v2.png", price: 0 },
  { id: "pet-dino", name: "森林恐龙", group: "pet", defaultNickname: "小绿豆", image: "/pets/dino-v2.png", price: 0 },
  { id: "anime-dog", name: "阳光犬系少年", group: "anime", defaultNickname: "阿阳", image: "/avatars/anime-dog.png", price: 180 },
  { id: "anime-cat", name: "冷静猫系少年", group: "anime", defaultNickname: "小凛", image: "/avatars/anime-cat.png", price: 200 },
  { id: "anime-snake", name: "翡翠蛇系少年", group: "anime", defaultNickname: "青岚", image: "/avatars/anime-snake.png", price: 220 },
  { id: "anime-dino", name: "活力恐龙少年", group: "anime", defaultNickname: "小龙", image: "/avatars/anime-dino.png", price: 240 },
  { id: "anime-girl-star", name: "星月魔法师", group: "anime", defaultNickname: "星遥", image: "/avatars/anime-girl-star.png", price: 260 },
  { id: "anime-girl-bloom", name: "樱花向导", group: "anime", defaultNickname: "花铃", image: "/avatars/anime-girl-bloom.png", price: 280 },
  { id: "anime-girl-ocean", name: "海蓝乐师", group: "anime", defaultNickname: "澜音", image: "/avatars/anime-girl-ocean.png", price: 300 },
  { id: "anime-girl-moon", name: "银月骑士", group: "anime", defaultNickname: "月澄", image: "/avatars/anime-girl-moon.png", price: 320 },
  { id: "eggy-yellow", name: "蛋小黄", group: "eggy", defaultNickname: "蛋小黄", image: "/avatars/eggy-yellow.png", price: 0 },
  { id: "eggy-heart-bear", name: "失心熊", group: "eggy", defaultNickname: "失心熊", image: "/avatars/eggy-heart-bear.png", price: 260 },
  { id: "eggy-zai-bear", name: "仔仔熊", group: "eggy", defaultNickname: "仔仔熊", image: "/avatars/eggy-zai-bear.png", price: 280 },
  { id: "eggy-blue-cap", name: "小蓝帽", group: "eggy", defaultNickname: "小蓝帽", image: "/avatars/eggy-blue-cap.png", price: 300 },
];

export const freeAvatarIds: readonly AvatarId[] = [
  "pet-dog",
  "pet-cat",
  "pet-snake",
  "pet-dino",
  "eggy-yellow",
];

export type VirtualShopItemType = "food" | "toy" | "clothes" | "decor";

export type VirtualShopItem = {
  id: string;
  name: string;
  icon: string;
  image: string;
  price: number;
  type: VirtualShopItemType;
  description: string;
  permanent: boolean;
  effect: {
    hunger?: number;
    happiness?: number;
  };
};

export const virtualShopItems: readonly VirtualShopItem[] = [
  { id: "apple", name: "脆脆苹果", icon: "🍎", image: "/shop/apple.png", price: 8, type: "food", description: "饱食度 +12", permanent: false, effect: { hunger: 12 } },
  { id: "cake", name: "星星蛋糕", icon: "🧁", image: "/shop/cake.png", price: 16, type: "food", description: "饱食度 +25", permanent: false, effect: { hunger: 25 } },
  { id: "ball", name: "彩虹皮球", icon: "⚽", image: "/shop/ball.png", price: 25, type: "toy", description: "开心值 +20", permanent: false, effect: { happiness: 20 } },
  { id: "blocks", name: "积木小城", icon: "🧱", image: "/shop/blocks.png", price: 35, type: "toy", description: "开心值 +28", permanent: false, effect: { happiness: 28 } },
  { id: "cape", name: "勇气披风", icon: "🦸", image: "/shop/cape.png", price: 45, type: "clothes", description: "穿上它去冒险", permanent: true, effect: {} },
  { id: "hat", name: "夏日草帽", icon: "👒", image: "/shop/hat.png", price: 40, type: "clothes", description: "清凉又神气", permanent: true, effect: {} },
  { id: "plant", name: "向日葵盆栽", icon: "🌻", image: "/shop/plant.png", price: 50, type: "decor", description: "小屋充满阳光", permanent: true, effect: {} },
  { id: "tent", name: "星空帐篷", icon: "⛺", image: "/shop/tent.png", price: 65, type: "decor", description: "在家也能露营", permanent: true, effect: {} },
];

export type RealRewardCategory = "privilege" | "family" | "outing" | "gift";

export type RealRewardCatalogItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  category: RealRewardCategory;
  image: string;
  active: boolean;
};

export const defaultRealRewards: readonly RealRewardCatalogItem[] = [
  { id: "real-family-menu", name: "选择一次家庭餐单", description: "今天的一餐由我来选", price: 80, category: "family", image: "/reward-categories/family.png", active: true },
  { id: "real-game-time", name: "周末额外游戏20分钟", description: "周末增加20分钟游戏时间", price: 90, category: "privilege", image: "/reward-categories/privilege.png", active: true },
  { id: "real-family-movie", name: "选择一次家庭电影或桌游", description: "全家一起看我选的电影或玩桌游", price: 120, category: "family", image: "/reward-categories/family.png", active: true },
  { id: "real-snack", name: "喜欢的零食或冰淇淋", description: "兑换一份喜欢的小点心", price: 140, category: "family", image: "/reward-categories/family.png", active: true },
  { id: "real-park-day", name: "公园、骑车或野餐活动", description: "选择一次户外家庭活动", price: 220, category: "outing", image: "/reward-categories/outing.png", active: true },
  { id: "real-book", name: "30元以内喜欢的图书", description: "挑选一本30元以内的图书", price: 320, category: "gift", image: "/reward-categories/gift.png", active: true },
  { id: "real-stationery", name: "30元以内文具或小玩具", description: "挑选一件30元以内的文具或小玩具", price: 420, category: "gift", image: "/reward-categories/gift.png", active: true },
  { id: "real-eggy-gift", name: "50元以内蛋仔小礼物", description: "挑选一件50元以内的蛋仔小礼物", price: 520, category: "gift", image: "/reward-categories/gift.png", active: true },
  { id: "real-special-day", name: "电影、科技馆、游泳等特别活动", description: "选择一次需要提前安排的特别活动", price: 630, category: "outing", image: "/reward-categories/outing.png", active: true },
];
