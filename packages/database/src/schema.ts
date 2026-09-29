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
  playerId: text("player_id").references(() => players.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("characters_campaign_id_idx").on(table.campaignId),
  uniqueIndex("characters_player_id_unique").on(table.playerId),
  check("character_name_valid", sql`length(trim(${table.name})) between 1 and 120`)
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
  visibility: text("visibility", { enum: ["hidden", "player", "party"] }).notNull().default("hidden"),
  visibleToPlayerId: text("visible_to_player_id").references(() => players.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("knowledge_entries_campaign_id_idx").on(table.campaignId),
  index("knowledge_entries_visible_player_idx").on(table.visibleToPlayerId),
  check("knowledge_category_valid", sql`${table.category} in ('npc', 'monster', 'note', 'quest')`),
  check("knowledge_visibility_valid", sql`${table.visibility} in ('hidden', 'player', 'party')`),
  check("knowledge_visibility_target_valid", sql`(${table.visibility} = 'player' and ${table.visibleToPlayerId} is not null) or (${table.visibility} != 'player' and ${table.visibleToPlayerId} is null)`),
  check("knowledge_title_valid", sql`length(trim(${table.title})) between 1 and 120`),
  check("knowledge_description_valid", sql`length(${table.description}) <= 2000`)
]);
