import type { CampaignActivity, KnowledgeCategory, PersonalNote, PersonalNoteMarker } from "@progdm/shared";
import { BookOpen, Home, Package, ScrollText, UserRound, type LucideIcon } from "lucide-react";

export type PlayerView = "home" | "inventory" | "knowledge" | "journal" | "profile" | "settings";

export const PLAYER_NAVIGATION: { id: Exclude<PlayerView, "settings">; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Главная", icon: Home },
  { id: "inventory", label: "Инвентарь", icon: Package },
  { id: "knowledge", label: "Знания", icon: BookOpen },
  { id: "journal", label: "Журнал", icon: ScrollText },
  { id: "profile", label: "Профиль", icon: UserRound }
];

export const KNOWLEDGE_CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  npc: "Персонаж мира",
  monster: "Существо",
  note: "Заметка",
  quest: "Событие"
};

export const PERSONAL_NOTE_MARKER_LABELS: Record<PersonalNoteMarker, string> = {
  normal: "Обычная",
  important: "Важно",
  check: "Проверить",
  question: "Вопрос"
};

export function homeActivityDigest(activity: CampaignActivity[]) {
  return activity.slice(0, 3);
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
