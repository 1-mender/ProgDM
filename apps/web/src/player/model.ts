import type { EquipmentSlot, InventoryCategory, InventoryRarity, KnowledgeCategory, PersonalNote, PersonalNoteMarker, PlayerActivityEvent, PlayerInventoryItem } from "@progdm/shared";
import { ArrowLeftRight, BookOpen, CircleHelp, CircleDot, Crosshair, Diamond, FileText, FlaskConical, Home, KeyRound, Package, ScrollText, Shield, Sparkles, Trash2, TriangleAlert, UserRound, Wrench, type LucideIcon } from "lucide-react";

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

export function createInventoryOperationId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
    case "item_transferred": return event.direction === "sent"
      ? `Передан предмет «${event.itemName}» персонажу ${event.otherCharacterName}`
      : `Получен предмет «${event.itemName}» от ${event.otherCharacterName}`;
    case "item_discarded": return `Выброшен предмет «${event.itemName}»`;
    case "knowledge_summary_opened": return `Открыто знание «${event.knowledgeTitle}»`;
    case "knowledge_facts_revealed": return `Новые сведения «${event.knowledgeTitle}»`;
    default: return assertNever(event);
  }
}

export function journalActivityLabel(event: PlayerActivityEvent) {
  switch (event.kind) {
    case "item_received": return `Получен предмет: ${event.itemName} × ${event.quantity}`;
    case "item_transferred": return event.direction === "sent"
      ? `Передан предмет: ${event.itemName} ×${event.quantity} — ${event.otherCharacterName}`
      : `Получен предмет: ${event.itemName} ×${event.quantity} от ${event.otherCharacterName}`;
    case "item_discarded": return `Выброшен предмет: ${event.itemName} ×${event.quantity}`;
    case "knowledge_summary_opened": return `Открыто знание: ${event.knowledgeTitle}`;
    case "knowledge_facts_revealed": return `Открыты новые сведения: ${event.knowledgeTitle}`;
    default: return assertNever(event);
  }
}

export function journalActivityPresentation(event: PlayerActivityEvent): {
  title: string;
  secondary: string;
  icon: LucideIcon;
  destination?: { kind: "knowledge"; entryId: string };
} {
  const quantityText = (name: string, quantity: number) => quantity > 1 ? `${name} ×${quantity}` : name;
  switch (event.kind) {
    case "item_received": return { title: "Получен предмет", secondary: quantityText(event.itemName, event.quantity), icon: Package };
    case "item_transferred": return {
      title: event.direction === "sent" ? "Передан предмет" : "Получен предмет",
      secondary: event.direction === "sent"
        ? `${quantityText(event.itemName, event.quantity)} — ${event.otherCharacterName}`
        : `${quantityText(event.itemName, event.quantity)} от ${event.otherCharacterName}`,
      icon: ArrowLeftRight
    };
    case "item_discarded": return { title: "Выброшен предмет", secondary: quantityText(event.itemName, event.quantity), icon: Trash2 };
    case "knowledge_summary_opened": return {
      title: "Открыто знание", secondary: event.knowledgeTitle, icon: BookOpen,
      destination: { kind: "knowledge", entryId: event.knowledgeEntryId }
    };
    case "knowledge_facts_revealed": return {
      title: "Новые сведения", secondary: event.knowledgeTitle, icon: Sparkles,
      destination: { kind: "knowledge", entryId: event.knowledgeEntryId }
    };
    default: return assertNever(event);
  }
}

export function personalNoteMarkerIcon(marker: PersonalNoteMarker): LucideIcon | null {
  switch (marker) {
    case "normal": return null;
    case "important": return TriangleAlert;
    case "check": return Crosshair;
    case "question": return CircleHelp;
    default: return assertNever(marker);
  }
}

export interface JournalEventGroup {
  key: string;
  dateLabel: string;
  sessionName: string;
  events: PlayerActivityEvent[];
}

export function journalEventGroups(events: PlayerActivityEvent[]): JournalEventGroup[] {
  const groups = new Map<string, JournalEventGroup>();
  for (const event of events) {
    const date = new Date(event.createdAt);
    const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const sessionKey = event.sessionId ?? "outside-session";
    const key = `${dateKey}:${sessionKey}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        dateLabel: new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date),
        sessionName: event.sessionName ?? "Вне сессии",
        events: []
      };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  return [...groups.values()];
}

export function journalEventTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

export function homeActivityIcon(event: PlayerActivityEvent): LucideIcon {
  switch (event.kind) {
    case "item_received": return Package;
    case "item_transferred": return ArrowLeftRight;
    case "item_discarded": return Trash2;
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
