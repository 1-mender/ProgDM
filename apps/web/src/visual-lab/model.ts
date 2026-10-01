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
export const codexInventory = Object.freeze([
  { id: "key", name: "Старинный ключ", quantity: 1, slots: 1, icon: "key", category: "Инструмент", description: "Небольшой металлический ключ со стёртой маркировкой.", equipSlot: "Инструмент" },
  { id: "notebook", name: "Записная книжка", quantity: 1, slots: 1, icon: "book", category: "Особое", description: "Походные записи в мягкой обложке." },
  { id: "amulet", name: "Амулет", quantity: 1, slots: 1, icon: "amulet", category: "Аксессуар", description: "Небольшой личный предмет с неизвестной историей.", equipSlot: "Аксессуар" },
  { id: "flask", name: "Фляга", quantity: 1, slots: 1, icon: "flask", category: "Снаряжение", description: "Прочная фляга для воды." },
  { id: "letter", name: "Письмо", quantity: 1, slots: 1, icon: "letter", category: "Заметка", description: "Личное письмо, полученное в пути." },
  { id: "medkit", name: "Аптечка", quantity: 2, slots: 1, icon: "medical", category: "Снаряжение", description: "Компактный набор первой помощи." },
  { id: "compass", name: "Компас", quantity: 1, slots: 1, icon: "compass", category: "Инструмент", description: "Надёжный карманный компас.", equipSlot: "Инструмент" },
  { id: "flashlight", name: "Фонарик", quantity: 1, slots: 1, icon: "flashlight", category: "Инструмент", description: "Небольшой фонарь с ручным выключателем.", equipSlot: "Вторичное" },
]);
export const equipmentSlots = Object.freeze([
  { id: "primary", name: "Основное", item: "Охотничий нож", icon: "primary", description: "Компактный нож, который персонаж носит при себе." },
  { id: "secondary", name: "Вторичное", item: null, icon: "secondary", description: "Вторичная ячейка экипировки свободна." },
  { id: "protection", name: "Защита", item: "Кожаная куртка", icon: "protection", description: "Прочная куртка для защиты от непогоды и мелких повреждений." },
  { id: "accessory", name: "Аксессуар", item: null, icon: "accessory", description: "Ячейка аксессуара свободна." },
  { id: "tool", name: "Инструмент", item: "Отмычки", icon: "tool", description: "Компактный набор отмычек." },
  { id: "special", name: "Особое", item: null, icon: "special", description: "Особая ячейка экипировки свободна." },
]);
export const bagCapacity = 12;
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
