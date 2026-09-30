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
  activity: CampaignActivity[];
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
  archivedAt: string | null;
  shortDescription: string;
  archetype: string;
  origin: string;
  personalGoal: string;
  dmNotes: string;
}

export interface PersonalNote {
  id: EntityId;
  characterId: EntityId;
  body: string;
  createdAt: string;
  updatedAt: string;
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
  characterId: EntityId | null;
  profile: Pick<Character, "shortDescription" | "archetype" | "origin" | "personalGoal"> | null;
  canEdit: boolean;
  inventory: InventoryItem[];
  knowledge: KnowledgeEntry[];
  notes: PersonalNote[];
  recentActivity: CampaignActivity[];
  newActivity: CampaignActivity[];
}

export type KnowledgeCategory = "npc" | "monster" | "note" | "quest";
export type KnowledgeVisibility = "hidden" | "character" | "party";

export interface KnowledgeEntry {
  id: EntityId;
  campaignId: EntityId;
  category: KnowledgeCategory;
  title: string;
  description: string;
  visibility: KnowledgeVisibility;
  visibleToCharacterId: EntityId | null;
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

export const ACTIVITY_TYPES = [
  "campaign_created", "campaign_imported", "backup_restored",
  "session_created", "session_started", "session_ended",
  "player_requested", "player_approved", "player_rejected",
  "character_created", "character_assigned", "character_archived", "character_restored",
  "catalog_item_created", "item_granted", "knowledge_created", "knowledge_visibility_changed",
  "character_profile_updated", "personal_note_created", "personal_note_updated"
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ActivityDetails {
  campaignName?: string;
  sessionName?: string;
  playerName?: string;
  characterName?: string;
  itemName?: string;
  knowledgeTitle?: string;
  quantity?: number;
  totalQuantity?: number;
  visibility?: KnowledgeVisibility;
  previousVisibility?: KnowledgeVisibility;
  backupId?: string;
}

export interface CampaignActivity {
  id: EntityId;
  campaignId: EntityId;
  sessionId: EntityId | null;
  playerId: EntityId | null;
  characterId: EntityId | null;
  catalogItemId: EntityId | null;
  knowledgeEntryId: EntityId | null;
  type: ActivityType;
  createdAt: string;
  details: ActivityDetails;
}

export type HealthCheck = { name: string; status: "ok" | "error" | "skipped"; message: string };
export type DataHealth = { ok: boolean; checks: HealthCheck[] };
