import type { CampaignActivity, KnowledgeCategory } from "@progdm/shared";
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

export function homeActivityDigest(activity: CampaignActivity[]) {
  return activity.slice(0, 3);
}

export function knowledgeCountLabel(count: number) {
  const category = new Intl.PluralRules("ru").select(count);
  const noun = category === "one" ? "запись" : category === "few" ? "записи" : "записей";
  return `${count} ${noun}`;
}

export function characterInitials(name: string | null, fallback: string) {
  const words = (name || fallback).trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => Array.from(word)[0]?.toLocaleUpperCase("ru") ?? "").join("");
}
