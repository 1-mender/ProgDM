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
  profileFields: CampaignProfileFieldDefinition[];
  itemCatalog: CampaignItem[];
  knowledge: KnowledgeEntry[];
  activity: CampaignActivity[];
  networkAddresses: NetworkAddress[];
}

export interface CampaignProfileFieldDefinition {
  id: EntityId;
  campaignId: EntityId;
  label: string;
  position: number;
  createdAt: string;
}

export interface CharacterProfileFieldValue {
  id: EntityId;
  label: string;
  value: string;
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
  traits: string[];
  appearance: string;
  quote: string;
}

export interface PersonalNote {
  id: EntityId;
  characterId: EntityId;
  title: string;
  body: string;
  marker: PersonalNoteMarker;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PersonalNoteMarker = "normal" | "important" | "check" | "question";

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
  profile: (Pick<Character, "shortDescription" | "archetype" | "origin" | "personalGoal" | "traits" | "appearance" | "quote"> & { profileFields: CharacterProfileFieldValue[] }) | null;
  canEdit: boolean;
  inventory: InventoryItem[];
  knowledge: KnowledgeEntry[];
  notes: PersonalNote[];
  recentActivity: CampaignActivity[];
  newActivity: CampaignActivity[];
}

export type KnowledgeCategory = "character" | "place" | "creature" | "item" | "event" | "fact";
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

export type KnowledgeFactRevealAudience = "party" | "character";
export type KnowledgeFactRevealScope = "selected" | "next" | "all";
export type KnowledgeFactAccessResult = { fact: KnowledgeFact; reveal: KnowledgeFactReveal; created: boolean };
export type KnowledgeFactRevealBatchResult = { reveals: KnowledgeFactReveal[]; createdCount: number };

export interface KnowledgeFact {
  id: EntityId;
  campaignId: EntityId;
  knowledgeEntryId: EntityId;
  body: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeFactReveal {
  id: EntityId;
  campaignId: EntityId;
  knowledgeFactId: EntityId;
  audience: KnowledgeFactRevealAudience;
  characterId: EntityId | null;
  sessionId: EntityId | null;
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
  "knowledge_fact_revealed", "knowledge_fact_access_revoked",
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
  audience?: KnowledgeFactRevealAudience;
  factCount?: number;
  scope?: KnowledgeFactRevealScope;
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
