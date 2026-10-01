export const character = Object.freeze({ name: "Mira Voss", archetype: "Следопыт", origin: "Северный округ" });
export const updates = Object.freeze([
  { id: "key", kind: "item", text: "Получен предмет «Старинный ключ»", detail: "Добавлен в инвентарь персонажа." },
  { id: "apothecary", kind: "knowledge", text: "Открыто знание «Аптекарь»", detail: "Запись доступна в знаниях персонажа." },
  { id: "letter", kind: "letter", text: "Получено письмо", detail: "Письмо сохранено в журнале." },
]);
export const inventory = Object.freeze([
  { id: "key", name: "Старинный ключ", detail: "Потемневшая латунь. На головке выгравирована маленькая звезда." },
  { id: "notebook", name: "Записная книжка", detail: "Походные записи в мягкой обложке." },
  { id: "amulet", name: "Амулет", detail: "Небольшой камень на потёртом шнурке." },
]);
export const knowledge = Object.freeze([
  { id: "apothecary", name: "Аптекарь", category: "Персонаж мира", detail: "Трактирный лекарь, живущий у старого моста." },
  { id: "tunnels", name: "Северные туннели", category: "Место", detail: "Подземный путь под северным трактом." },
  { id: "symbol", name: "Странный символ", category: "Факт", detail: "Знак встречается на каменных дверях." },
]);
export const notes = Object.freeze([
  { id: "trail", title: "След у переправы", detail: "Вернуться к этому месту перед следующим переходом." },
  { id: "herbs", title: "Слова аптекаря", detail: "Он упомянул редкое растение с синими листьями." },
]);
export const profile = Object.freeze({ description: "Ищет безопасные пути там, где карта заканчивается.", goal: "Узнать, почему закрыли северный тракт." });
export type LabInventoryItem = {
  id: string; name: string; quantity: number; slots: number;
  icon: "key" | "book" | "amulet" | "flask" | "letter" | "medical" | "compass" | "flashlight" | "rope" | "knife" | "jacket" | "lockpicks";
  category: string; rarity: "Обычный" | "Необычный" | "Редкий" | "Уникальный"; rarityKey: "common" | "uncommon" | "rare" | "unique";
  status?: string; action?: string; equipSlot?: string; description: string;
};
export type LabEquipmentSlot = {
  id: string; name: string; icon: "primary" | "secondary" | "protection" | "accessory" | "tool" | "special"; item: LabInventoryItem | null;
};
export const codexInventory: readonly LabInventoryItem[] = Object.freeze([
  { id: "key", name: "Старинный ключ", quantity: 1, slots: 1, icon: "key", category: "Ключевой предмет", rarity: "Обычный", rarityKey: "common", status: "Ключевой", description: "Небольшой металлический ключ со стёртой маркировкой." },
  { id: "notebook", name: "Записная книжка", quantity: 1, slots: 1, icon: "book", category: "Документ", rarity: "Обычный", rarityKey: "common", description: "Походные записи в мягкой обложке." },
  { id: "flask", name: "Фляга", quantity: 1, slots: 1, icon: "flask", category: "Расходник", rarity: "Обычный", rarityKey: "common", description: "Прочная фляга для воды." },
  { id: "letter", name: "Письмо", quantity: 1, slots: 1, icon: "letter", category: "Документ", rarity: "Обычный", rarityKey: "common", status: "Сюжетный", action: "Открыть", description: "Личное письмо, полученное в пути." },
  { id: "medkit", name: "Аптечка", quantity: 2, slots: 1, icon: "medical", category: "Расходник", rarity: "Необычный", rarityKey: "uncommon", description: "Компактный набор первой помощи." },
  { id: "compass", name: "Компас", quantity: 1, slots: 1, icon: "compass", category: "Инструмент", rarity: "Обычный", rarityKey: "common", equipSlot: "Инструмент", description: "Надёжный карманный компас." },
  { id: "flashlight", name: "Фонарик", quantity: 1, slots: 1, icon: "flashlight", category: "Инструмент", rarity: "Обычный", rarityKey: "common", equipSlot: "Инструмент", description: "Небольшой фонарь с ручным выключателем." },
  { id: "rope", name: "Верёвка", quantity: 1, slots: 1, icon: "rope", category: "Инструмент", rarity: "Обычный", rarityKey: "common", description: "Свернутая прочная верёвка для пути." },
]);
export const equipmentSlots: readonly LabEquipmentSlot[] = Object.freeze([
  { id: "primary", name: "Основное", icon: "primary", item: { id: "knife", name: "Охотничий нож", quantity: 1, slots: 1, icon: "knife", category: "Экипировка", rarity: "Обычный", rarityKey: "common", equipSlot: "Основное", description: "Компактный нож, который персонаж носит при себе." } },
  { id: "secondary", name: "Вторичное", icon: "secondary", item: null },
  { id: "protection", name: "Защита", icon: "protection", item: { id: "jacket", name: "Кожаная куртка", quantity: 1, slots: 1, icon: "jacket", category: "Экипировка", rarity: "Необычный", rarityKey: "uncommon", equipSlot: "Защита", description: "Прочная куртка для долгих переходов." } },
  { id: "accessory", name: "Аксессуар", icon: "accessory", item: { id: "amulet", name: "Амулет", quantity: 1, slots: 1, icon: "amulet", category: "Артефакт", rarity: "Редкий", rarityKey: "rare", equipSlot: "Аксессуар", description: "Небольшой личный предмет с неизвестной историей." } },
  { id: "tool", name: "Инструмент", icon: "tool", item: { id: "lockpicks", name: "Отмычки", quantity: 1, slots: 1, icon: "lockpicks", category: "Инструмент", rarity: "Необычный", rarityKey: "uncommon", equipSlot: "Инструмент", description: "Компактный набор отмычек в кожаном футляре." } },
  { id: "special", name: "Особое", icon: "special", item: null },
]);
export const bagCapacity = 12;
export const canFitInBag = (occupiedSlots: number, incomingSlots: number, capacity = bagCapacity) => occupiedSlots + incomingSlots <= capacity;
export const navigation = ["Главная", "Инвентарь", "Знания", "Журнал", "Профиль"] as const;
export type LabView = typeof navigation[number];
export type VariantId = "a" | "b" | "c";
export const variants = [
  { id: "a", name: "DOSSIER", background: "#17191b", surface: "#202326", text: "#ececea", accent: "#c7ad77", border: "#44484b", muted: "#a8adae", heading: "Arial", body: "Arial" },
  { id: "b", name: "FIELD ARCHIVE", background: "#292b2b", surface: "#efede5", text: "#30332f", accent: "#7c3936", border: "#c6c3b8", muted: "#696a60", heading: "Georgia", body: "Arial" },
  { id: "c", name: "EXPEDITION TERMINAL", background: "#141a18", surface: "#202824", text: "#edf1eb", accent: "#a5cfab", border: "#3b4d43", muted: "#a3b3a9", heading: "Arial", body: "Arial" },
] as const;
export type Variant = {
  id: VariantId; name: string; background: string; surface: string; text: string;
  accent: string; border: string; muted: string; heading: string; body: string;
};
export const refinedArchive: Variant = {
  ...variants[1], background: "#2b2c29", surface: "#f1ebdd", text: "#35332e",
  accent: "#783e3c", border: "#c9bfac", muted: "#71695c",
};
