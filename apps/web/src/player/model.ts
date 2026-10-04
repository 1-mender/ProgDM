import type { EquipmentSlot, InventoryCategory, InventoryRarity, KnowledgeCategory, PersonalNote, PersonalNoteMarker, PlayerActivityEvent, PlayerInventoryItem } from "@progdm/shared";
import { BookOpen, CircleDot, Diamond, FileText, FlaskConical, Home, KeyRound, Package, ScrollText, Shield, Sparkles, UserRound, Wrench, type LucideIcon } from "lucide-react";

export type PlayerView = "home" | "inventory" | "knowledge" | "journal" | "profile" | "settings";

export const PLAYER_NAVIGATION: { id: Exclude<PlayerView, "settings">; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Главная", icon: Home },
  { id: "inventory", label: "Инвентарь", icon: Package },
  { id: "knowledge", label: "Знания", icon: BookOpen },
  { id: "journal", label: "Журнал", icon: ScrollText },
  { id: "profile", label: "Профиль", icon: UserRound }
];

export const KNOWLEDGE_CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  character: "Персонажи",
  place: "Места",
  creature: "Существа",
  item: "Предметы",
  event: "События",
  fact: "Факты"
};

export const PERSONAL_NOTE_MARKER_LABELS: Record<PersonalNoteMarker, string> = {
  normal: "Обычная",
  important: "Важно",
  check: "Проверить",
  question: "Вопрос"
};

export const INVENTORY_CATEGORY_LABELS: Record<InventoryCategory, string> = {
  key: "Ключевой предмет",
  document: "Документ",
  tool: "Инструмент",
  consumable: "Расходник",
  equipment: "Снаряжение",
  artifact: "Артефакт",
  special: "Особое"
};

export const INVENTORY_CATEGORY_ICONS: Record<InventoryCategory, LucideIcon> = {
  key: KeyRound,
  document: FileText,
  tool: Wrench,
  consumable: FlaskConical,
  equipment: Shield,
  artifact: Diamond,
  special: Sparkles
};

export const INVENTORY_RARITY_LABELS: Record<InventoryRarity, string> = {
  common: "Обычный",
  uncommon: "Необычный",
  rare: "Редкий",
  unique: "Уникальный"
};

export const EQUIPMENT_SLOT_ORDER: EquipmentSlot[] = ["primary", "secondary", "armor", "accessory", "tool", "special"];
export const EQUIPMENT_SLOT_LABELS: Record<EquipmentSlot, string> = {
  primary: "Основное",
  secondary: "Вторичное",
  armor: "Защита",
  accessory: "Аксессуар",
  tool: "Инструмент",
  special: "Особое"
};
export const EQUIPMENT_SLOT_ICONS: Record<EquipmentSlot, LucideIcon> = {
  primary: KeyRound,
  secondary: CircleDot,
  armor: Shield,
  accessory: Diamond,
  tool: Wrench,
  special: Sparkles
};

export function inventoryBagSlotsUsed(items: PlayerInventoryItem[]) {
  return items.filter((item) => item.equippedSlot === null).length;
}

export function canEquipInventoryItem(items: PlayerInventoryItem[], item: PlayerInventoryItem, canEdit: boolean, capacity: number | null) {
  return canEdit && capacity !== null && item.equippedSlot === null && item.equipmentSlot !== null && item.quantity === 1 &&
    !items.some((candidate) => candidate.equippedSlot === item.equipmentSlot);
}

export function canUnequipInventoryItem(items: PlayerInventoryItem[], capacity: number | null, item: PlayerInventoryItem) {
  const bagStack = item.catalogItemId && items.find((candidate) => candidate.catalogItemId === item.catalogItemId && candidate.equippedSlot === null);
  if (bagStack) return bagStack.quantity < 9999;
  return capacity !== null && inventoryBagSlotsUsed(items) < capacity;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported player activity: ${String(value)}`);
}

export function homeActivityLabel(event: PlayerActivityEvent) {
  switch (event.kind) {
    case "item_received": return `Получен предмет «${event.itemName}»`;
    case "knowledge_summary_opened": return `Открыто знание «${event.knowledgeTitle}»`;
    case "knowledge_facts_revealed": return `Новые сведения «${event.knowledgeTitle}»`;
    default: return assertNever(event);
  }
}

export function journalActivityLabel(event: PlayerActivityEvent) {
  switch (event.kind) {
    case "item_received": return `Получен предмет: ${event.itemName} × ${event.quantity}`;
    case "knowledge_summary_opened": return `Открыто знание: ${event.knowledgeTitle}`;
    case "knowledge_facts_revealed": return `Открыты новые сведения: ${event.knowledgeTitle}`;
    default: return assertNever(event);
  }
}

export function homeActivityIcon(event: PlayerActivityEvent): LucideIcon {
  switch (event.kind) {
    case "item_received": return Package;
    case "knowledge_summary_opened":
    case "knowledge_facts_revealed": return BookOpen;
    default: return assertNever(event);
  }
}

export function homeActivityDigest(activity: PlayerActivityEvent[]) {
  const ordered = [...activity].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || (right.id > left.id ? 1 : right.id < left.id ? -1 : 0));
  const factEntries = new Set<string>();
  const digest: PlayerActivityEvent[] = [];
  for (const event of ordered) {
    if (event.kind === "knowledge_facts_revealed") {
      if (factEntries.has(event.knowledgeEntryId)) continue;
      factEntries.add(event.knowledgeEntryId);
    }
    digest.push(event);
    if (digest.length === 3) break;
  }
  return digest;
}

export function knowledgeCountLabel(count: number) {
  const category = new Intl.PluralRules("ru").select(count);
  const noun = category === "one" ? "запись" : category === "few" ? "записи" : "записей";
  return `${count} ${noun}`;
}

export function pinnedHomeNotes(notes: PersonalNote[]) {
  return notes.filter((note) => note.pinned).slice(0, 2);
}

export function personalNoteDisplayTitle(note: Pick<PersonalNote, "title" | "body">) {
  const title = note.title.trim();
  if (title) return title;
  const firstLine = note.body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine;
}

export function personalNoteBodyPreview(note: Pick<PersonalNote, "title" | "body">) {
  const body = note.body.trim().split(/\r?\n/);
  const preview = note.title.trim() ? body[0]?.trim() ?? "" : body.slice(1).join(" ").trim();
  return preview.length > 110 ? `${preview.slice(0, 109).trimEnd()}…` : preview;
}

export function characterInitials(name: string | null, fallback: string) {
  const words = (name || fallback).trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => Array.from(word)[0]?.toLocaleUpperCase("ru") ?? "").join("");
}
