import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  check("campaign_name_valid", sql`length(trim(${table.name})) between 1 and 120`)
]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["planned", "active", "ended"] }).notNull().default("planned"),
  joinToken: text("join_token").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("sessions_campaign_id_idx").on(table.campaignId),
  uniqueIndex("sessions_join_token_unique").on(table.joinToken),
  uniqueIndex("sessions_one_active").on(table.status).where(sql`${table.status} = 'active'`),
  check("session_status_valid", sql`${table.status} in ('planned', 'active', 'ended')`),
  check("session_name_valid", sql`length(trim(${table.name})) between 1 and 120`)
]);

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  tokenHash: text("token_hash").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("players_token_hash_unique").on(table.tokenHash),
  uniqueIndex("players_session_name_unique").on(table.sessionId, sql`lower(trim(${table.displayName}))`),
  index("players_session_status_idx").on(table.sessionId, table.status),
  check("player_name_valid", sql`length(trim(${table.displayName})) between 1 and 60`),
  check("player_status_valid", sql`${table.status} in ('pending', 'approved', 'rejected')`)
]);

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
  shortDescription: text("short_description").notNull().default(""),
  archetype: text("archetype").notNull().default(""),
  origin: text("origin").notNull().default(""),
  personalGoal: text("personal_goal").notNull().default(""),
  dmNotes: text("dm_notes").notNull().default(""),
  traits: text("traits").notNull().default("[]"),
  appearance: text("appearance").notNull().default(""),
  quote: text("quote").notNull().default("")
}, (table) => [
  index("characters_campaign_id_idx").on(table.campaignId),
  check("character_name_valid", sql`length(trim(${table.name})) between 1 and 120`),
  check("character_profile_valid", sql`length(${table.shortDescription}) <= 500 and length(${table.archetype}) <= 120 and length(${table.origin}) <= 500 and length(${table.personalGoal}) <= 500 and length(${table.dmNotes}) <= 2000 and length(${table.appearance}) <= 1000 and length(${table.quote}) <= 300`)
]);

export const characterPersonalNotes = sqliteTable("character_personal_notes", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "restrict" }),
  title: text("title").notNull().default(""),
  body: text("body").notNull(),
  marker: text("marker").notNull().default("normal"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("character_personal_notes_character_idx").on(table.characterId, table.createdAt, table.id),
  check("character_personal_note_title_valid", sql`length(${table.title}) <= 120`),
  check("character_personal_note_body_valid", sql`length(trim(${table.body})) between 1 and 2000`),
  check("character_personal_note_marker_valid", sql`${table.marker} in ('normal', 'important', 'check', 'question')`),
  check("character_personal_note_pinned_valid", sql`${table.pinned} in (0, 1)`)
]);

export const characterReadState = sqliteTable("character_read_state", {
  characterId: text("character_id").primaryKey().references(() => characters.id, { onDelete: "restrict" }),
  lastSeenAt: text("last_seen_at").notNull(),
  lastSeenId: text("last_seen_id").notNull()
});

export const sessionCharacterAssignments = sqliteTable("session_character_assignments", {
  playerId: text("player_id").primaryKey().references(() => players.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("session_character_assignments_session_character_unique").on(table.sessionId, table.characterId),
  index("session_character_assignments_character_idx").on(table.characterId)
]);

export const catalogItems = sqliteTable("catalog_items", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("catalog_items_campaign_name_unique").on(table.campaignId, sql`lower(trim(${table.name}))`),
  index("catalog_items_campaign_id_idx").on(table.campaignId),
  check("catalog_item_name_valid", sql`length(trim(${table.name})) between 1 and 120`)
]);

export const inventoryItems = sqliteTable("inventory_items", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  catalogItemId: text("catalog_item_id").references(() => catalogItems.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull().default(1),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("inventory_items_character_id_idx").on(table.characterId),
  uniqueIndex("inventory_items_character_name_unique").on(table.characterId, sql`lower(trim(${table.name}))`),
  check("inventory_item_name_valid", sql`length(trim(${table.name})) between 1 and 120`),
  check("inventory_item_quantity_valid", sql`${table.quantity} between 1 and 9999`)
]);

export const knowledgeEntries = sqliteTable("knowledge_entries", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  category: text("category", { enum: ["npc", "monster", "note", "quest"] }).notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  visibility: text("visibility", { enum: ["hidden", "character", "party"] }).notNull().default("hidden"),
  visibleToCharacterId: text("visible_to_character_id").references(() => characters.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("knowledge_entries_campaign_id_idx").on(table.campaignId),
  index("knowledge_entries_visible_character_idx").on(table.visibleToCharacterId),
  check("knowledge_category_valid", sql`${table.category} in ('npc', 'monster', 'note', 'quest')`),
  check("knowledge_visibility_valid", sql`${table.visibility} in ('hidden', 'character', 'party')`),
  check("knowledge_visibility_target_valid", sql`(${table.visibility} = 'character' and ${table.visibleToCharacterId} is not null) or (${table.visibility} != 'character' and ${table.visibleToCharacterId} is null)`),
  check("knowledge_title_valid", sql`length(trim(${table.title})) between 1 and 120`),
  check("knowledge_description_valid", sql`length(${table.description}) <= 2000`)
]);

export const knowledgeMigrationIssues = sqliteTable("knowledge_migration_issues", {
  knowledgeEntryId: text("knowledge_entry_id").notNull().references(() => knowledgeEntries.id, { onDelete: "cascade" }),
  legacyPlayerId: text("legacy_player_id").notNull(),
  reason: text("reason", { enum: ["missing_assignment", "campaign_mismatch"] }).notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  check("knowledge_migration_issue_reason_valid", sql`${table.reason} in ('missing_assignment', 'campaign_mismatch')`)
]);

export const campaignActivity = sqliteTable("campaign_activity", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "restrict" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "restrict" }),
  playerId: text("player_id").references(() => players.id, { onDelete: "restrict" }),
  characterId: text("character_id").references(() => characters.id, { onDelete: "restrict" }),
  catalogItemId: text("catalog_item_id").references(() => catalogItems.id, { onDelete: "restrict" }),
  knowledgeEntryId: text("knowledge_entry_id").references(() => knowledgeEntries.id, { onDelete: "restrict" }),
  type: text("type").notNull(),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull()
}, (table) => [
  index("campaign_activity_campaign_order_idx").on(table.campaignId, table.createdAt, table.id),
  index("campaign_activity_session_order_idx").on(table.sessionId, table.createdAt, table.id),
  check("campaign_activity_payload_valid", sql`json_valid(${table.payload})`)
]);
