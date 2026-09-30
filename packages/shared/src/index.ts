export type EntityId = string;

export type QuestStatus =
  | "Hidden"
  | "Available"
  | "Active"
  | "Completed"
  | "Failed";

export type SessionStatus = "planned" | "active" | "ended";

export interface Campaign {
  id: EntityId;
  name: string;
  createdAt: string;
}

export interface Session {
  id: EntityId;
  campaignId: EntityId;
  name: string;
  status: SessionStatus;
  joinToken: string;
  createdAt: string;
}

export interface SessionSnapshot {
  campaign: Campaign;
  session: Session;
}

export interface DmState {
  campaigns: Campaign[];
  sessions: Session[];
  current: SessionSnapshot | null;
  players: Player[];
  characters: Character[];
  itemCatalog: CampaignItem[];
  knowledge: KnowledgeEntry[];
  networkAddresses: NetworkAddress[];
}

export interface Player {
  id: EntityId;
  sessionId: EntityId;
  sessionName: string;
  displayName: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  characterId: EntityId | null;
  characterName: string | null;
}

export interface Character {
  id: EntityId;
  campaignId: EntityId;
  name: string;
  createdAt: string;
}

export interface CampaignItem {
  id: EntityId;
  campaignId: EntityId;
  name: string;
  createdAt: string;
}

export interface NetworkAddress {
  address: string;
  label: string;
}

export interface JoinInfo {
  campaignName: string;
  sessionName: string;
}

export interface PlayerState {
  displayName: string;
  status: Player["status"];
  campaignName: string;
  sessionName: string;
  characterName: string | null;
  inventory: InventoryItem[];
  knowledge: KnowledgeEntry[];
}

export type KnowledgeCategory = "npc" | "monster" | "note" | "quest";
export type KnowledgeVisibility = "hidden" | "player" | "party";

export interface KnowledgeEntry {
  id: EntityId;
  campaignId: EntityId;
  category: KnowledgeCategory;
  title: string;
  description: string;
  visibility: KnowledgeVisibility;
  visibleToPlayerId: EntityId | null;
  createdAt: string;
}

export interface Quest {
  id: EntityId;
  campaignId: EntityId;
  title: string;
  status: QuestStatus;
}

export interface InventoryItem {
  id: EntityId;
  characterId: EntityId;
  catalogItemId: EntityId | null;
  name: string;
  quantity: number;
  createdAt: string;
}

export interface SessionEvent {
  id: EntityId;
  sessionId: EntityId;
  type: SessionEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

export const FUTURE_SESSION_EVENTS = [
  "ITEM_RECEIVED",
  "QUEST_STARTED",
  "QUEST_COMPLETED",
  "MONSTER_REVEALED",
  "SESSION_STARTED",
  "SESSION_ENDED",
  "MESSAGE",
  "NOTIFICATION"
] as const;

export type SessionEventType = (typeof FUTURE_SESSION_EVENTS)[number];
