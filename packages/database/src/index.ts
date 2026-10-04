import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, cpSync, copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import SQLite from "better-sqlite3";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { ACTIVITY_TYPES, type ActivityDetails, type ActivityType, type Campaign, type CampaignActivity, type CampaignItem, type CampaignProfileFieldDefinition, type Character, type CharacterProfileFieldValue, type DataHealth, type EquipmentSlot, type HealthCheck, type InventoryCategory, type InventoryRarity, type KnowledgeCategory, type KnowledgeFact, type KnowledgeFactAccessResult, type KnowledgeFactReveal, type KnowledgeFactRevealAudience, type KnowledgeFactRevealBatchResult, type KnowledgeFactRevealScope, type KnowledgeVisibility, type PersonalNoteMarker, type PlayerActivityEvent, type PlayerInventoryItem, type PlayerJournalCursor, type PlayerJournalPage, type PlayerKnowledgeEntry, type Session, type SessionSnapshot } from "@progdm/shared";
import * as schema from "./schema.js";

function validatedPlayerName(name: string): string {
  const value = name.trim();
  if (value.length === 0 || value.length > 60) {
    throw new Error("Player name must contain between 1 and 60 characters.");
  }
  return value;
}

export const DATA_DIRECTORIES = {
  root: "data",
  databaseFile: "data/game.db",
  uploads: {
    monsters: "data/uploads/monsters",
    characters: "data/uploads/characters",
    items: "data/uploads/items"
  },
  backups: "data/backups"
} as const;

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));

export function resolveDatabaseFile(file = process.env.PROGDM_DATABASE_FILE ?? DATA_DIRECTORIES.databaseFile): string {
  if (file === ":memory:") return file;
  return isAbsolute(file) ? file : resolve(workspaceRoot, file);
}

function validatedName(name: string): string {
  const value = name.trim();
  if (value.length === 0 || value.length > 120) {
    throw new Error("Name must contain between 1 and 120 characters.");
  }
  return value;
}

function validatedDescription(description: string): string {
  const value = description.trim();
  if (value.length === 0 || value.length > 2000) {
    throw new Error("Description must contain between 1 and 2000 characters.");
  }
  return value;
}

const KNOWLEDGE_CATEGORIES: readonly KnowledgeCategory[] = ["character", "place", "creature", "item", "event", "fact"];

function validatedKnowledgeCategory(value: unknown): KnowledgeCategory {
  if (typeof value !== "string" || !KNOWLEDGE_CATEGORIES.includes(value as KnowledgeCategory)) {
    throw new Error("Knowledge category is invalid.");
  }
  return value as KnowledgeCategory;
}

const INVENTORY_CATEGORIES: readonly InventoryCategory[] = ["key", "document", "tool", "consumable", "equipment", "artifact", "special"];
const INVENTORY_RARITIES: readonly InventoryRarity[] = ["common", "uncommon", "rare", "unique"];
const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ["primary", "secondary", "armor", "accessory", "tool", "special"];

function validatedInventoryDescription(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) throw new Error("Catalog item description is invalid.");
  return value;
}

function validatedInventoryCategory(value: unknown): InventoryCategory {
  if (typeof value !== "string" || !INVENTORY_CATEGORIES.includes(value as InventoryCategory)) throw new Error("Catalog item category is invalid.");
  return value as InventoryCategory;
}

function validatedInventoryRarity(value: unknown): InventoryRarity | null {
  if (value === null) return null;
  if (typeof value !== "string" || !INVENTORY_RARITIES.includes(value as InventoryRarity)) throw new Error("Catalog item rarity is invalid.");
  return value as InventoryRarity;
}

function validatedEquipmentSlot(value: unknown): EquipmentSlot | null {
  if (value === null) return null;
  if (typeof value !== "string" || !EQUIPMENT_SLOTS.includes(value as EquipmentSlot)) throw new Error("Equipment slot is invalid.");
  return value as EquipmentSlot;
}

function validatedInventoryPermission(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Catalog item ${field} flag is invalid.`);
  return value;
}

function validatedInventoryCapacity(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error("Inventory capacity must be a non-negative integer.");
  return value as number;
}

function validatedKnowledgeFactBody(body: string): string {
  const value = body.trim();
  if (value.length === 0 || value.length > 2000) {
    throw new Error("Knowledge fact must contain between 1 and 2000 characters.");
  }
  return value;
}

function validatedKnowledgeFactPosition(position: number): number {
  if (!Number.isInteger(position) || position < 0) throw new Error("Knowledge fact position is invalid.");
  return position;
}

function validatedOperationId(operationId: string): string {
  const value = operationId.trim();
  if (!value || value.length > 120) throw new Error("Knowledge reveal operation ID is invalid.");
  return value;
}

function validatedInventoryOperationId(operationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new Error("Inventory operation ID is invalid.");
  }
  return operationId;
}

function transferRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Campaign file is invalid.");
  return value as Record<string, unknown>;
}

function transferString(record: Record<string, unknown>, key: string, max = 200): string {
  const value = record[key];
  if (typeof value !== "string" || value.length > max) throw new Error("Campaign file is invalid.");
  return value;
}

function transferArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > 10000) throw new Error("Campaign file is invalid.");
  return value.map(transferRecord);
}

function validLifecycleTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

export function openDatabase(options: { file?: string; backupsDirectory?: string; uploadsDirectory?: string } = {}) {
  const file = resolveDatabaseFile(options.file);
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const backupsDirectory = resolve(workspaceRoot, options.backupsDirectory ?? DATA_DIRECTORIES.backups);
  const uploadsDirectory = resolve(workspaceRoot, options.uploadsDirectory ?? "data/uploads");
  mkdirSync(backupsDirectory, { recursive: true });
  for (const category of ["monsters", "characters", "items"]) mkdirSync(join(uploadsDirectory, category), { recursive: true });

  const client = new SQLite(file);
  const db = drizzle(client, { schema });
  const backupIdPattern = /^progdm-backup-([0-9a-f-]{36})\.db$/;
  const backupTables = ["campaigns", "sessions", "players", "characters", "campaign_profile_field_definitions", "character_profile_field_values", "character_personal_notes", "character_read_state", "session_character_assignments", "catalog_items", "inventory_items", "knowledge_entries", "knowledge_facts", "knowledge_fact_reveals", "knowledge_migration_issues", "campaign_activity", "__drizzle_migrations"];

  function profileText(value: string, max: number): string {
    const trimmed = value.trim();
    if (trimmed.length > max) throw new Error("Profile text is too long.");
    return trimmed;
  }

  function profileTraits(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error("Character traits are invalid.");
    const traits: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") throw new Error("Character traits are invalid.");
      const trait = entry.trim();
      if (!trait || trait.length > 40) throw new Error("Character traits are invalid.");
      if (!traits.includes(trait)) traits.push(trait);
    }
    if (traits.length > 8) throw new Error("Character traits are invalid.");
    return traits;
  }

  function readCharacterTraits(serialized: string): string[] {
    try { return profileTraits(JSON.parse(serialized)); }
    catch { return []; }
  }

  function characterRecord<T extends { traits: string }>(record: T): Omit<T, "traits"> & Pick<Character, "traits"> {
    return { ...record, traits: readCharacterTraits(record.traits) };
  }

  function storedTraitsAreValid(serialized: string): boolean {
    try {
      const parsed: unknown = JSON.parse(serialized);
      return Array.isArray(parsed) && JSON.stringify(profileTraits(parsed)) === JSON.stringify(parsed);
    } catch { return false; }
  }

  function exportTraits(serialized: string): string[] {
    try { return profileTraits(JSON.parse(serialized)); }
    catch { throw new Error("Character traits are invalid."); }
  }

  function personalNoteTitle(value: string): string {
    const title = value.trim();
    if (title.length > 120) throw new Error("Personal note title is too long.");
    return title;
  }

  function personalNoteMarker(value: string): PersonalNoteMarker {
    if (!["normal", "important", "check", "question"].includes(value)) throw new Error("Personal note marker is invalid.");
    return value as PersonalNoteMarker;
  }

  function personalNotePinned(value: unknown): boolean {
    if (typeof value !== "boolean") throw new Error("Campaign file is invalid.");
    return value;
  }

  function profileFieldLabel(value: string): string {
    const label = value.trim();
    if (!label || label.length > 60) throw new Error("Profile field label must contain between 1 and 60 characters.");
    return label;
  }

  function profileFieldValue(value: string): string {
    const fieldValue = value.trim();
    if (fieldValue.length > 500) throw new Error("Profile field value is too long.");
    return fieldValue;
  }

  function campaignProfileFields(campaignId: string): CampaignProfileFieldDefinition[] {
    return db.select().from(schema.campaignProfileFieldDefinitions)
      .where(eq(schema.campaignProfileFieldDefinitions.campaignId, campaignId))
      .orderBy(asc(schema.campaignProfileFieldDefinitions.position), asc(schema.campaignProfileFieldDefinitions.id)).all();
  }

  function characterProfileFields(characterId: string, includeEmpty = false): CharacterProfileFieldValue[] {
    const rows = client.prepare(`SELECT d.id, d.label, v.value FROM campaign_profile_field_definitions d
      JOIN characters c ON c.campaign_id=d.campaign_id AND c.id=?
      LEFT JOIN character_profile_field_values v ON v.field_id=d.id AND v.character_id=c.id
      ORDER BY d.position, d.id`).all(characterId) as { id: string; label: string; value: string | null }[];
    return rows.flatMap((row) => {
      const value = row.value ?? "";
      return includeEmpty || value ? [{ id: row.id, label: row.label, value }] : [];
    });
  }

  function activePlayerCharacter(tokenHash: string) {
    return db.select({ playerId: schema.players.id, sessionId: schema.sessions.id, campaignId: schema.sessions.campaignId, characterId: schema.characters.id })
      .from(schema.players)
      .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
      .innerJoin(schema.sessionCharacterAssignments, and(eq(schema.sessionCharacterAssignments.playerId, schema.players.id),
        eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId), isNull(schema.sessionCharacterAssignments.releasedAt)))
      .innerJoin(schema.characters, eq(schema.characters.id, schema.sessionCharacterAssignments.characterId))
      .where(and(eq(schema.players.tokenHash, tokenHash), isNull(schema.players.removedAt), eq(schema.players.status, "approved"), isNull(schema.sessions.removedAt), eq(schema.sessions.status, "active"), isNull(schema.sessionCharacterAssignments.releasedAt), eq(schema.characters.campaignId, schema.sessions.campaignId))).get() ?? null;
  }

  function requireActivePlayerCharacter(tokenHash: string) {
    const active = activePlayerCharacter(tokenHash);
    if (!active) throw new Error("Active character access required.");
    return active;
  }

  type ActivityInput = {
    campaignId: string;
    type: ActivityType;
    sessionId?: string | null;
    playerId?: string | null;
    characterId?: string | null;
    relatedCharacterId?: string | null;
    catalogItemId?: string | null;
    knowledgeEntryId?: string | null;
    operationId?: string | null;
    details?: ActivityDetails;
  };

  function appendActivity(event: ActivityInput): void {
    const latest = db.select({ createdAt: schema.campaignActivity.createdAt }).from(schema.campaignActivity)
      .orderBy(desc(schema.campaignActivity.createdAt)).limit(1).get();
    const timestamp = Math.max(Date.now(), latest ? Date.parse(latest.createdAt) + 1 : 0);
    db.insert(schema.campaignActivity).values({
      id: randomUUID(), campaignId: event.campaignId, sessionId: event.sessionId ?? null,
      playerId: event.playerId ?? null, characterId: event.characterId ?? null,
      relatedCharacterId: event.relatedCharacterId ?? null,
      catalogItemId: event.catalogItemId ?? null, knowledgeEntryId: event.knowledgeEntryId ?? null,
      operationId: event.operationId ?? null,
      type: event.type, createdAt: new Date(timestamp).toISOString(), payload: JSON.stringify(event.details ?? {})
    }).run();
  }

  function activeSessionId(campaignId: string): string | null {
    return db.select({ id: schema.sessions.id }).from(schema.sessions)
      .where(and(eq(schema.sessions.campaignId, campaignId), isNull(schema.sessions.removedAt), eq(schema.sessions.status, "active"))).get()?.id ?? null;
  }

  function revealKnowledgeFactInTransaction(campaignId: string, entryId: string, factId: string,
    audience: KnowledgeFactRevealAudience, characterId: string | null, scope: KnowledgeFactRevealScope,
    operationId: string | null = null): KnowledgeFactAccessResult {
    const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
      .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
    if (!entry) throw new Error("Knowledge entry is not in this campaign.");
    const fact = db.select().from(schema.knowledgeFacts).where(and(
      eq(schema.knowledgeFacts.id, factId), eq(schema.knowledgeFacts.campaignId, campaignId),
      eq(schema.knowledgeFacts.knowledgeEntryId, entryId)
    )).get();
    if (!fact) throw new Error("Knowledge fact not found in this entry.");
    if (audience === "character") {
      if (!characterId) throw new Error("A character must be selected.");
      const character = db.select({ id: schema.characters.id, archivedAt: schema.characters.archivedAt }).from(schema.characters)
        .where(and(eq(schema.characters.id, characterId), eq(schema.characters.campaignId, campaignId))).get();
      if (!character) throw new Error("Character is not in this campaign.");
      if (character.archivedAt) throw new Error("Archived characters cannot receive new knowledge facts.");
    } else if (audience !== "party" || characterId !== null) throw new Error("Knowledge fact audience is invalid.");

    const sessionId = activeSessionId(campaignId);
    const inserted = db.insert(schema.knowledgeFactReveals).values({
      id: randomUUID(), campaignId, knowledgeFactId: factId, audience, characterId, sessionId,
      operationId, createdAt: new Date().toISOString()
    }).onConflictDoNothing().returning().get();
    const reveal = inserted ?? db.select().from(schema.knowledgeFactReveals).where(and(
      eq(schema.knowledgeFactReveals.knowledgeFactId, factId), eq(schema.knowledgeFactReveals.audience, audience),
      audience === "character" ? eq(schema.knowledgeFactReveals.characterId, characterId!) : eq(schema.knowledgeFactReveals.audience, "party")
    )).get();
    if (!reveal) throw new Error("Knowledge fact reveal could not be created.");
    if (inserted) appendActivity({ campaignId, sessionId, characterId, knowledgeEntryId: entryId,
      operationId, type: "knowledge_fact_revealed", details: { audience, factCount: 1, scope } });
    const { operationId: _operationId, ...publicReveal } = reveal;
    return { fact, reveal: publicReveal, created: Boolean(inserted) };
  }

  function activityRows(rows: (typeof schema.campaignActivity.$inferSelect)[]): CampaignActivity[] {
    return rows.map((row) => ({
      id: row.id, campaignId: row.campaignId, sessionId: row.sessionId, playerId: row.playerId,
      characterId: row.characterId, relatedCharacterId: row.relatedCharacterId, catalogItemId: row.catalogItemId,
      knowledgeEntryId: row.knowledgeEntryId, type: row.type as ActivityType,
      createdAt: row.createdAt, details: JSON.parse(row.payload) as ActivityDetails
    }));
  }

  function parsedActivityDetails(value: unknown): ActivityDetails {
    const details = transferRecord(value);
    const stringKeys = new Set(["campaignName", "sessionName", "playerName", "characterName", "itemName", "knowledgeTitle", "backupId"]);
    const visibilityKeys = new Set(["visibility", "previousVisibility"]);
    const audienceKeys = new Set(["party", "character"]);
    const scopeKeys = new Set(["selected", "next", "all"]);
    for (const [key, part] of Object.entries(details)) {
      if (stringKeys.has(key) && typeof part === "string" && part.length <= 160) continue;
      if (key === "sourceInventoryItemId" && typeof part === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(part)) continue;
      if (visibilityKeys.has(key) && ["hidden", "party", "character"].includes(String(part))) continue;
      if (["quantity", "totalQuantity"].includes(key) && typeof part === "number" && Number.isInteger(part) && part >= 0 && part <= 9999) continue;
      if (key === "audience" && typeof part === "string" && audienceKeys.has(part)) continue;
      if (key === "scope" && typeof part === "string" && scopeKeys.has(part)) continue;
      if (key === "factCount" && typeof part === "number" && Number.isSafeInteger(part) && part >= 0) continue;
      throw new Error("Campaign file contains an invalid activity payload.");
    }
    if (JSON.stringify(details).length > 2000) throw new Error("Campaign file contains an invalid activity payload.");
    return details as ActivityDetails;
  }

  async function createBackup() {
    mkdirSync(backupsDirectory, { recursive: true });
    const id = randomUUID();
    const filename = `progdm-backup-${id}.db`;
    const destination = join(backupsDirectory, filename);
    const temporary = destination + ".tmp";
    try {
      await client.backup(temporary);
      const snapshot = new SQLite(temporary, { readonly: true, fileMustExist: true });
      try {
        const integrity = snapshot.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") throw new Error("Backup integrity check failed.");
      } finally { snapshot.close(); }
      rmSync(destination, { force: true });
      const stagedUploads = join(backupsDirectory, `.uploads-${id}`);
      mkdirSync(uploadsDirectory, { recursive: true });
      cpSync(uploadsDirectory, stagedUploads, { recursive: true, force: true, errorOnExist: false });
      renameSync(temporary, destination);
      renameSync(stagedUploads, join(backupsDirectory, `progdm-backup-${id}-uploads`));
      return { id: filename, createdAt: new Date().toISOString(), size: statSync(destination).size };
    } catch (error) {
      rmSync(temporary, { force: true });
      rmSync(join(backupsDirectory, `.uploads-${id}`), { recursive: true, force: true });
      rmSync(destination, { force: true });
      throw error;
    }
  }

  function resolveBackup(id: string): string {
    if (!backupIdPattern.test(basename(id)) || basename(id) !== id) throw new Error("Backup not found.");
    const backup = join(backupsDirectory, id);
    if (!statSync(backup, { throwIfNoEntry: false })?.isFile()) throw new Error("Backup not found.");
    return backup;
  }

  function migrationHistoryMatches(database: SQLite.Database, complete: boolean): boolean {
    const expected = readMigrationFiles({ migrationsFolder });
    const applied = database.prepare("SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at, rowid")
      .all() as { hash: string; createdAt: number }[];
    return (complete ? applied.length === expected.length : applied.length <= expected.length) &&
      applied.every((row, index) => {
        const migration = expected[index];
        if (!migration || row.createdAt !== migration.folderMillis) return false;
        const sql = migration.sql.join("--> statement-breakpoint").replace(/\r\n/g, "\n");
        // Git may check out the same migration using LF or CRLF on another machine.
        const hashes = [migration.hash, createHash("sha256").update(sql).digest("hex"),
          createHash("sha256").update(sql.replace(/\n/g, "\r\n")).digest("hex")];
        return hashes.includes(row.hash);
      });
  }

  function restoreBackupFile(sourceFile: string): void {
    const original = new SQLite(sourceFile, { readonly: true, fileMustExist: true });
    try {
      if (original.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Backup file is damaged.");
    } finally { original.close(); }

    const stagedFile = join(backupsDirectory, `.migrate-restore-${randomUUID()}.db`);
    copyFileSync(sourceFile, stagedFile);
    try {
      const staged = new SQLite(stagedFile);
      try {
        if (!migrationHistoryMatches(staged, false)) throw new Error("Backup migration history is not supported.");
        staged.pragma("foreign_keys = OFF");
        migrate(drizzle(staged, { schema }), { migrationsFolder });
        staged.pragma("foreign_keys = ON");
        if (!migrationHistoryMatches(staged, true)) throw new Error("Backup migration history is not supported.");

        if (staged.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Migrated backup failed integrity check.");
        if ((staged.pragma("foreign_key_check") as unknown[]).length) throw new Error("Migrated backup contains invalid references.");
        const lifecycleTimes = staged.prepare(`SELECT removed_at AS value FROM sessions WHERE removed_at IS NOT NULL
          UNION ALL SELECT removed_at FROM players WHERE removed_at IS NOT NULL
          UNION ALL SELECT released_at FROM session_character_assignments WHERE released_at IS NOT NULL`).all() as { value: string }[];
        if (lifecycleTimes.some(({ value }) => !validLifecycleTimestamp(value))) throw new Error("Migrated backup contains invalid lifecycle timestamps.");
        const lifecycleViolation = staged.prepare(`SELECT
          EXISTS(SELECT 1 FROM sessions WHERE removed_at IS NOT NULL AND status='active') OR
          EXISTS(SELECT 1 FROM players p JOIN session_character_assignments a ON a.player_id=p.id WHERE p.removed_at IS NOT NULL AND a.released_at IS NULL) OR
          EXISTS(SELECT 1 FROM session_character_assignments a GROUP BY a.session_id, a.character_id HAVING count(*) FILTER (WHERE a.released_at IS NULL)>1) AS invalid`).get() as { invalid: number };
        if (lifecycleViolation.invalid) throw new Error("Migrated backup contains invalid lifecycle references.");
        const schemaSignature = (database: SQLite.Database, schemaName: string) =>
          (database.prepare(`SELECT type, name, tbl_name, sql FROM ${schemaName}.sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`).all() as { type: string; name: string; tbl_name: string; sql: string }[])
            .map((object) => ({ ...object, sql: object.sql.replace(/\s+/g, " ").trim() }));
        if (JSON.stringify(schemaSignature(staged, "main")) !== JSON.stringify(schemaSignature(client, "main"))) {
          throw new Error("Backup schema is not supported.");
        }
      } finally { staged.close(); }

      client.prepare("ATTACH DATABASE ? AS restore_source").run(stagedFile);
    } catch (error) {
      rmSync(stagedFile, { force: true });
      rmSync(stagedFile + "-wal", { force: true });
      rmSync(stagedFile + "-shm", { force: true });
      throw error;
    }
    client.pragma("foreign_keys = OFF");
    try {
      client.transaction(() => {
        for (const table of backupTables) client.exec(`DELETE FROM main."${table}"`);
        for (const table of backupTables) {
          const columns = (client.prepare(`PRAGMA main.table_info("${table}")`).all() as { name: string }[]).map((row) => `"${row.name}"`).join(", ");
          client.exec(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM restore_source."${table}"`);
        }
        const violations = client.pragma("foreign_key_check") as unknown[];
        if (violations.length) throw new Error("Backup contains invalid references.");
        if (client.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Restored database failed integrity check.");
      })();
    } finally {
      client.prepare("DETACH DATABASE restore_source").run();
      client.pragma("foreign_keys = ON");
      rmSync(stagedFile, { force: true });
      rmSync(stagedFile + "-wal", { force: true });
      rmSync(stagedFile + "-shm", { force: true });
    }
  }

  async function restoreBackup(id: string) {
    const sourceFile = resolveBackup(id);
    const backupUuid = backupIdPattern.exec(id)![1]!;
    const sourceUploads = join(backupsDirectory, `progdm-backup-${backupUuid}-uploads`);
    if (!statSync(sourceUploads, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Backup uploads are missing.");
    const safetyCopy = await createBackup();
    const stagedUploads = uploadsDirectory + `.restore-${randomUUID()}`;
    const previousUploads = uploadsDirectory + `.previous-${randomUUID()}`;
    cpSync(sourceUploads, stagedUploads, { recursive: true });
    let databaseRestored = false;
    try {
      restoreBackupFile(sourceFile);
      databaseRestored = true;
      if (statSync(uploadsDirectory, { throwIfNoEntry: false })?.isDirectory()) renameSync(uploadsDirectory, previousUploads);
      renameSync(stagedUploads, uploadsDirectory);
      db.transaction(() => {
        for (const campaign of db.select({ id: schema.campaigns.id }).from(schema.campaigns).all()) {
          appendActivity({ campaignId: campaign.id, type: "backup_restored", details: { backupId: id } });
        }
      });
      rmSync(previousUploads, { recursive: true, force: true });
      return { safetyCopyId: safetyCopy.id };
    } catch (error) {
      if (databaseRestored) restoreBackupFile(resolveBackup(safetyCopy.id));
      rmSync(stagedUploads, { recursive: true, force: true });
      if (statSync(previousUploads, { throwIfNoEntry: false })?.isDirectory()) {
        rmSync(uploadsDirectory, { recursive: true, force: true });
        renameSync(previousUploads, uploadsDirectory);
      }
      throw error;
    }
  }
  try {
    client.pragma("busy_timeout = 5000");
    client.pragma("journal_mode = WAL");
    client.pragma("foreign_keys = OFF");
    migrate(db, { migrationsFolder });
    client.pragma("foreign_keys = ON");
  } catch (error) {
    client.close();
    throw error;
  }

  function getSession(id: string): Session | null {
    return db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get() ?? null;
  }

  function getPlayer(playerId: string) {
    return db.select({
      id: schema.players.id,
      sessionId: schema.players.sessionId,
      sessionName: schema.sessions.name,
      displayName: schema.players.displayName,
      status: schema.players.status,
      removedAt: schema.players.removedAt,
      createdAt: schema.players.createdAt,
      characterId: schema.characters.id,
      characterName: schema.characters.name,
      assignmentReleasedAt: schema.sessionCharacterAssignments.releasedAt
    }).from(schema.players)
      .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
      .leftJoin(schema.sessionCharacterAssignments, and(
        eq(schema.sessionCharacterAssignments.playerId, schema.players.id),
        eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId),
        isNull(schema.sessionCharacterAssignments.releasedAt)
      ))
      .leftJoin(schema.characters, eq(schema.characters.id, schema.sessionCharacterAssignments.characterId))
      .where(eq(schema.players.id, playerId)).get() ?? null;
  }

  function equipInventoryItemInTransaction(characterId: string, inventoryItemId: string) {
    const character = db.select({ campaignId: schema.characters.campaignId }).from(schema.characters)
      .where(eq(schema.characters.id, characterId)).get();
    if (!character) throw new Error("Character not found.");
    const item = db.select().from(schema.inventoryItems)
      .where(and(eq(schema.inventoryItems.id, inventoryItemId), eq(schema.inventoryItems.characterId, characterId))).get();
    if (!item) throw new Error("Inventory item not found for this character.");
    if (item.equippedSlot !== null) throw new Error("Inventory item is already equipped.");
    if (!item.catalogItemId) throw new Error("Legacy inventory item cannot be equipped.");
    if (item.quantity !== 1) throw new Error("Only a single item can be equipped; split stacks are not supported.");
    const catalogItem = db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, item.catalogItemId)).get();
    if (!catalogItem || catalogItem.campaignId !== character.campaignId) throw new Error("Catalog item is not in this character's campaign.");
    if (catalogItem.equipmentSlot === null) throw new Error("Catalog item cannot be equipped.");
    const occupied = db.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(and(
      eq(schema.inventoryItems.characterId, characterId), eq(schema.inventoryItems.equippedSlot, catalogItem.equipmentSlot)
    )).get();
    if (occupied) throw new Error("Equipment slot is already occupied.");
    return db.update(schema.inventoryItems).set({ equippedSlot: catalogItem.equipmentSlot })
      .where(eq(schema.inventoryItems.id, item.id)).returning().get();
  }

  function unequipInventoryItemInTransaction(characterId: string, inventoryItemId: string) {
    const item = db.select().from(schema.inventoryItems)
      .where(and(eq(schema.inventoryItems.id, inventoryItemId), eq(schema.inventoryItems.characterId, characterId))).get();
    if (!item) throw new Error("Inventory item not found for this character.");
    if (item.equippedSlot === null) throw new Error("Inventory item is not equipped.");
    const character = db.select({ campaignId: schema.characters.campaignId, inventoryCapacity: schema.characters.inventoryCapacity }).from(schema.characters)
      .where(eq(schema.characters.id, characterId)).get();
    if (!character) throw new Error("Character not found.");
    const catalogItem = item.catalogItemId ? db.select().from(schema.catalogItems)
      .where(eq(schema.catalogItems.id, item.catalogItemId)).get() : null;
    if (!catalogItem || catalogItem.campaignId !== character.campaignId || catalogItem.equipmentSlot !== item.equippedSlot || item.quantity !== 1) {
      throw new Error("Equipped inventory item is invalid.");
    }
    const usedSlots = client.prepare("SELECT count(*) AS count FROM inventory_items WHERE character_id=? AND equipped_slot IS NULL")
      .get(characterId) as { count: number };
    const bagStack = db.select().from(schema.inventoryItems).where(and(
      eq(schema.inventoryItems.characterId, characterId), eq(schema.inventoryItems.catalogItemId, item.catalogItemId!),
      isNull(schema.inventoryItems.equippedSlot)
    )).get();
    if (bagStack) {
      if (bagStack.quantity >= 9999) throw new Error("Item quantity limit exceeded.");
      db.update(schema.inventoryItems).set({ quantity: bagStack.quantity + 1 })
        .where(eq(schema.inventoryItems.id, bagStack.id)).run();
      db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.id, item.id)).run();
      return db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, bagStack.id)).get()!;
    }
    if (usedSlots.count >= character.inventoryCapacity) throw new Error("Inventory capacity is full.");
    return db.update(schema.inventoryItems).set({ equippedSlot: null })
      .where(eq(schema.inventoryItems.id, item.id)).returning().get();
  }

  function inventoryMutationContext(tokenHash: string, inventoryItemId: string) {
    const active = requireActivePlayerCharacter(tokenHash);
    const item = db.select().from(schema.inventoryItems).where(and(
      eq(schema.inventoryItems.id, inventoryItemId), eq(schema.inventoryItems.characterId, active.characterId)
    )).get();
    if (!item) throw new Error("Inventory item not found for this character.");
    const character = db.select({ archivedAt: schema.characters.archivedAt, inventoryCapacity: schema.characters.inventoryCapacity })
      .from(schema.characters).where(and(eq(schema.characters.id, active.characterId), eq(schema.characters.campaignId, active.campaignId))).get();
    if (!character || character.archivedAt) throw new Error("Active character access required.");
    let catalogItem: typeof schema.catalogItems.$inferSelect | null = null;
    if (item.catalogItemId !== null) {
      catalogItem = db.select().from(schema.catalogItems).where(and(
        eq(schema.catalogItems.id, item.catalogItemId), eq(schema.catalogItems.campaignId, active.campaignId)
      )).get() ?? null;
      if (!catalogItem) throw new Error("Inventory catalog relation is invalid.");
    }
    return { active, item, character, catalogItem };
  }

  function existingInventoryOperation(operationId: string, intent: {
    type: "item_transferred" | "item_discarded"; inventoryItemId: string; quantity: number;
    recipientCharacterId?: string;
  }, active: ReturnType<typeof activePlayerCharacter> & {}) {
    const previous = db.select().from(schema.campaignActivity)
      .where(eq(schema.campaignActivity.operationId, operationId)).get();
    if (!previous) {
      const knowledgeOperation = db.select({ id: schema.knowledgeFactReveals.id }).from(schema.knowledgeFactReveals)
        .where(eq(schema.knowledgeFactReveals.operationId, operationId)).get();
      if (knowledgeOperation) throw new Error("Inventory operation ID conflict.");
      return false;
    }
    const details = transferRecord(JSON.parse(previous.payload) as unknown);
    const matches = previous.type === intent.type && previous.campaignId === active.campaignId &&
      previous.sessionId === active.sessionId && previous.playerId === active.playerId && previous.characterId === active.characterId &&
      previous.relatedCharacterId === (intent.recipientCharacterId ?? null) && details.sourceInventoryItemId === intent.inventoryItemId &&
      details.quantity === intent.quantity;
    if (!matches) throw new Error("Inventory operation ID conflict.");
    return true;
  }

  function eligibleTransferTargets(active: NonNullable<ReturnType<typeof activePlayerCharacter>>, item: typeof schema.inventoryItems.$inferSelect) {
    const characters = client.prepare(`SELECT c.id AS characterId, c.name AS characterName, c.inventory_capacity AS inventoryCapacity,
      (SELECT count(*) FROM inventory_items i WHERE i.character_id=c.id AND i.equipped_slot IS NULL) AS bagSlotsUsed,
      CASE WHEN ? IS NULL THEN NULL ELSE (SELECT i.quantity FROM inventory_items i WHERE i.character_id=c.id
        AND i.catalog_item_id=? AND i.equipped_slot IS NULL) END AS existingStackQuantity
      FROM session_character_assignments a
      JOIN players p ON p.id=a.player_id AND p.session_id=a.session_id AND p.status='approved'
        AND p.removed_at IS NULL
      JOIN sessions s ON s.id=a.session_id AND s.status='active' AND s.removed_at IS NULL
      JOIN characters c ON c.id=a.character_id AND c.campaign_id=? AND c.archived_at IS NULL
      WHERE a.session_id=? AND a.released_at IS NULL AND c.id!=?
      ORDER BY c.name COLLATE NOCASE, c.id`).all(item.catalogItemId, item.catalogItemId,
      active.campaignId, active.sessionId, active.characterId) as {
        characterId: string; characterName: string; inventoryCapacity: number; bagSlotsUsed: number; existingStackQuantity: number | null
      }[];
    return characters.map((target) => {
      const willMerge = item.catalogItemId !== null && target.existingStackQuantity !== null;
      const maxQuantity = willMerge ? Math.max(0, 9999 - target.existingStackQuantity!)
        : target.bagSlotsUsed < target.inventoryCapacity ? 9999 : 0;
      return { characterId: target.characterId, characterName: target.characterName, bagSlotsUsed: target.bagSlotsUsed,
        inventoryCapacity: target.inventoryCapacity, willMerge, maxQuantity };
    });
  }

  function projectPlayerActivity(active: NonNullable<ReturnType<typeof activePlayerCharacter>>, knowledge: PlayerKnowledgeEntry[]): PlayerActivityEvent[] {
    const relevant: PlayerActivityEvent[] = [];
    const safeEntries = new Map(knowledge.map((entry) => [entry.id, entry]));
    const sessionNames = new Map(db.select({ id: schema.sessions.id, name: schema.sessions.name }).from(schema.sessions)
      .where(eq(schema.sessions.campaignId, active.campaignId)).all().map((session) => [session.id, session.name]));
    const playerProjectionTypes: ActivityType[] = ["knowledge_created", "knowledge_visibility_changed", "item_granted", "knowledge_fact_revealed", "item_transferred", "item_discarded"];
    const campaignEvents = activityRows(db.select().from(schema.campaignActivity)
      .where(and(eq(schema.campaignActivity.campaignId, active.campaignId), inArray(schema.campaignActivity.type, playerProjectionTypes)))
      .orderBy(asc(schema.campaignActivity.createdAt), asc(schema.campaignActivity.id)).all());
    const summaryStates = new Map<string, { visibility: KnowledgeVisibility; characterId: string | null | undefined }>();
    const canSeeSummary = (state: { visibility: KnowledgeVisibility; characterId: string | null | undefined }) => {
      if (state.visibility === "party") return true;
      if (state.visibility === "hidden") return false;
      return state.characterId === undefined ? null : state.characterId === active.characterId;
    };
    for (const event of campaignEvents) {
      if (event.type === "knowledge_created" && event.knowledgeEntryId && !summaryStates.has(event.knowledgeEntryId)) {
        summaryStates.set(event.knowledgeEntryId, { visibility: "hidden", characterId: null });
      }
      if (event.type === "knowledge_visibility_changed" && event.knowledgeEntryId) {
        const previous = summaryStates.get(event.knowledgeEntryId) ?? {
          visibility: event.details.previousVisibility ?? "hidden",
          characterId: event.details.previousVisibility === "character" ? undefined : null
        };
        const next: { visibility: KnowledgeVisibility; characterId: string | null | undefined } = {
          visibility: event.details.visibility ?? "hidden",
          characterId: event.details.visibility === "character" ? event.characterId ?? undefined : null
        };
        const openedToCharacter = canSeeSummary(previous) === false && canSeeSummary(next) === true;
        summaryStates.set(event.knowledgeEntryId, next);
        const entry = safeEntries.get(event.knowledgeEntryId);
        if (openedToCharacter && entry?.summaryVisible) relevant.push({
          id: event.id, kind: "knowledge_summary_opened", createdAt: event.createdAt,
          sessionId: event.sessionId, sessionName: event.sessionId ? sessionNames.get(event.sessionId) ?? null : null,
          knowledgeEntryId: entry.id, knowledgeTitle: entry.title
        });
        continue;
      }
      if (event.type === "item_granted" && event.characterId === active.characterId) {
        relevant.push({
          id: event.id, kind: "item_received", createdAt: event.createdAt,
          sessionId: event.sessionId, sessionName: event.sessionId ? sessionNames.get(event.sessionId) ?? null : null,
          itemName: event.details.itemName ?? "Предмет",
          quantity: Number.isInteger(event.details.quantity) && (event.details.quantity ?? 0) > 0 ? event.details.quantity! : 1
        });
        continue;
      }
      if (event.type === "item_transferred") {
        const isSender = event.characterId === active.characterId;
        const isRecipient = event.relatedCharacterId === active.characterId;
        if (isSender !== isRecipient) {
          const otherCharacterId = isSender ? event.relatedCharacterId : event.characterId;
          const otherCharacter = otherCharacterId ? db.select({ name: schema.characters.name }).from(schema.characters)
            .where(and(eq(schema.characters.id, otherCharacterId), eq(schema.characters.campaignId, active.campaignId))).get() : null;
          if (otherCharacter) relevant.push({
            id: event.id, kind: "item_transferred", direction: isSender ? "sent" : "received",
            createdAt: event.createdAt, sessionId: event.sessionId,
            sessionName: event.sessionId ? sessionNames.get(event.sessionId) ?? null : null,
            itemName: event.details.itemName ?? "Предмет",
            quantity: Number.isInteger(event.details.quantity) && (event.details.quantity ?? 0) > 0 ? event.details.quantity! : 1,
            otherCharacterName: otherCharacter.name
          });
        }
        continue;
      }
      if (event.type === "item_discarded" && event.characterId === active.characterId) {
        relevant.push({
          id: event.id, kind: "item_discarded", createdAt: event.createdAt,
          sessionId: event.sessionId, sessionName: event.sessionId ? sessionNames.get(event.sessionId) ?? null : null,
          itemName: event.details.itemName ?? "Предмет",
          quantity: Number.isInteger(event.details.quantity) && (event.details.quantity ?? 0) > 0 ? event.details.quantity! : 1
        });
        continue;
      }
      if (event.type === "knowledge_fact_revealed" && event.knowledgeEntryId) {
        const entry = safeEntries.get(event.knowledgeEntryId);
        const visibleAudience = event.details.audience === "party" && event.characterId === null ||
          event.details.audience === "character" && event.characterId === active.characterId;
        if (entry && visibleAudience) relevant.push({
          id: event.id, kind: "knowledge_facts_revealed", createdAt: event.createdAt,
          sessionId: event.sessionId, sessionName: event.sessionId ? sessionNames.get(event.sessionId) ?? null : null,
          knowledgeEntryId: entry.id, knowledgeTitle: entry.title
        });
      }
    }
    relevant.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    return relevant;
  }

  type CleanupDisposition = "deleted" | "removed";

  function cleanupSessionState(campaignId: string, sessionId: string) {
    const session = db.select().from(schema.sessions).where(and(
      eq(schema.sessions.id, sessionId), eq(schema.sessions.campaignId, campaignId)
    )).get();
    if (!session) return null;
    if (session.removedAt) return { session, disposition: "removed" as const };
    if (session.status === "active") throw new Error("Active session cannot be removed.");
    const blockers = client.prepare(`SELECT
      EXISTS(SELECT 1 FROM campaign_activity WHERE session_id=?) OR
      EXISTS(SELECT 1 FROM knowledge_fact_reveals WHERE session_id=?) OR
      EXISTS(SELECT 1 FROM session_character_assignments WHERE session_id=?) OR
      EXISTS(SELECT 1 FROM session_character_assignments a JOIN players p ON p.id=a.player_id WHERE p.session_id=?) OR
      EXISTS(SELECT 1 FROM players p WHERE p.session_id=? AND p.status='approved') OR
      EXISTS(SELECT 1 FROM players p JOIN campaign_activity a ON a.player_id=p.id WHERE p.session_id=?) AS blocked`)
      .get(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId) as { blocked: number };
    return { session, disposition: blockers.blocked ? "removed" as const : "deleted" as const };
  }

  function cleanupPlayerState(campaignId: string, playerId: string) {
    const player = db.select({
      id: schema.players.id, sessionId: schema.players.sessionId, status: schema.players.status,
      removedAt: schema.players.removedAt, sessionCampaignId: schema.sessions.campaignId
    }).from(schema.players).innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
      .where(and(eq(schema.players.id, playerId), eq(schema.sessions.campaignId, campaignId))).get();
    if (!player) return null;
    const assignment = db.select({ characterId: schema.sessionCharacterAssignments.characterId, releasedAt: schema.sessionCharacterAssignments.releasedAt })
      .from(schema.sessionCharacterAssignments).where(eq(schema.sessionCharacterAssignments.playerId, playerId)).get();
    if (player.removedAt) return { player, assignment, disposition: "removed" as const };
    const references = client.prepare(`SELECT
      EXISTS(SELECT 1 FROM campaign_activity WHERE player_id=?) OR
      EXISTS(SELECT 1 FROM session_character_assignments WHERE player_id=?) AS blocked`)
      .get(playerId, playerId) as { blocked: number };
    const disposition = player.status === "approved" || references.blocked
      ? "removed" as const : "deleted" as const;
    return { player, assignment, disposition };
  }

  return {
    file,
    close(): void {
      client.close();
    },
    async createBackup() {
      return createBackup();
    },
    listBackups() {
      if (!statSync(backupsDirectory, { throwIfNoEntry: false })?.isDirectory()) return [];
      return readdirSync(backupsDirectory).flatMap((filename) => {
        const match = backupIdPattern.exec(filename);
        if (!match) return [];
        const file = join(backupsDirectory, filename);
        const info = statSync(file);
        return info.isFile() ? [{ id: filename, createdAt: info.mtime.toISOString(), size: info.size }] : [];
      }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    backupFile(id: string) {
      return resolveBackup(id);
    },
    async restoreBackup(id: string) {
      return restoreBackup(id);
    },
    checkDataHealth(): DataHealth {
      const checks: HealthCheck[] = [];
      const check = (name: string, run: () => { status: HealthCheck["status"]; message: string }) => {
        try { checks.push({ name, ...run() }); }
        catch { checks.push({ name, status: "error", message: "Проверка не выполнена. Проверьте доступ к локальным данным." }); }
      };
      check("Целостность SQLite", () => client.pragma("integrity_check", { simple: true }) === "ok"
        ? { status: "ok", message: "Структура базы цела." }
        : { status: "error", message: "SQLite обнаружил повреждение базы." });
      check("Внешние ключи", () => {
        const count = (client.pragma("foreign_key_check") as unknown[]).length;
        return count === 0 ? { status: "ok", message: "Нарушений ссылок нет." }
          : { status: "error", message: `Найдено нарушений ссылок: ${count}.` };
      });
      check("Миграции", () => {
        const expected = readMigrationFiles({ migrationsFolder });
        return migrationHistoryMatches(client, true) ? { status: "ok", message: `Применены все миграции: ${expected.length}.` }
          : { status: "error", message: "Версия схемы не соответствует ожидаемым миграциям." };
      });
      for (const [name, path] of [
        ["База данных", dirname(file === ":memory:" ? join(backupsDirectory, "game.db") : file)],
        ["Резервные копии", backupsDirectory], ["Загрузки", uploadsDirectory],
        ...["monsters", "characters", "items"].map((category) => [`Загрузки: ${category}`, join(uploadsDirectory, category)])
      ]) {
        check(name!, () => {
          const present = statSync(path!, { throwIfNoEntry: false })?.isDirectory();
          if (present) accessSync(path!, constants.R_OK | constants.W_OK);
          return present ? { status: "ok", message: "Каталог доступен." }
            : { status: "error", message: "Каталог отсутствует." };
        });
      }
      const domainQueries = [
        ["Назначения персонажей", "SELECT count(*) AS count FROM session_character_assignments a JOIN sessions s ON s.id=a.session_id JOIN players p ON p.id=a.player_id JOIN characters c ON c.id=a.character_id WHERE p.session_id!=a.session_id OR c.campaign_id!=s.campaign_id"],
        ["Категории знаний", "SELECT count(*) AS count FROM knowledge_entries WHERE category NOT IN ('character', 'place', 'creature', 'item', 'event', 'fact')"],
        ["Личные знания", "SELECT count(*) AS count FROM knowledge_entries k JOIN characters c ON c.id=k.visible_to_character_id WHERE c.campaign_id!=k.campaign_id"],
        ["Факты знаний", `SELECT count(*) AS count FROM knowledge_facts f
          LEFT JOIN knowledge_entries k ON k.id=f.knowledge_entry_id
          WHERE k.id IS NULL OR k.campaign_id!=f.campaign_id OR typeof(f.body)!='text' OR length(trim(f.body)) NOT BETWEEN 1 AND 2000 OR
          typeof(f.position)!='integer' OR f.position<0 OR EXISTS (
            SELECT 1 FROM knowledge_facts d WHERE d.knowledge_entry_id=f.knowledge_entry_id AND d.position=f.position AND d.id!=f.id
          )`],
        ["Раскрытие фактов", `SELECT count(*) AS count FROM knowledge_fact_reveals r
          LEFT JOIN knowledge_facts f ON f.id=r.knowledge_fact_id
          LEFT JOIN characters c ON c.id=r.character_id
          LEFT JOIN sessions s ON s.id=r.session_id
          WHERE f.id IS NULL OR f.campaign_id!=r.campaign_id OR
            r.audience NOT IN ('party','character') OR
            (r.audience='party' AND r.character_id IS NOT NULL) OR
            (r.audience='character' AND (c.id IS NULL OR c.campaign_id!=r.campaign_id)) OR
            (r.session_id IS NOT NULL AND (s.id IS NULL OR s.campaign_id!=r.campaign_id)) OR
            (r.audience='party' AND EXISTS (SELECT 1 FROM knowledge_fact_reveals d WHERE d.knowledge_fact_id=r.knowledge_fact_id AND d.audience='party' AND d.id!=r.id)) OR
            (r.audience='character' AND EXISTS (SELECT 1 FROM knowledge_fact_reveals d WHERE d.knowledge_fact_id=r.knowledge_fact_id AND d.character_id=r.character_id AND d.audience='character' AND d.id!=r.id))`],
        ["Вместимость сумок", `SELECT count(*) AS count FROM characters c WHERE typeof(c.inventory_capacity)!='integer' OR c.inventory_capacity<0 OR
          (SELECT count(*) FROM inventory_items i WHERE i.character_id=c.id AND i.equipped_slot IS NULL)>c.inventory_capacity`],
        ["Каталог предметов", `SELECT count(*) AS count FROM catalog_items WHERE typeof(description)!='text' OR length(description)>2000 OR
          category NOT IN ('key','document','tool','consumable','equipment','artifact','special') OR
          (rarity IS NOT NULL AND rarity NOT IN ('common','uncommon','rare','unique')) OR
          (equipment_slot IS NOT NULL AND equipment_slot NOT IN ('primary','secondary','armor','accessory','tool','special')) OR
          typeof(transfer_allowed)!='integer' OR transfer_allowed NOT IN (0,1) OR
          typeof(discard_allowed)!='integer' OR discard_allowed NOT IN (0,1)`],
        ["Инвентарь и экипировка", `SELECT count(*) AS count FROM inventory_items i
          LEFT JOIN characters c ON c.id=i.character_id
          LEFT JOIN catalog_items ci ON ci.id=i.catalog_item_id
          WHERE c.id IS NULL OR typeof(i.quantity)!='integer' OR i.quantity NOT BETWEEN 1 AND 9999 OR
            (ci.id IS NOT NULL AND c.campaign_id!=ci.campaign_id) OR
            (i.equipped_slot IS NOT NULL AND (i.equipped_slot NOT IN ('primary','secondary','armor','accessory','tool','special') OR
              ci.id IS NULL OR i.quantity!=1 OR ci.equipment_slot IS NOT i.equipped_slot)) OR
            EXISTS (SELECT 1 FROM inventory_items d WHERE d.character_id=i.character_id AND d.id!=i.id AND
              i.equipped_slot IS NOT NULL AND d.equipped_slot=i.equipped_slot) OR
            EXISTS (SELECT 1 FROM inventory_items d WHERE d.character_id=i.character_id AND d.id!=i.id AND
              i.catalog_item_id IS NOT NULL AND d.catalog_item_id=i.catalog_item_id AND
              i.equipped_slot IS NULL AND d.equipped_slot IS NULL)`],
        ["Активные игроки", "SELECT count(*) AS count FROM players p JOIN sessions s ON s.id=p.session_id LEFT JOIN session_character_assignments a ON a.player_id=p.id AND a.released_at IS NULL WHERE p.removed_at IS NULL AND s.removed_at IS NULL AND p.status='approved' AND s.status='active' AND a.player_id IS NULL"],
        ["Архивные персонажи", "SELECT count(*) AS count FROM session_character_assignments a JOIN characters c ON c.id=a.character_id JOIN sessions s ON s.id=a.session_id JOIN players p ON p.id=a.player_id WHERE a.released_at IS NULL AND p.removed_at IS NULL AND s.removed_at IS NULL AND c.archived_at IS NOT NULL AND s.status='active' AND p.status='approved'"],
        ["Отметки просмотра", "SELECT count(*) AS count FROM character_read_state r JOIN characters c ON c.id=r.character_id LEFT JOIN campaign_activity a ON a.id=r.last_seen_id WHERE a.id IS NULL OR a.campaign_id!=c.campaign_id OR a.created_at!=r.last_seen_at"],
        ["История кампании", "SELECT count(*) AS count FROM campaign_activity a LEFT JOIN sessions s ON s.id=a.session_id LEFT JOIN players p ON p.id=a.player_id LEFT JOIN characters c ON c.id=a.character_id LEFT JOIN catalog_items i ON i.id=a.catalog_item_id LEFT JOIN knowledge_entries k ON k.id=a.knowledge_entry_id LEFT JOIN characters r ON r.id=a.related_character_id WHERE (s.id IS NOT NULL AND s.campaign_id!=a.campaign_id) OR (p.id IS NOT NULL AND (a.session_id IS NULL OR p.session_id!=a.session_id)) OR (c.id IS NOT NULL AND c.campaign_id!=a.campaign_id) OR (i.id IS NOT NULL AND i.campaign_id!=a.campaign_id) OR (k.id IS NOT NULL AND k.campaign_id!=a.campaign_id) OR (a.related_character_id IS NOT NULL AND (r.id IS NULL OR r.campaign_id!=a.campaign_id))"],
        ["Передачи и выбрасывание", `SELECT count(*) AS count FROM campaign_activity a
          LEFT JOIN characters sender ON sender.id=a.character_id AND sender.campaign_id=a.campaign_id
          LEFT JOIN characters recipient ON recipient.id=a.related_character_id AND recipient.campaign_id=a.campaign_id
          LEFT JOIN sessions s ON s.id=a.session_id AND s.campaign_id=a.campaign_id
          LEFT JOIN players p ON p.id=a.player_id AND p.session_id=a.session_id
          WHERE a.type IN ('item_transferred','item_discarded') AND (
            sender.id IS NULL OR s.id IS NULL OR p.id IS NULL OR p.status!='approved' OR
            json_type(a.payload,'$.itemName') IS NOT 'text' OR coalesce(length(trim(json_extract(a.payload,'$.itemName'))),0)=0 OR
            json_type(a.payload,'$.quantity') IS NOT 'integer' OR CAST(json_extract(a.payload,'$.quantity') AS integer) NOT BETWEEN 1 AND 9999 OR
            json_type(a.payload,'$.sourceInventoryItemId') IS NOT 'text' OR length(json_extract(a.payload,'$.sourceInventoryItemId'))!=36 OR
            NOT EXISTS (SELECT 1 FROM session_character_assignments a_sender WHERE a_sender.session_id=a.session_id AND a_sender.player_id=a.player_id AND a_sender.character_id=a.character_id) OR
            (a.type='item_transferred' AND (recipient.id IS NULL OR recipient.id=sender.id OR NOT EXISTS (
              SELECT 1 FROM session_character_assignments a_target JOIN players p_target ON p_target.id=a_target.player_id
              WHERE a_target.session_id=a.session_id AND a_target.character_id=a.related_character_id AND p_target.status='approved'))) OR
            (a.type='item_discarded' AND a.related_character_id IS NOT NULL)
          )`],
        ["Личные заметки", "SELECT count(*) AS count FROM character_personal_notes n LEFT JOIN characters c ON c.id=n.character_id WHERE c.id IS NULL OR length(n.title)>120 OR length(trim(n.body)) NOT BETWEEN 1 AND 2000 OR n.marker NOT IN ('normal', 'important', 'check', 'question') OR typeof(n.pinned)!='integer' OR n.pinned NOT IN (0, 1)"]
      ] as const;
      for (const [name, query] of domainQueries) check(name, () => {
        const count = (client.prepare(query).get() as { count: number }).count;
        return count === 0 ? { status: "ok", message: "Нарушений не найдено." }
          : { status: "error", message: `Найдено несогласованных записей: ${count}.` };
      });
      check("Жизненный цикл сессий и игроков", () => {
        const sessions = client.prepare("SELECT status, removed_at FROM sessions").all() as { status: string; removed_at: string | null }[];
        const players = client.prepare("SELECT removed_at FROM players").all() as { removed_at: string | null }[];
        const assignments = client.prepare("SELECT released_at FROM session_character_assignments").all() as { released_at: string | null }[];
        const badTimestamps = [...sessions.map((row) => row.removed_at), ...players.map((row) => row.removed_at), ...assignments.map((row) => row.released_at)]
          .filter((value) => value !== null && !validLifecycleTimestamp(value)).length;
        const invalid = client.prepare(`SELECT
          (SELECT count(*) FROM sessions WHERE removed_at IS NOT NULL AND status='active') +
          (SELECT count(*) FROM players p JOIN session_character_assignments a ON a.player_id=p.id WHERE p.removed_at IS NOT NULL AND a.released_at IS NULL) +
          (SELECT count(*) FROM session_character_assignments a JOIN players p ON p.id=a.player_id WHERE a.released_at IS NULL AND p.session_id!=a.session_id) +
          (SELECT count(*) FROM session_character_assignments a JOIN sessions s ON s.id=a.session_id JOIN characters c ON c.id=a.character_id WHERE a.released_at IS NULL AND c.campaign_id!=s.campaign_id) AS count`).get() as { count: number };
        const duplicateAssignments = client.prepare(`SELECT count(*) AS count FROM (
          SELECT session_id, character_id FROM session_character_assignments WHERE released_at IS NULL GROUP BY session_id, character_id HAVING count(*)>1
        )`).get() as { count: number };
        const duplicateNames = new Set<string>();
        const names = client.prepare("SELECT session_id, display_name FROM players WHERE removed_at IS NULL").all() as { session_id: string; display_name: string }[];
        const seenNames = new Set<string>();
        for (const row of names) {
          const key = `${row.session_id}:${row.display_name.trim().toLocaleLowerCase("ru")}`;
          if (seenNames.has(key)) duplicateNames.add(key);
          seenNames.add(key);
        }
        const issueCount = badTimestamps + invalid.count + duplicateAssignments.count + duplicateNames.size;
        return issueCount === 0 ? { status: "ok", message: "Отозванные записи, назначения и активные имена согласованы." }
          : { status: "error", message: `Найдены нарушения жизненного цикла: ${issueCount}.` };
      });
      check("Идентификаторы операций с предметами", () => {
        const rows = client.prepare("SELECT payload FROM campaign_activity WHERE type IN ('item_transferred','item_discarded')").all() as { payload: string }[];
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const invalid = rows.filter((row) => {
          try { return !uuid.test(String((JSON.parse(row.payload) as Record<string, unknown>).sourceInventoryItemId ?? "")); }
          catch { return true; }
        }).length;
        return invalid === 0 ? { status: "ok", message: "Ссылки на исходные строки инвентаря корректны." }
          : { status: "error", message: `Найдено событий с некорректными ссылками на предметы: ${invalid}.` };
      });
      check("Профили персонажей", () => {
        const rows = client.prepare("SELECT traits, appearance, quote FROM characters").all() as { traits: string; appearance: string; quote: string }[];
        const invalid = rows.filter((row) => !storedTraitsAreValid(row.traits) || typeof row.appearance !== "string" ||
          row.appearance.length > 1000 || typeof row.quote !== "string" || row.quote.length > 300).length;
        return invalid === 0 ? { status: "ok", message: "Поля профилей и черты персонажей корректны." }
          : { status: "error", message: `Найдено профилей с некорректными чертами, внешностью или цитатой: ${invalid}.` };
      });
      check("Определения полей профиля", () => {
        const rows = client.prepare("SELECT campaign_id, label, position FROM campaign_profile_field_definitions ORDER BY campaign_id, position, id").all() as { campaign_id: string; label: string; position: number }[];
        const groups = new Map<string, typeof rows>();
        for (const row of rows) groups.set(row.campaign_id, [...(groups.get(row.campaign_id) ?? []), row]);
        const invalid = [...groups.values()].some((group) => group.length > 20 || group.some((row, index) =>
          typeof row.label !== "string" || row.label.trim().length < 1 || row.label.trim().length > 60 ||
          !Number.isInteger(row.position) || row.position !== index));
        return !invalid ? { status: "ok", message: "Поля профиля и их порядок корректны." }
          : { status: "error", message: "Найдены некорректные определения, лимит или порядок полей профиля." };
      });
      check("Значения полей профиля", () => {
        const rows = client.prepare(`SELECT count(*) AS count FROM character_profile_field_values v
          LEFT JOIN campaign_profile_field_definitions d ON d.id=v.field_id AND d.campaign_id=v.campaign_id
          LEFT JOIN characters c ON c.id=v.character_id AND c.campaign_id=v.campaign_id
          WHERE d.id IS NULL OR c.id IS NULL OR typeof(v.value)!='text' OR length(v.value)>500`).get() as { count: number };
        return rows.count === 0 ? { status: "ok", message: "Связи и значения полей персонажей корректны." }
          : { status: "error", message: `Найдено некорректных значений полей профиля: ${rows.count}.` };
      });
      checks.push({ name: "Файлы загрузок", status: "skipped", message: "Ссылок на файлы в базе пока нет; проверено наличие каталогов." });
      return { ok: checks.every((item) => item.status !== "error"), checks };
    },
    listCampaigns(): Campaign[] {
      return db.select().from(schema.campaigns).orderBy(asc(schema.campaigns.createdAt), asc(schema.campaigns.id)).all();
    },
    listCampaignActivity(campaignId: string, limit?: number): CampaignActivity[] {
      const rows = db.select().from(schema.campaignActivity).where(eq(schema.campaignActivity.campaignId, campaignId));
      if (limit !== undefined) return activityRows(rows.orderBy(desc(schema.campaignActivity.createdAt), desc(schema.campaignActivity.id)).limit(limit).all().reverse());
      return activityRows(rows.orderBy(asc(schema.campaignActivity.createdAt), asc(schema.campaignActivity.id)).all());
    },
    listSessionActivity(sessionId: string, limit?: number): CampaignActivity[] {
      const rows = db.select().from(schema.campaignActivity).where(eq(schema.campaignActivity.sessionId, sessionId));
      if (limit !== undefined) return activityRows(rows.orderBy(desc(schema.campaignActivity.createdAt), desc(schema.campaignActivity.id)).limit(limit).all().reverse());
      return activityRows(rows.orderBy(asc(schema.campaignActivity.createdAt), asc(schema.campaignActivity.id)).all());
    },
    getCampaign(id: string): Campaign | null {
      return db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get() ?? null;
    },
    listCampaignProfileFields: campaignProfileFields,
    createCampaignProfileField(campaignId: string, label: string) {
      return db.transaction(() => {
        if (!db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).get()) throw new Error("Campaign not found.");
        const fields = campaignProfileFields(campaignId);
        if (fields.length >= 20) throw new Error("Campaign profile fields limit reached.");
        return db.insert(schema.campaignProfileFieldDefinitions).values({
          id: randomUUID(), campaignId, label: profileFieldLabel(label), position: fields.length, createdAt: new Date().toISOString()
        }).returning().get();
      });
    },
    renameCampaignProfileField(campaignId: string, fieldId: string, label: string) {
      const updated = db.update(schema.campaignProfileFieldDefinitions).set({ label: profileFieldLabel(label) })
        .where(and(eq(schema.campaignProfileFieldDefinitions.campaignId, campaignId), eq(schema.campaignProfileFieldDefinitions.id, fieldId)))
        .returning().get();
      if (!updated) throw new Error("Profile field not found.");
      return updated;
    },
    reorderCampaignProfileFields(campaignId: string, fieldIds: string[]) {
      return db.transaction(() => {
        const fields = campaignProfileFields(campaignId);
        if (!Array.isArray(fieldIds) || fieldIds.length !== fields.length || new Set(fieldIds).size !== fields.length ||
          fields.some((field) => !fieldIds.includes(field.id))) throw new Error("Profile field order is invalid.");
        if (!fields.length) return fields;
        const offset = fields.length + Math.max(...fields.map((field) => field.position)) + 1;
        client.prepare("UPDATE campaign_profile_field_definitions SET position=position+? WHERE campaign_id=?").run(offset, campaignId);
        const update = client.prepare("UPDATE campaign_profile_field_definitions SET position=? WHERE campaign_id=? AND id=?");
        fieldIds.forEach((fieldId, position) => update.run(position, campaignId, fieldId));
        return campaignProfileFields(campaignId);
      });
    },
    deleteCampaignProfileField(campaignId: string, fieldId: string) {
      return db.transaction(() => {
        const deleted = db.delete(schema.campaignProfileFieldDefinitions).where(and(
          eq(schema.campaignProfileFieldDefinitions.campaignId, campaignId), eq(schema.campaignProfileFieldDefinitions.id, fieldId)
        )).returning().get();
        if (!deleted) throw new Error("Profile field not found.");
        const remaining = campaignProfileFields(campaignId);
        if (remaining.length) {
          const offset = remaining.length + Math.max(...remaining.map((field) => field.position)) + 1;
          client.prepare("UPDATE campaign_profile_field_definitions SET position=position+? WHERE campaign_id=?").run(offset, campaignId);
          const update = client.prepare("UPDATE campaign_profile_field_definitions SET position=? WHERE campaign_id=? AND id=?");
          remaining.forEach((field, position) => update.run(position, campaignId, field.id));
        }
        return deleted;
      });
    },
    updateCharacterProfileFieldValues(characterId: string, values: { fieldId: string; value: string }[]) {
      return db.transaction(() => {
        const character = db.select({ id: schema.characters.id, campaignId: schema.characters.campaignId })
          .from(schema.characters).where(eq(schema.characters.id, characterId)).get();
        if (!character) throw new Error("Character not found.");
        if (!Array.isArray(values) || values.length > 20 || new Set(values.map((entry) => entry.fieldId)).size !== values.length) {
          throw new Error("Profile field values are invalid.");
        }
        const fields = campaignProfileFields(character.campaignId);
        const fieldIds = new Set(fields.map((field) => field.id));
        if (values.some((entry) => !fieldIds.has(entry.fieldId) || typeof entry.value !== "string")) throw new Error("Profile field does not belong to this character's campaign.");
        const now = new Date().toISOString();
        for (const entry of values) {
          const value = profileFieldValue(entry.value);
          db.insert(schema.characterProfileFieldValues).values({ campaignId: character.campaignId, fieldId: entry.fieldId, characterId,
            value, updatedAt: now }).onConflictDoUpdate({
            target: [schema.characterProfileFieldValues.fieldId, schema.characterProfileFieldValues.characterId],
            set: { value, updatedAt: now }
          }).run();
        }
        return characterProfileFields(characterId, true);
      });
    },
    exportCampaign(id: string) {
      const campaign = db.select({ name: schema.campaigns.name, createdAt: schema.campaigns.createdAt })
        .from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
      if (!campaign) throw new Error("Campaign not found.");
      const sessions = db.select({
        id: schema.sessions.id, name: schema.sessions.name, status: schema.sessions.status, createdAt: schema.sessions.createdAt,
        removedAt: schema.sessions.removedAt
      }).from(schema.sessions).where(eq(schema.sessions.campaignId, id)).all();
      const sessionIds = sessions.map((session) => session.id);
      const players = sessionIds.length ? db.select({
        id: schema.players.id, sessionId: schema.players.sessionId, displayName: schema.players.displayName,
        status: schema.players.status, createdAt: schema.players.createdAt, removedAt: schema.players.removedAt
      }).from(schema.players).where(inArray(schema.players.sessionId, sessionIds)).all() : [];
      const characters = db.select({
        id: schema.characters.id, name: schema.characters.name, createdAt: schema.characters.createdAt, archivedAt: schema.characters.archivedAt,
        shortDescription: schema.characters.shortDescription, archetype: schema.characters.archetype,
        origin: schema.characters.origin, personalGoal: schema.characters.personalGoal, dmNotes: schema.characters.dmNotes,
        traits: schema.characters.traits, appearance: schema.characters.appearance, quote: schema.characters.quote,
        inventoryCapacity: schema.characters.inventoryCapacity
      }).from(schema.characters).where(eq(schema.characters.campaignId, id)).all()
        .map((character) => ({ ...character, traits: exportTraits(character.traits) }));
      const characterIds = characters.map((character) => character.id);
      const profileFields = campaignProfileFields(id);
      const profileFieldValues = profileFields.length ? db.select({
        fieldId: schema.characterProfileFieldValues.fieldId, characterId: schema.characterProfileFieldValues.characterId,
        value: schema.characterProfileFieldValues.value, updatedAt: schema.characterProfileFieldValues.updatedAt
      }).from(schema.characterProfileFieldValues)
        .where(eq(schema.characterProfileFieldValues.campaignId, id)).all() : [];
      const personalNotes = characterIds.length ? db.select().from(schema.characterPersonalNotes)
        .where(inArray(schema.characterPersonalNotes.characterId, characterIds)).all() : [];
      const assignments = sessionIds.length ? db.select({
        playerId: schema.sessionCharacterAssignments.playerId,
        sessionId: schema.sessionCharacterAssignments.sessionId,
        characterId: schema.sessionCharacterAssignments.characterId,
        createdAt: schema.sessionCharacterAssignments.createdAt,
        releasedAt: schema.sessionCharacterAssignments.releasedAt
      }).from(schema.sessionCharacterAssignments)
        .where(inArray(schema.sessionCharacterAssignments.sessionId, sessionIds)).all() : [];
      const catalogItems = db.select().from(schema.catalogItems)
        .where(eq(schema.catalogItems.campaignId, id)).all();
      const inventoryItems = characterIds.length ? db.select({
        id: schema.inventoryItems.id, characterId: schema.inventoryItems.characterId,
        catalogItemId: schema.inventoryItems.catalogItemId, name: schema.inventoryItems.name,
        quantity: schema.inventoryItems.quantity, equippedSlot: schema.inventoryItems.equippedSlot,
        createdAt: schema.inventoryItems.createdAt
      }).from(schema.inventoryItems)
        .where(inArray(schema.inventoryItems.characterId, characterIds)).all() : [];
      const knowledge = db.select({
        id: schema.knowledgeEntries.id, category: schema.knowledgeEntries.category, title: schema.knowledgeEntries.title,
        description: schema.knowledgeEntries.description, visibility: schema.knowledgeEntries.visibility,
        visibleToCharacterId: schema.knowledgeEntries.visibleToCharacterId, createdAt: schema.knowledgeEntries.createdAt
      }).from(schema.knowledgeEntries).where(eq(schema.knowledgeEntries.campaignId, id)).all()
        .map((entry) => ({ ...entry }));
      const knowledgeFacts = db.select({
        id: schema.knowledgeFacts.id, knowledgeEntryId: schema.knowledgeFacts.knowledgeEntryId,
        body: schema.knowledgeFacts.body, position: schema.knowledgeFacts.position,
        createdAt: schema.knowledgeFacts.createdAt, updatedAt: schema.knowledgeFacts.updatedAt
      }).from(schema.knowledgeFacts).where(eq(schema.knowledgeFacts.campaignId, id))
        .orderBy(asc(schema.knowledgeFacts.knowledgeEntryId), asc(schema.knowledgeFacts.position), asc(schema.knowledgeFacts.id)).all();
      const knowledgeFactReveals = db.select({
        id: schema.knowledgeFactReveals.id,
        knowledgeFactId: schema.knowledgeFactReveals.knowledgeFactId, audience: schema.knowledgeFactReveals.audience,
        characterId: schema.knowledgeFactReveals.characterId, sessionId: schema.knowledgeFactReveals.sessionId,
        createdAt: schema.knowledgeFactReveals.createdAt
      }).from(schema.knowledgeFactReveals).where(eq(schema.knowledgeFactReveals.campaignId, id))
        .orderBy(asc(schema.knowledgeFactReveals.createdAt), asc(schema.knowledgeFactReveals.id)).all();
      return {
        format: "progdm-campaign", version: 11, exportedAt: new Date().toISOString(), campaign,
        sessions, players, assignments, characters, profileFields, profileFieldValues, personalNotes, catalogItems, inventoryItems, knowledge,
        knowledgeFacts, knowledgeFactReveals,
        activity: activityRows(db.select().from(schema.campaignActivity)
          .where(eq(schema.campaignActivity.campaignId, id))
          .orderBy(asc(schema.campaignActivity.createdAt), asc(schema.campaignActivity.id)).all())
      };
    },
    importCampaign(source: unknown) {
      const archive = transferRecord(source);
      if (archive.format !== "progdm-campaign" || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(archive.version as number)) throw new Error("Campaign file format is not supported.");
      const archiveVersion = archive.version as number;
      const campaignSource = transferRecord(archive.campaign);
      const sourceCampaignName = validatedName(transferString(campaignSource, "name", 120));
      const createdAt = (record: Record<string, unknown>) => {
        const value = transferString(record, "createdAt", 64);
        if (!value || Number.isNaN(Date.parse(value))) throw new Error("Campaign file is invalid.");
        return value;
      };
      const lifecycleTimestamp = (value: unknown) => {
        if (value === null) return null;
        if (!validLifecycleTimestamp(value) || value.length > 64) throw new Error("Campaign file contains an invalid lifecycle timestamp.");
        return value;
      };
      const sessions = transferArray(archive, "sessions");
      const players = transferArray(archive, "players");
      const assignments = transferArray(archive, "assignments");
      const characters = transferArray(archive, "characters");
      const profileFields = archiveVersion >= 6 ? transferArray(archive, "profileFields") : [];
      const profileFieldValues = archiveVersion >= 6 ? transferArray(archive, "profileFieldValues") : [];
      const personalNotes = archiveVersion >= 3 ? transferArray(archive, "personalNotes") : [];
      const catalogItems = transferArray(archive, "catalogItems");
      const inventoryItems = transferArray(archive, "inventoryItems");
      const knowledge = transferArray(archive, "knowledge");
      const knowledgeFacts = archiveVersion >= 8 ? transferArray(archive, "knowledgeFacts") : [];
      const knowledgeFactReveals = archiveVersion >= 8 ? transferArray(archive, "knowledgeFactReveals") : [];
      const activity = archiveVersion === 1 ? [] : transferArray(archive, "activity");
      const campaignId = randomUUID();
      const sessionsWithPlayers = new Set(players.map((row) => transferString(row, "sessionId")));
      const sessionIds = new Map(sessions.map((row) => [transferString(row, "id"), randomUUID()]));
      const playerIds = new Map(players.map((row) => [transferString(row, "id"), randomUUID()]));
      const characterIds = new Map(characters.map((row) => [transferString(row, "id"), randomUUID()]));
      const profileFieldIds = new Map(profileFields.map((row) => [transferString(row, "id"), randomUUID()]));
      const catalogIds = new Map(catalogItems.map((row) => [transferString(row, "id"), randomUUID()]));
      const knowledgeIds = new Map(knowledge.map((row) => [transferString(row, "id"), randomUUID()]));
      const knowledgeFactIds = new Map(knowledgeFacts.map((row) => [transferString(row, "id"), randomUUID()]));
      const knowledgeFactRevealIds = new Map(knowledgeFactReveals.map((row) => [transferString(row, "id"), randomUUID()]));
      const requireMapped = (map: Map<string, string>, id: unknown) => {
        if (typeof id !== "string" || !map.has(id)) throw new Error("Campaign file contains an invalid reference.");
        return map.get(id)!;
      };
      const playerSessionIds = new Map(players.map((row) => [transferString(row, "id"), transferString(row, "sessionId")]));
      const approvedPlayers = new Set(players.filter((row) => row.status === "approved").map((row) => transferString(row, "id")));
      const assignedCharacters = new Set(assignments.map((row) => `${String(row.sessionId)}:${String(row.playerId)}:${String(row.characterId)}`));
      const approvedSessionCharacters = new Set(assignments.filter((row) => approvedPlayers.has(String(row.playerId)))
        .map((row) => `${String(row.sessionId)}:${String(row.characterId)}`));
      for (const row of sessions) {
        const id = transferString(row, "id");
        const removedAt = archiveVersion >= 11 ? lifecycleTimestamp(row.removedAt) : null;
        if (!['planned', 'active', 'ended'].includes(transferString(row, "status")) || (removedAt && row.status === "active")) {
          throw new Error("Campaign file contains an invalid session lifecycle state.");
        }
        validatedName(transferString(row, "name", 120));
        createdAt(row);
      }
      const removedPlayerIds = new Set<string>();
      const activePlayerNames = new Set<string>();
      for (const row of players) {
        const playerId = transferString(row, "id");
        const sessionId = transferString(row, "sessionId");
        if (!sessionIds.has(sessionId)) throw new Error("Campaign file contains an invalid reference.");
        if (!['pending', 'approved', 'rejected'].includes(transferString(row, "status"))) throw new Error("Campaign file is invalid.");
        const removedAt = archiveVersion >= 11 ? lifecycleTimestamp(row.removedAt) : null;
        if (removedAt) removedPlayerIds.add(playerId);
        const displayName = validatedPlayerName(transferString(row, "displayName", 60));
        if (!removedAt) {
          const nameKey = `${sessionId}:${displayName.toLocaleLowerCase("ru")}`;
          if (activePlayerNames.has(nameKey)) throw new Error("Campaign file contains duplicate active player names.");
          activePlayerNames.add(nameKey);
        }
        createdAt(row);
      }
      const activeAssignmentCharacters = new Set<string>();
      if (knowledgeIds.size !== knowledge.length || knowledgeFactIds.size !== knowledgeFacts.length ||
          knowledgeFactRevealIds.size !== knowledgeFactReveals.length) throw new Error("Campaign file contains duplicate knowledge IDs.");
      if (profileFieldIds.size !== profileFields.length || profileFields.length > 20) throw new Error("Campaign file contains invalid profile fields.");
      const positions = profileFields.map((row) => row.position);
      if (positions.some((position) => !Number.isInteger(position) || (position as number) < 0) ||
        new Set(positions).size !== positions.length || [...positions].sort((a, b) => Number(a) - Number(b)).some((position, index) => position !== index)) {
        throw new Error("Campaign file contains invalid profile field order.");
      }
      const profileValueKeys = new Set<string>();
      for (const row of profileFieldValues) {
        requireMapped(profileFieldIds, row.fieldId);
        requireMapped(characterIds, row.characterId);
        const key = `${String(row.fieldId)}:${String(row.characterId)}`;
        if (profileValueKeys.has(key)) throw new Error("Campaign file contains duplicate profile field values.");
        profileValueKeys.add(key);
        profileFieldValue(transferString(row, "value", 500));
        createdAt({ createdAt: row.updatedAt });
      }
      for (const assignment of assignments) {
        const playerId = transferString(assignment, "playerId");
        const sessionId = transferString(assignment, "sessionId");
        if (playerSessionIds.get(playerId) !== sessionId) throw new Error("Campaign file contains an invalid reference.");
        requireMapped(characterIds, assignment.characterId);
        requireMapped(sessionIds, assignment.sessionId);
        const releasedAt = archiveVersion >= 11 ? lifecycleTimestamp(assignment.releasedAt) : null;
        if (removedPlayerIds.has(playerId) && releasedAt === null) throw new Error("Campaign file contains a removed player with an active assignment.");
        if (releasedAt === null) {
          const key = `${sessionId}:${String(assignment.characterId)}`;
          if (activeAssignmentCharacters.has(key)) throw new Error("Campaign file contains duplicate active character assignments.");
          activeAssignmentCharacters.add(key);
        }
        createdAt(assignment);
      }
      const characterCapacityById = new Map<string, number>();
      for (const row of characters) {
        const sourceId = transferString(row, "id");
        characterCapacityById.set(sourceId, archiveVersion >= 9
          ? validatedInventoryCapacity(row.inventoryCapacity) : 12);
      }
      const catalogMetadataById = new Map<string, { equipmentSlot: EquipmentSlot | null }>();
      for (const row of catalogItems) {
        const sourceId = transferString(row, "id");
        catalogMetadataById.set(sourceId, archiveVersion >= 9 ? {
          equipmentSlot: validatedEquipmentSlot(row.equipmentSlot)
        } : { equipmentSlot: null });
        if (archiveVersion >= 9) {
          validatedInventoryDescription(transferString(row, "description", 2000));
          validatedInventoryCategory(row.category);
          validatedInventoryRarity(row.rarity);
          validatedInventoryPermission(row.transferAllowed, "transferAllowed");
          validatedInventoryPermission(row.discardAllowed, "discardAllowed");
        }
      }
      const bagRowsByCharacter = new Map<string, number>();
      const bagStacks = new Set<string>();
      const equipmentSlots = new Set<string>();
      for (const row of inventoryItems) {
        const characterId = transferString(row, "characterId");
        requireMapped(characterIds, characterId);
        const quantity = row.quantity;
        if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 9999) throw new Error("Campaign file is invalid.");
        const catalogItemId = row.catalogItemId === null ? null : transferString(row, "catalogItemId");
        if (catalogItemId !== null) requireMapped(catalogIds, catalogItemId);
        const equippedSlot = archiveVersion >= 9 ? validatedEquipmentSlot(row.equippedSlot) : null;
        if (equippedSlot !== null) {
          const catalog = catalogItemId === null ? null : catalogMetadataById.get(catalogItemId);
          if (quantity !== 1 || !catalog || catalog.equipmentSlot !== equippedSlot) throw new Error("Campaign file contains invalid equipment state.");
          const slotKey = `${characterId}:${equippedSlot}`;
          if (equipmentSlots.has(slotKey)) throw new Error("Campaign file contains duplicate equipment slots.");
          equipmentSlots.add(slotKey);
        } else {
          bagRowsByCharacter.set(characterId, (bagRowsByCharacter.get(characterId) ?? 0) + 1);
          if (catalogItemId !== null) {
            const stackKey = `${characterId}:${catalogItemId}`;
            if (bagStacks.has(stackKey)) throw new Error("Campaign file contains duplicate inventory stacks.");
            bagStacks.add(stackKey);
          }
        }
      }
      for (const row of characters) {
        const sourceId = transferString(row, "id");
        const capacity = characterCapacityById.get(sourceId)!;
        const usedSlots = bagRowsByCharacter.get(sourceId) ?? 0;
        if (archiveVersion < 9) characterCapacityById.set(sourceId, Math.max(12, usedSlots));
        else if (usedSlots > capacity) throw new Error("Campaign file contains over-capacity inventory.");
      }
      const newId = () => randomUUID();
      return db.transaction(() => {
        const campaign = db.insert(schema.campaigns).values({
          id: campaignId, name: sourceCampaignName, createdAt: createdAt(campaignSource)
        }).returning().get();
        for (const row of sessions) {
          const status = transferString(row, "status");
          const removedAt = archiveVersion >= 11 ? lifecycleTimestamp(row.removedAt) : null;
          if (!["planned", "active", "ended"].includes(status) || removedAt && status === "active") throw new Error("Campaign file is invalid.");
          db.insert(schema.sessions).values({
            id: requireMapped(sessionIds, row.id), campaignId, name: validatedName(transferString(row, "name", 120)),
            status: status === "active" || sessionsWithPlayers.has(transferString(row, "id"))
              ? "ended" : status as "planned" | "ended",
            joinToken: randomBytes(32).toString("base64url"), createdAt: createdAt(row), removedAt
          }).run();
        }
        for (const row of players) {
          const status = transferString(row, "status");
          if (!["pending", "approved", "rejected"].includes(status)) throw new Error("Campaign file is invalid.");
          db.insert(schema.players).values({
            id: requireMapped(playerIds, row.id), sessionId: requireMapped(sessionIds, row.sessionId),
            displayName: validatedPlayerName(transferString(row, "displayName", 60)),
            tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
            status: status as "pending" | "approved" | "rejected", createdAt: createdAt(row),
            removedAt: archiveVersion >= 11 ? lifecycleTimestamp(row.removedAt) : null
          }).run();
        }
        for (const row of characters) {
          const archivedAt = row.archivedAt;
          if (archiveVersion !== 1 && archivedAt !== null && (typeof archivedAt !== "string" || Number.isNaN(Date.parse(archivedAt)))) throw new Error("Campaign file is invalid.");
          db.insert(schema.characters).values({
            id: requireMapped(characterIds, row.id), campaignId, name: validatedName(transferString(row, "name", 120)),
            createdAt: createdAt(row), archivedAt: archiveVersion !== 1 ? archivedAt as string | null : null,
            shortDescription: archiveVersion >= 3 ? profileText(transferString(row, "shortDescription", 500), 500) : "",
            archetype: archiveVersion >= 3 ? profileText(transferString(row, "archetype", 120), 120) : "",
            origin: archiveVersion >= 3 ? profileText(transferString(row, "origin", 500), 500) : "",
            personalGoal: archiveVersion >= 3 ? profileText(transferString(row, "personalGoal", 500), 500) : "",
            dmNotes: archiveVersion >= 3 ? profileText(transferString(row, "dmNotes", 2000), 2000) : "",
            traits: JSON.stringify(archiveVersion >= 5 ? profileTraits(row.traits) : []),
            appearance: archiveVersion >= 5 ? profileText(transferString(row, "appearance", 1000), 1000) : "",
            quote: archiveVersion >= 5 ? profileText(transferString(row, "quote", 300), 300) : "",
            inventoryCapacity: characterCapacityById.get(String(row.id))!
          }).run();
        }
        for (const row of [...profileFields].sort((a, b) => Number(a.position) - Number(b.position))) {
          const position = row.position as number;
          db.insert(schema.campaignProfileFieldDefinitions).values({
            id: requireMapped(profileFieldIds, row.id), campaignId,
            label: profileFieldLabel(transferString(row, "label", 60)), position,
            createdAt: createdAt(row)
          }).run();
        }
        for (const row of profileFieldValues) db.insert(schema.characterProfileFieldValues).values({
          campaignId, fieldId: requireMapped(profileFieldIds, row.fieldId), characterId: requireMapped(characterIds, row.characterId),
          value: profileFieldValue(transferString(row, "value", 500)), updatedAt: createdAt({ createdAt: row.updatedAt })
        }).run();
        for (const row of personalNotes) {
          const metadata = archiveVersion >= 4 ? {
            title: personalNoteTitle(transferString(row, "title", 120)),
            marker: personalNoteMarker(transferString(row, "marker", 16)),
            pinned: personalNotePinned(row.pinned)
          } : { title: "", marker: "normal" as const, pinned: false };
          db.insert(schema.characterPersonalNotes).values({
            id: newId(), characterId: requireMapped(characterIds, row.characterId), ...metadata,
            body: validatedDescription(transferString(row, "body", 2000)),
            createdAt: createdAt(row), updatedAt: createdAt({ createdAt: row.updatedAt })
          }).run();
        }
        for (const row of catalogItems) db.insert(schema.catalogItems).values({
          id: requireMapped(catalogIds, row.id), campaignId, name: validatedName(transferString(row, "name", 120)),
          description: archiveVersion >= 9 ? validatedInventoryDescription(transferString(row, "description", 2000)) : "",
          category: archiveVersion >= 9 ? validatedInventoryCategory(row.category) : "special",
          rarity: archiveVersion >= 9 ? validatedInventoryRarity(row.rarity) : null,
          equipmentSlot: archiveVersion >= 9 ? validatedEquipmentSlot(row.equipmentSlot) : null,
          transferAllowed: archiveVersion >= 9 ? validatedInventoryPermission(row.transferAllowed, "transferAllowed") : true,
          discardAllowed: archiveVersion >= 9 ? validatedInventoryPermission(row.discardAllowed, "discardAllowed") : true,
          createdAt: createdAt(row)
        }).run();
        for (const row of assignments) db.insert(schema.sessionCharacterAssignments).values({
          playerId: requireMapped(playerIds, row.playerId), sessionId: requireMapped(sessionIds, row.sessionId),
          characterId: requireMapped(characterIds, row.characterId), createdAt: createdAt(row),
          releasedAt: archiveVersion >= 11 ? lifecycleTimestamp(row.releasedAt) : null
        }).run();
        for (const row of inventoryItems) {
          const quantity = row.quantity;
          if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 9999) throw new Error("Campaign file is invalid.");
          db.insert(schema.inventoryItems).values({
            id: newId(), characterId: requireMapped(characterIds, row.characterId),
            catalogItemId: row.catalogItemId === null ? null : requireMapped(catalogIds, row.catalogItemId),
            name: validatedName(transferString(row, "name", 120)), quantity: quantity as number,
            equippedSlot: archiveVersion >= 9 ? validatedEquipmentSlot(row.equippedSlot) : null,
            createdAt: createdAt(row)
          }).run();
        }
        for (const row of knowledge) {
          const sourceCategory = transferString(row, "category");
          const legacyCategoryMap: Record<string, KnowledgeCategory> = {
            npc: "character", monster: "creature", note: "fact", quest: "event"
          };
          const category = archiveVersion < 7
            ? legacyCategoryMap[sourceCategory]
            : sourceCategory as KnowledgeCategory;
          const sourceVisibility = transferString(row, "visibility");
          if (!category || !["character", "place", "creature", "item", "event", "fact"].includes(category) ||
              !["hidden", "character", "party", "player"].includes(sourceVisibility) ||
              (archiveVersion >= 7 && sourceVisibility === "player")) throw new Error("Campaign file is invalid.");
          let visibility: KnowledgeVisibility = sourceVisibility === "player" ? "hidden" : sourceVisibility as KnowledgeVisibility;
          let visibleToCharacterId: string | null = null;
          if (sourceVisibility === "character") {
            visibleToCharacterId = requireMapped(characterIds, row.visibleToCharacterId);
          } else if (sourceVisibility === "player") {
            const sourcePlayerId = typeof row.visibleToPlayerId === "string" ? row.visibleToPlayerId : "";
            const assignment = assignments.find((item) => item.playerId === sourcePlayerId);
            if (assignment && characterIds.has(String(assignment.characterId))) {
              visibility = "character";
              visibleToCharacterId = requireMapped(characterIds, assignment.characterId);
            }
          }
          db.insert(schema.knowledgeEntries).values({
            id: requireMapped(knowledgeIds, row.id), campaignId, category: category as KnowledgeCategory,
            title: validatedName(transferString(row, "title", 120)),
            description: validatedDescription(transferString(row, "description", 2000)),
            visibility, visibleToCharacterId, createdAt: createdAt(row)
          }).run();
        }
        const factPositions = new Set<string>();
        for (const row of knowledgeFacts) {
          const entryId = requireMapped(knowledgeIds, row.knowledgeEntryId);
          let position: number;
          try { position = validatedKnowledgeFactPosition(row.position as number); }
          catch { throw new Error("Campaign file contains an invalid knowledge fact position."); }
          const positionKey = `${String(row.knowledgeEntryId)}:${String(position)}`;
          if (factPositions.has(positionKey)) throw new Error("Campaign file contains duplicate knowledge fact positions.");
          factPositions.add(positionKey);
          db.insert(schema.knowledgeFacts).values({
            id: requireMapped(knowledgeFactIds, row.id), campaignId, knowledgeEntryId: entryId,
            body: validatedKnowledgeFactBody(transferString(row, "body", 2000)), position,
            createdAt: createdAt(row), updatedAt: createdAt({ createdAt: row.updatedAt })
          }).run();
        }
        const revealKeys = new Set<string>();
        for (const row of knowledgeFactReveals) {
          const audience = transferString(row, "audience", 16);
          if (audience !== "party" && audience !== "character") throw new Error("Campaign file contains an invalid knowledge fact audience.");
          let characterId: string | null = null;
          if (audience === "party") {
            if (row.characterId !== null) throw new Error("Campaign file contains an invalid knowledge fact target.");
          } else {
            characterId = requireMapped(characterIds, row.characterId);
          }
          const factId = requireMapped(knowledgeFactIds, row.knowledgeFactId);
          const sessionId = row.sessionId === null ? null : requireMapped(sessionIds, row.sessionId);
          const key = audience === "party" ? `${factId}:party` : `${factId}:character:${characterId}`;
          if (revealKeys.has(key)) throw new Error("Campaign file contains duplicate knowledge fact reveals.");
          revealKeys.add(key);
          db.insert(schema.knowledgeFactReveals).values({
            id: requireMapped(knowledgeFactRevealIds, row.id), campaignId, knowledgeFactId: factId,
            audience, characterId, sessionId, operationId: null, createdAt: createdAt(row)
          }).run();
        }
        for (const row of activity) {
          if (typeof row.type !== "string" || !ACTIVITY_TYPES.includes(row.type as ActivityType)) throw new Error("Campaign file contains an invalid event type.");
          if (archiveVersion < 10 && (row.type === "item_transferred" || row.type === "item_discarded")) throw new Error("Campaign file contains an invalid event type.");
          if (row.playerId !== null && playerSessionIds.get(String(row.playerId)) !== row.sessionId) throw new Error("Campaign file contains an invalid event session.");
          const mapped = (value: unknown, ids: Map<string, string>) => value === null ? null : requireMapped(ids, value);
          const details = parsedActivityDetails(row.details);
          const relatedCharacterId = archiveVersion >= 10 ? mapped(row.relatedCharacterId, characterIds) : null;
          if (archiveVersion >= 10 && row.type !== "item_transferred" && relatedCharacterId !== null) throw new Error("Campaign file contains an invalid related character reference.");
          if (row.type === "item_transferred" || row.type === "item_discarded") {
            const quantity = details.quantity;
            const sourceInventoryItemId = details.sourceInventoryItemId;
            const characterId = typeof row.characterId === "string" ? row.characterId : null;
            const sessionId = typeof row.sessionId === "string" ? row.sessionId : null;
            const playerId = typeof row.playerId === "string" ? row.playerId : null;
            const itemName = details.itemName;
            if (archiveVersion < 10 || !characterId || !sessionId || !playerId || !itemName ||
                !Number.isInteger(quantity) || quantity! < 1 || quantity! > 9999 ||
                typeof sourceInventoryItemId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceInventoryItemId) ||
                !approvedPlayers.has(playerId) || !assignedCharacters.has(`${sessionId}:${playerId}:${characterId}`)) {
              throw new Error("Campaign file contains an invalid inventory activity event.");
            }
            validatedName(itemName);
            if (row.catalogItemId !== null) requireMapped(catalogIds, row.catalogItemId);
            if (row.type === "item_transferred") {
              if (typeof row.relatedCharacterId !== "string" || row.relatedCharacterId === characterId || !characterIds.has(row.relatedCharacterId) ||
                  !approvedSessionCharacters.has(`${sessionId}:${row.relatedCharacterId}`)) {
                throw new Error("Campaign file contains an invalid transfer target.");
              }
            } else if (row.relatedCharacterId !== null) throw new Error("Campaign file contains an invalid discard event target.");
          }
          if (row.type === "knowledge_fact_revealed" || row.type === "knowledge_fact_access_revoked") {
            if (row.knowledgeEntryId === null || !["party", "character"].includes(String(details.audience)) ||
                !Number.isInteger(details.factCount) || (details.factCount ?? -1) < 1 || !["selected", "next", "all"].includes(String(details.scope))) {
              throw new Error("Campaign file contains an invalid knowledge fact event.");
            }
            if ((details.audience === "party" && row.characterId !== null) ||
                (details.audience === "character" && (typeof row.characterId !== "string" || !characterIds.has(row.characterId)))) {
              throw new Error("Campaign file contains an invalid knowledge fact event target.");
            }
          }
          db.insert(schema.campaignActivity).values({
            id: newId(), campaignId,
            sessionId: mapped(row.sessionId, sessionIds), playerId: mapped(row.playerId, playerIds),
            characterId: mapped(row.characterId, characterIds), relatedCharacterId,
            catalogItemId: mapped(row.catalogItemId, catalogIds),
            knowledgeEntryId: mapped(row.knowledgeEntryId, knowledgeIds),
            type: row.type, createdAt: createdAt(row), payload: JSON.stringify(details)
          }).run();
        }
        appendActivity({ campaignId, type: "campaign_imported", details: { campaignName: campaign.name } });
        for (const row of sessions) {
          const sourceStatus = transferString(row, "status");
          if (sourceStatus === "active" || (sourceStatus === "planned" && sessionsWithPlayers.has(transferString(row, "id")))) {
            appendActivity({ campaignId, sessionId: requireMapped(sessionIds, row.id), type: "session_ended", details: { sessionName: validatedName(transferString(row, "name", 120)) } });
          }
        }
        return campaign;
      });
    },
    createCampaign(name: string): Campaign {
      return db.transaction(() => {
        const campaign = db.insert(schema.campaigns).values({
          id: randomUUID(), name: validatedName(name), createdAt: new Date().toISOString()
        }).returning().get();
        appendActivity({ campaignId: campaign.id, type: "campaign_created", details: { campaignName: campaign.name } });
        return campaign;
      });
    },
    previewSessionCleanup(campaignId: string, sessionId: string) {
      const state = cleanupSessionState(campaignId, sessionId);
      return state ? { disposition: state.disposition, status: state.session.status } : null;
    },
    removeSession(campaignId: string, sessionId: string, expectedDisposition: CleanupDisposition) {
      return db.transaction(() => {
        const state = cleanupSessionState(campaignId, sessionId);
        if (!state) return null;
        if (state.session.removedAt) return { disposition: "removed" as const };
        if (state.disposition !== expectedDisposition) throw new Error("Cleanup preview changed.");
        if (state.disposition === "deleted") {
          db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
          return { disposition: "deleted" as const };
        }
        db.update(schema.sessions).set({ removedAt: new Date().toISOString() })
          .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.removedAt))).run();
        return { disposition: "removed" as const };
      });
    },
    previewPlayerCleanup(campaignId: string, playerId: string) {
      const state = cleanupPlayerState(campaignId, playerId);
      return state ? { disposition: state.disposition, releasedCharacterId: state.assignment?.releasedAt === null ? state.assignment.characterId : null } : null;
    },
    removePlayer(campaignId: string, playerId: string, expectedDisposition: CleanupDisposition) {
      return db.transaction(() => {
        const state = cleanupPlayerState(campaignId, playerId);
        if (!state) return null;
        if (state.player.removedAt) return { disposition: "removed" as const, releasedCharacterId: null };
        if (state.disposition !== expectedDisposition) throw new Error("Cleanup preview changed.");
        if (state.disposition === "deleted") {
          db.delete(schema.players).where(eq(schema.players.id, playerId)).run();
          return { disposition: "deleted" as const, releasedCharacterId: null };
        }
        const now = new Date().toISOString();
        const releasedCharacterId = state.assignment?.releasedAt === null ? state.assignment.characterId : null;
        db.update(schema.players).set({ removedAt: now })
          .where(and(eq(schema.players.id, playerId), isNull(schema.players.removedAt))).run();
        db.update(schema.sessionCharacterAssignments).set({ releasedAt: now })
          .where(and(eq(schema.sessionCharacterAssignments.playerId, playerId), isNull(schema.sessionCharacterAssignments.releasedAt))).run();
        return { disposition: "removed" as const, releasedCharacterId };
      });
    },
    listSessions(campaignId: string): Session[] {
      return db.select().from(schema.sessions).where(and(eq(schema.sessions.campaignId, campaignId), isNull(schema.sessions.removedAt)))
        .orderBy(asc(schema.sessions.createdAt), asc(schema.sessions.id)).all();
    },
    getSession,
    getJoinInfo(joinToken: string) {
      const info = db.select({
        campaignId: schema.sessions.campaignId,
        campaignName: schema.campaigns.name,
        sessionId: schema.sessions.id,
        sessionName: schema.sessions.name,
        status: schema.sessions.status
      }).from(schema.sessions)
        .innerJoin(schema.campaigns, eq(schema.sessions.campaignId, schema.campaigns.id))
        .where(and(eq(schema.sessions.joinToken, joinToken), isNull(schema.sessions.removedAt))).get();
      return info?.status === "active" ? info : null;
    },
    getPlayerByTokenHash(tokenHash: string) {
      const player = db.select({ id: schema.players.id }).from(schema.players)
        .where(and(eq(schema.players.tokenHash, tokenHash), isNull(schema.players.removedAt))).get();
      return player ? getPlayer(player.id) : null;
    },
    getPlayerState(tokenHash: string, includeRecentActivity = true) {
      const player = db.select({
        id: schema.players.id,
        campaignId: schema.sessions.campaignId,
        characterId: schema.characters.id,
        displayName: schema.players.displayName,
        status: schema.players.status,
        campaignName: schema.campaigns.name,
        sessionName: schema.sessions.name,
        characterName: schema.characters.name,
        inventoryCapacity: schema.characters.inventoryCapacity,
        shortDescription: schema.characters.shortDescription,
        archetype: schema.characters.archetype,
        origin: schema.characters.origin,
        personalGoal: schema.characters.personalGoal,
        traits: schema.characters.traits,
        appearance: schema.characters.appearance,
        quote: schema.characters.quote
      }).from(schema.players)
        .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
        .innerJoin(schema.campaigns, eq(schema.sessions.campaignId, schema.campaigns.id))
        .leftJoin(schema.sessionCharacterAssignments, and(
          eq(schema.sessionCharacterAssignments.playerId, schema.players.id),
          eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId),
          isNull(schema.sessionCharacterAssignments.releasedAt)
        ))
        .leftJoin(schema.characters, and(eq(schema.characters.id, schema.sessionCharacterAssignments.characterId),
          eq(schema.characters.campaignId, schema.sessions.campaignId), eq(schema.players.status, "approved")))
        .where(and(eq(schema.players.tokenHash, tokenHash), isNull(schema.players.removedAt))).get();
      if (!player) return null;
      const summaryRows = player.status === "approved"
        ? db.select({
          id: schema.knowledgeEntries.id, category: schema.knowledgeEntries.category, title: schema.knowledgeEntries.title,
          summary: schema.knowledgeEntries.description, createdAt: schema.knowledgeEntries.createdAt
        }).from(schema.knowledgeEntries)
          .where(and(
            eq(schema.knowledgeEntries.campaignId, player.campaignId),
            or(
              eq(schema.knowledgeEntries.visibility, "party"),
              and(
                eq(schema.knowledgeEntries.visibility, "character"),
                eq(schema.knowledgeEntries.visibleToCharacterId, player.characterId ?? "")
              )
            )
          ))
          .orderBy(asc(schema.knowledgeEntries.createdAt), asc(schema.knowledgeEntries.title), asc(schema.knowledgeEntries.id)).all()
        : [];
      const projectedEntries = new Map<string, {
        createdAt: string;
        title: string;
        entry: PlayerKnowledgeEntry;
        facts: Map<string, PlayerKnowledgeEntry["facts"][number]>;
      }>();
      for (const row of summaryRows) {
        projectedEntries.set(row.id, {
          createdAt: row.createdAt,
          title: row.title,
          entry: { id: row.id, category: row.category, title: row.title, summary: row.summary, summaryVisible: true, facts: [] },
          facts: new Map()
        });
      }
      if (player.status === "approved" && player.characterId) {
        const factRows = client.prepare(`SELECT
          e.id AS entryId, e.category AS category, e.title AS title, e.created_at AS entryCreatedAt,
          CASE WHEN e.visibility = 'party' OR (e.visibility = 'character' AND e.visible_to_character_id = ?)
            THEN e.description ELSE NULL END AS summary,
          CASE WHEN e.visibility = 'party' OR (e.visibility = 'character' AND e.visible_to_character_id = ?) THEN 1 ELSE 0 END AS summaryVisible,
          f.id AS factId, f.body AS body, f.position AS position,
          r.created_at AS revealedAt, r.session_id AS sessionId, s.name AS sessionName
          FROM knowledge_entries e
          JOIN knowledge_facts f ON f.knowledge_entry_id = e.id AND f.campaign_id = e.campaign_id
          JOIN knowledge_fact_reveals r ON r.knowledge_fact_id = f.id AND r.campaign_id = e.campaign_id
          LEFT JOIN sessions s ON s.id = r.session_id AND s.campaign_id = r.campaign_id
          WHERE e.campaign_id = ? AND (r.audience = 'party' OR (r.audience = 'character' AND r.character_id = ?))
          ORDER BY e.created_at ASC, e.title ASC, e.id ASC, f.position ASC, f.id ASC, r.created_at ASC, r.id ASC`)
          .all(player.characterId, player.characterId, player.campaignId, player.characterId) as {
            entryId: string; category: KnowledgeCategory; title: string; entryCreatedAt: string;
            summary: string | null; summaryVisible: number; factId: string; body: string; position: number;
            revealedAt: string; sessionId: string | null; sessionName: string | null;
          }[];
        for (const row of factRows) {
          let projected = projectedEntries.get(row.entryId);
          if (!projected) {
            projected = {
              createdAt: row.entryCreatedAt,
              title: row.title,
              entry: { id: row.entryId, category: row.category, title: row.title, summary: row.summary,
                summaryVisible: row.summaryVisible === 1, facts: [] },
              facts: new Map()
            };
            projectedEntries.set(row.entryId, projected);
          }
          if (!projected.facts.has(row.factId)) {
            projected.facts.set(row.factId, {
              id: row.factId, body: row.body, position: row.position, revealedAt: row.revealedAt,
              sessionId: row.sessionId, sessionName: row.sessionName
            });
          }
        }
      }
      const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
      const knowledge = [...projectedEntries.values()]
        .sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.title, right.title) || compareText(left.entry.id, right.entry.id))
        .map(({ entry, facts }) => ({
          ...entry,
          facts: [...facts.values()].sort((left, right) => left.position - right.position || compareText(left.id, right.id))
        }));
      const active = activePlayerCharacter(tokenHash);
      const relevant = active && includeRecentActivity ? projectPlayerActivity(active, knowledge).slice(0, 20) : [];
      const marker = active ? db.select().from(schema.characterReadState)
        .where(eq(schema.characterReadState.characterId, active.characterId)).get() : null;
      const isNew = (event: PlayerActivityEvent) => !marker || event.createdAt > marker.lastSeenAt ||
        event.createdAt === marker.lastSeenAt && event.id > marker.lastSeenId;
      return {
        displayName: player.displayName,
        status: player.status,
        campaignName: player.campaignName,
        sessionName: player.sessionName,
        characterName: player.characterName,
        characterId: player.characterId,
        profile: active ? {
          shortDescription: player.shortDescription ?? "", archetype: player.archetype ?? "",
          origin: player.origin ?? "", personalGoal: player.personalGoal ?? "",
          traits: player.traits ? readCharacterTraits(player.traits) : [],
          appearance: player.appearance ?? "", quote: player.quote ?? "",
          profileFields: characterProfileFields(active.characterId)
        } : null,
        canEdit: !!active,
        inventory: player.characterId ? (client.prepare(`SELECT
          i.id AS id,
          CASE WHEN c.id IS NULL THEN NULL ELSE c.id END AS catalogItemId,
          i.name AS name,
          i.quantity AS quantity,
          CASE WHEN c.id IS NULL THEN '' ELSE c.description END AS description,
          CASE WHEN c.id IS NULL OR c.category NOT IN ('key','document','tool','consumable','equipment','artifact','special') THEN 'special' ELSE c.category END AS category,
          CASE WHEN c.id IS NULL OR c.rarity NOT IN ('common','uncommon','rare','unique') THEN NULL ELSE c.rarity END AS rarity,
          CASE WHEN c.id IS NULL OR c.equipment_slot NOT IN ('primary','secondary','armor','accessory','tool','special') THEN NULL ELSE c.equipment_slot END AS equipmentSlot,
          CASE WHEN i.catalog_item_id IS NULL THEN 1 WHEN c.id IS NULL THEN 0 ELSE c.transfer_allowed END AS transferAllowed,
          CASE WHEN i.catalog_item_id IS NULL THEN 1 WHEN c.id IS NULL THEN 0 ELSE c.discard_allowed END AS discardAllowed,
          i.equipped_slot AS equippedSlot,
          i.created_at AS createdAt
          FROM inventory_items i
          LEFT JOIN catalog_items c ON c.id=i.catalog_item_id AND c.campaign_id=?
          WHERE i.character_id=?
          ORDER BY i.created_at ASC, i.name ASC, i.id ASC`).all(player.campaignId, player.characterId) as PlayerInventoryItem[]).map((item) => ({
            ...item, transferAllowed: (item.transferAllowed as unknown as number) === 1,
            discardAllowed: (item.discardAllowed as unknown as number) === 1
          })) : [],
        inventoryCapacity: player.characterId ? player.inventoryCapacity ?? null : null,
        knowledge,
        notes: active ? db.select().from(schema.characterPersonalNotes)
          .where(eq(schema.characterPersonalNotes.characterId, active.characterId))
          .orderBy(desc(schema.characterPersonalNotes.updatedAt), desc(schema.characterPersonalNotes.id)).all() : [],
        recentActivity: relevant,
        newActivity: relevant.filter(isNew)
      };
    },
    listPlayerJournal(tokenHash: string, limit = 30, cursor?: PlayerJournalCursor): PlayerJournalPage {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Journal page size is invalid.");
      const active = requireActivePlayerCharacter(tokenHash);
      const state = this.getPlayerState(tokenHash, false);
      if (!state) throw new Error("Active character access required.");
      let events = projectPlayerActivity(active, state.knowledge);
      if (cursor) events = events.filter((event) => event.createdAt < cursor.beforeCreatedAt ||
        event.createdAt === cursor.beforeCreatedAt && event.id < cursor.beforeId);
      const hasMore = events.length > limit;
      const page = events.slice(0, limit);
      const last = page.at(-1);
      return {
        events: page,
        nextCursor: hasMore && last ? { beforeCreatedAt: last.createdAt, beforeId: last.id } : null
      };
    },
    updatePlayerProfile(tokenHash: string, fields: {
      shortDescription: string; personalGoal: string; traits?: string[]; appearance?: string; quote?: string
    }) {
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        const character = db.update(schema.characters).set({
          shortDescription: profileText(fields.shortDescription, 500), personalGoal: profileText(fields.personalGoal, 500),
          ...(fields.traits === undefined ? {} : { traits: JSON.stringify(profileTraits(fields.traits)) }),
          ...(fields.appearance === undefined ? {} : { appearance: profileText(fields.appearance, 1000) }),
          ...(fields.quote === undefined ? {} : { quote: profileText(fields.quote, 300) })
        }).where(eq(schema.characters.id, active.characterId)).returning().get()!;
        appendActivity({ campaignId: active.campaignId, sessionId: active.sessionId, characterId: active.characterId,
          type: "character_profile_updated", details: { characterName: character.name } });
        return characterRecord(character);
      });
    },
    updatePlayerDisplayName(tokenHash: string, displayName: string) {
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        const name = validatedPlayerName(displayName);
        const duplicate = db.select().from(schema.players).where(and(eq(schema.players.sessionId, active.sessionId), isNull(schema.players.removedAt))).all()
          .some((player) => player.id !== active.playerId && player.displayName.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"));
        if (duplicate) throw new Error("A player with this name already requested access.");
        return db.update(schema.players).set({ displayName: name })
          .where(and(eq(schema.players.id, active.playerId), isNull(schema.players.removedAt))).returning().get();
      });
    },
    createPersonalNote(tokenHash: string, body: string, metadata: { title?: string; marker?: PersonalNoteMarker; pinned?: boolean } = {}) {
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        const now = new Date().toISOString();
        const note = db.insert(schema.characterPersonalNotes).values({
          id: randomUUID(), characterId: active.characterId, title: personalNoteTitle(metadata.title ?? ""),
          body: validatedDescription(body), marker: personalNoteMarker(metadata.marker ?? "normal"), pinned: metadata.pinned ?? false,
          createdAt: now, updatedAt: now
        }).returning().get();
        appendActivity({ campaignId: active.campaignId, sessionId: active.sessionId, characterId: active.characterId, type: "personal_note_created" });
        return note;
      });
    },
    updatePersonalNote(tokenHash: string, noteId: string,
      bodyOrFields: string | { body?: string; title?: string; marker?: PersonalNoteMarker; pinned?: boolean },
      metadata: { title?: string; marker?: PersonalNoteMarker; pinned?: boolean } = {}) {
      const fields = typeof bodyOrFields === "string" ? { body: bodyOrFields, ...metadata } : bodyOrFields;
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        const note = db.select().from(schema.characterPersonalNotes)
          .where(and(eq(schema.characterPersonalNotes.id, noteId), eq(schema.characterPersonalNotes.characterId, active.characterId))).get();
        if (!note) throw new Error("Personal note not found.");
        const updated = db.update(schema.characterPersonalNotes).set({
          body: fields.body === undefined ? note.body : validatedDescription(fields.body),
          title: fields.title === undefined ? note.title : personalNoteTitle(fields.title),
          marker: fields.marker === undefined ? note.marker as PersonalNoteMarker : personalNoteMarker(fields.marker),
          pinned: fields.pinned === undefined ? note.pinned : fields.pinned,
          updatedAt: new Date().toISOString()
        })
          .where(eq(schema.characterPersonalNotes.id, noteId)).returning().get()!;
        appendActivity({ campaignId: active.campaignId, sessionId: active.sessionId, characterId: active.characterId, type: "personal_note_updated" });
        return updated;
      });
    },
    markPlayerActivitySeen(tokenHash: string, upToActivityId: string) {
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        const visible = this.getPlayerState(tokenHash)?.recentActivity.find((event) => event.id === upToActivityId);
        if (!visible) throw new Error("Activity is not visible to this player.");
        const current = db.select().from(schema.characterReadState)
          .where(eq(schema.characterReadState.characterId, active.characterId)).get();
        if (current && (current.lastSeenAt > visible.createdAt || current.lastSeenAt === visible.createdAt && current.lastSeenId >= visible.id)) return current;
        db.insert(schema.characterReadState).values({ characterId: active.characterId, lastSeenAt: visible.createdAt, lastSeenId: visible.id })
          .onConflictDoUpdate({ target: schema.characterReadState.characterId, set: { lastSeenAt: visible.createdAt, lastSeenId: visible.id } }).run();
        return visible;
      });
    },
    submitPlayerRequest(sessionId: string, displayName: string, tokenHash: string) {
      return db.transaction(() => {
        const session = getSession(sessionId);
        if (!session || session.removedAt || session.status !== "active") throw new Error("Session is not accepting requests.");
        const name = validatedPlayerName(displayName);
        const existing = db.select().from(schema.players).where(eq(schema.players.tokenHash, tokenHash)).get();
        if (existing?.removedAt) throw new Error("Player access is unavailable.");
        if (existing && existing.sessionId !== sessionId) {
          throw new Error("This device already belongs to another session.");
        }
        if (existing && existing.status !== "rejected") return getPlayer(existing.id)!;
        const sameSession = db.select({ id: schema.players.id, displayName: schema.players.displayName })
          .from(schema.players).where(and(eq(schema.players.sessionId, sessionId), isNull(schema.players.removedAt))).all();
        if (sameSession.some((player) => player.id !== existing?.id && player.displayName.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"))) {
          throw new Error("A player with this name already requested access.");
        }
        const createdAt = new Date().toISOString();
        if (existing) {
          db.update(schema.players).set({ displayName: name, status: "pending", createdAt })
            .where(eq(schema.players.id, existing.id)).run();
          appendActivity({ campaignId: session.campaignId, sessionId, playerId: existing.id, type: "player_requested", details: { playerName: name } });
          return getPlayer(existing.id)!;
        }
        const player = db.insert(schema.players).values({
          id: randomUUID(), sessionId, displayName: name, tokenHash, status: "pending", createdAt
        }).returning().get();
        appendActivity({ campaignId: session.campaignId, sessionId, playerId: player.id, type: "player_requested", details: { playerName: name } });
        return getPlayer(player.id)!;
      });
    },
    listPlayersByCampaign(campaignId: string) {
      return db.select({
        id: schema.players.id,
        sessionId: schema.players.sessionId,
        sessionName: schema.sessions.name,
          displayName: schema.players.displayName,
          status: schema.players.status,
          removedAt: schema.players.removedAt,
          createdAt: schema.players.createdAt,
        characterId: schema.characters.id,
        characterName: schema.characters.name
      }).from(schema.players)
        .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
        .leftJoin(schema.sessionCharacterAssignments, and(
          eq(schema.sessionCharacterAssignments.playerId, schema.players.id),
          eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId),
          isNull(schema.sessionCharacterAssignments.releasedAt)
        ))
        .leftJoin(schema.characters, eq(schema.characters.id, schema.sessionCharacterAssignments.characterId))
        .where(and(eq(schema.sessions.campaignId, campaignId), isNull(schema.players.removedAt)))
        .orderBy(asc(schema.players.createdAt), asc(schema.players.id)).all();
    },
    listCharactersByCampaign(campaignId: string) {
      return db.select({
        id: schema.characters.id,
        campaignId: schema.characters.campaignId,
        name: schema.characters.name,
        createdAt: schema.characters.createdAt,
        archivedAt: schema.characters.archivedAt,
        shortDescription: schema.characters.shortDescription,
        archetype: schema.characters.archetype,
        origin: schema.characters.origin,
        personalGoal: schema.characters.personalGoal,
        dmNotes: schema.characters.dmNotes,
        traits: schema.characters.traits,
        appearance: schema.characters.appearance,
        quote: schema.characters.quote,
        inventoryCapacity: schema.characters.inventoryCapacity
      }).from(schema.characters).where(eq(schema.characters.campaignId, campaignId))
        .orderBy(asc(schema.characters.name), asc(schema.characters.id)).all().map(characterRecord);
    },
    listPersonalNotesByCharacter(characterId: string) {
      return db.select().from(schema.characterPersonalNotes)
        .where(eq(schema.characterPersonalNotes.characterId, characterId))
        .orderBy(desc(schema.characterPersonalNotes.updatedAt), desc(schema.characterPersonalNotes.id)).all();
    },
    listCharacterInventory(characterId: string) {
      return db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.characterId, characterId))
        .orderBy(asc(schema.inventoryItems.createdAt), asc(schema.inventoryItems.id)).all();
    },
    listCharacterActivity(characterId: string, limit = 20) {
      return activityRows(db.select().from(schema.campaignActivity)
        .where(or(eq(schema.campaignActivity.characterId, characterId), eq(schema.campaignActivity.relatedCharacterId, characterId)))
        .orderBy(desc(schema.campaignActivity.createdAt), desc(schema.campaignActivity.id)).limit(limit).all());
    },
    getCharacterOverview(characterId: string) {
      const character = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get();
      if (!character) return null;
      const player = db.select({ id: schema.players.id, displayName: schema.players.displayName })
        .from(schema.sessionCharacterAssignments)
        .innerJoin(schema.players, eq(schema.sessionCharacterAssignments.playerId, schema.players.id))
        .innerJoin(schema.sessions, eq(schema.sessionCharacterAssignments.sessionId, schema.sessions.id))
        .where(and(eq(schema.sessionCharacterAssignments.characterId, characterId), isNull(schema.sessionCharacterAssignments.releasedAt), isNull(schema.players.removedAt), isNull(schema.sessions.removedAt), eq(schema.players.status, "approved"), eq(schema.sessions.status, "active"))).get() ?? null;
      return {
        character: characterRecord(character), player,
        profileFields: characterProfileFields(characterId, true),
        inventory: db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.characterId, characterId)).all(),
        knowledge: db.select().from(schema.knowledgeEntries).where(and(
          eq(schema.knowledgeEntries.campaignId, character.campaignId),
          or(eq(schema.knowledgeEntries.visibility, "party"), eq(schema.knowledgeEntries.visibleToCharacterId, characterId))
        )).all(),
        notes: this.listPersonalNotesByCharacter(characterId), activity: this.listCharacterActivity(characterId, 10)
      };
    },
    updateCharacterProfile(characterId: string, fields: {
      name: string; shortDescription: string; archetype: string; origin: string; personalGoal: string; dmNotes: string;
      traits?: string[]; appearance?: string; quote?: string
    }) {
      return db.transaction(() => {
        const before = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get();
        if (!before) throw new Error("Character not found.");
        const values = {
          name: validatedName(fields.name), shortDescription: profileText(fields.shortDescription, 500),
          archetype: profileText(fields.archetype, 120), origin: profileText(fields.origin, 500),
          personalGoal: profileText(fields.personalGoal, 500), dmNotes: profileText(fields.dmNotes, 2000),
          traits: JSON.stringify(fields.traits === undefined ? readCharacterTraits(before.traits) : profileTraits(fields.traits)),
          appearance: profileText(fields.appearance ?? before.appearance, 1000),
          quote: profileText(fields.quote ?? before.quote, 300)
        };
        const character = db.update(schema.characters).set(values).where(eq(schema.characters.id, characterId)).returning().get()!;
        appendActivity({ campaignId: before.campaignId, characterId, type: "character_profile_updated", details: { characterName: character.name } });
        return characterRecord(character);
      });
    },
    listCatalogItemsByCampaign(campaignId: string): CampaignItem[] {
      return db.select().from(schema.catalogItems).where(eq(schema.catalogItems.campaignId, campaignId))
        .orderBy(asc(schema.catalogItems.name), asc(schema.catalogItems.id)).all();
    },
    createCatalogItem(campaignId: string, name: string): CampaignItem {
      return db.transaction(() => {
      const campaign = db.select({ id: schema.campaigns.id }).from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId)).get();
      if (!campaign) throw new Error("Campaign not found.");
      const itemName = validatedName(name);
      const duplicate = db.select({ name: schema.catalogItems.name }).from(schema.catalogItems)
        .where(eq(schema.catalogItems.campaignId, campaignId)).all()
        .some((item) => item.name.toLocaleLowerCase("ru") === itemName.toLocaleLowerCase("ru"));
      if (duplicate) throw new Error("Catalog item already exists.");
      const item = db.insert(schema.catalogItems).values({
        id: randomUUID(), campaignId, name: itemName, createdAt: new Date().toISOString()
      }).returning().get();
      appendActivity({ campaignId, type: "catalog_item_created", catalogItemId: item.id, details: { itemName: item.name } });
      return item;
      });
    },
    updateCatalogItemMetadata(catalogItemId: string, fields: Partial<Pick<CampaignItem,
      "description" | "category" | "rarity" | "equipmentSlot" | "transferAllowed" | "discardAllowed">>): CampaignItem {
      return db.transaction(() => {
        const before = db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, catalogItemId)).get();
        if (!before) throw new Error("Catalog item not found.");
        const metadata = {
          description: fields.description === undefined ? before.description : validatedInventoryDescription(fields.description),
          category: fields.category === undefined ? before.category : validatedInventoryCategory(fields.category),
          rarity: fields.rarity === undefined ? before.rarity : validatedInventoryRarity(fields.rarity),
          equipmentSlot: fields.equipmentSlot === undefined ? before.equipmentSlot : validatedEquipmentSlot(fields.equipmentSlot),
          transferAllowed: fields.transferAllowed === undefined ? before.transferAllowed : validatedInventoryPermission(fields.transferAllowed, "transferAllowed"),
          discardAllowed: fields.discardAllowed === undefined ? before.discardAllowed : validatedInventoryPermission(fields.discardAllowed, "discardAllowed")
        };
        const incompatibleEquippedCount = client.prepare(`SELECT count(*) AS count FROM inventory_items
          WHERE catalog_item_id=? AND equipped_slot IS NOT NULL AND equipped_slot IS NOT ?`)
          .get(catalogItemId, metadata.equipmentSlot) as { count: number };
        if (incompatibleEquippedCount.count) throw new Error("Catalog equipment slot conflicts with equipped inventory items.");
        return db.update(schema.catalogItems).set(metadata)
          .where(eq(schema.catalogItems.id, catalogItemId)).returning().get();
      });
    },
    updateCharacterInventoryCapacity(characterId: string, capacity: number): Character {
      const validatedCapacity = validatedInventoryCapacity(capacity);
      return db.transaction(() => {
        const character = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get();
        if (!character) throw new Error("Character not found.");
        const usedSlots = client.prepare("SELECT count(*) AS count FROM inventory_items WHERE character_id=? AND equipped_slot IS NULL")
          .get(characterId) as { count: number };
        if (validatedCapacity < usedSlots.count) throw new Error("Inventory capacity cannot be lower than used bag slots.");
        return characterRecord(db.update(schema.characters).set({ inventoryCapacity: validatedCapacity })
          .where(eq(schema.characters.id, characterId)).returning().get()!);
      });
    },
    equipInventoryItem(characterId: string, inventoryItemId: string) {
      return db.transaction(() => equipInventoryItemInTransaction(characterId, inventoryItemId));
    },
    equipPlayerInventoryItem(tokenHash: string, inventoryItemId: string) {
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        return equipInventoryItemInTransaction(active.characterId, inventoryItemId);
      });
    },
    unequipInventoryItem(characterId: string, inventoryItemId: string) {
      return db.transaction(() => unequipInventoryItemInTransaction(characterId, inventoryItemId));
    },
    unequipPlayerInventoryItem(tokenHash: string, inventoryItemId: string) {
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        return unequipInventoryItemInTransaction(active.characterId, inventoryItemId);
      });
    },
    listPlayerInventoryTransferTargets(tokenHash: string, inventoryItemId: string) {
      const active = requireActivePlayerCharacter(tokenHash);
      const { item, catalogItem } = inventoryMutationContext(tokenHash, inventoryItemId);
      if (item.equippedSlot !== null) throw new Error("Inventory item is equipped.");
      if (item.catalogItemId !== null && !catalogItem) throw new Error("Inventory catalog relation is invalid.");
      if (catalogItem && !catalogItem.transferAllowed) throw new Error("Catalog item cannot be transferred.");
      return eligibleTransferTargets(active, item);
    },
    transferPlayerInventoryItem(tokenHash: string, inventoryItemId: string, recipientCharacterId: string, quantity: number, operationId: string) {
      const requestId = validatedInventoryOperationId(operationId);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new Error("Inventory quantity is invalid.");
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        if (existingInventoryOperation(requestId, { type: "item_transferred", inventoryItemId, quantity, recipientCharacterId }, active)) {
          return { replayed: true };
        }
        const { item, catalogItem } = inventoryMutationContext(tokenHash, inventoryItemId);
        if (item.equippedSlot !== null) throw new Error("Inventory item is equipped.");
        if (item.catalogItemId !== null && !catalogItem) throw new Error("Inventory catalog relation is invalid.");
        if (catalogItem && !catalogItem.transferAllowed) throw new Error("Catalog item cannot be transferred.");
        if (quantity > item.quantity) throw new Error("Inventory quantity exceeds owned amount.");
        if (recipientCharacterId === active.characterId) throw new Error("Cannot transfer inventory to the same character.");
        const recipient = db.select().from(schema.characters).where(and(
          eq(schema.characters.id, recipientCharacterId), eq(schema.characters.campaignId, active.campaignId),
          isNull(schema.characters.archivedAt)
        )).get();
        const assigned = recipient && db.select({ playerId: schema.players.id }).from(schema.sessionCharacterAssignments)
          .innerJoin(schema.players, and(eq(schema.players.id, schema.sessionCharacterAssignments.playerId),
            eq(schema.players.sessionId, schema.sessionCharacterAssignments.sessionId)))
          .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionCharacterAssignments.sessionId))
          .where(and(eq(schema.sessionCharacterAssignments.sessionId, active.sessionId),
            eq(schema.sessionCharacterAssignments.characterId, recipientCharacterId), isNull(schema.sessionCharacterAssignments.releasedAt),
            isNull(schema.players.removedAt), isNull(schema.sessions.removedAt), eq(schema.sessions.status, "active"),
            eq(schema.players.status, "approved"))).get();
        if (!recipient || !assigned) throw new Error("Inventory transfer recipient is unavailable.");

        const existing = item.catalogItemId ? db.select().from(schema.inventoryItems).where(and(
          eq(schema.inventoryItems.characterId, recipientCharacterId), eq(schema.inventoryItems.catalogItemId, item.catalogItemId),
          isNull(schema.inventoryItems.equippedSlot)
        )).get() : null;
        if (existing && existing.quantity + quantity > 9999) throw new Error("Recipient inventory stack limit exceeded.");
        if (!existing) {
          const used = client.prepare("SELECT count(*) AS count FROM inventory_items WHERE character_id=? AND equipped_slot IS NULL")
            .get(recipientCharacterId) as { count: number };
          if (used.count >= recipient.inventoryCapacity) throw new Error("Recipient inventory capacity is full.");
        }
        const now = new Date().toISOString();
        if (existing) db.update(schema.inventoryItems).set({ quantity: existing.quantity + quantity }).where(eq(schema.inventoryItems.id, existing.id)).run();
        else db.insert(schema.inventoryItems).values({ id: randomUUID(), characterId: recipientCharacterId,
          catalogItemId: item.catalogItemId, name: item.name, quantity, equippedSlot: null, createdAt: now }).run();
        if (quantity === item.quantity) db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.id, item.id)).run();
        else db.update(schema.inventoryItems).set({ quantity: item.quantity - quantity }).where(eq(schema.inventoryItems.id, item.id)).run();
        appendActivity({ campaignId: active.campaignId, sessionId: active.sessionId, playerId: active.playerId,
          characterId: active.characterId, relatedCharacterId: recipientCharacterId, catalogItemId: item.catalogItemId,
          operationId: requestId, type: "item_transferred", details: { itemName: item.name, quantity, sourceInventoryItemId: item.id } });
        return { replayed: false };
      });
    },
    discardPlayerInventoryItem(tokenHash: string, inventoryItemId: string, quantity: number, operationId: string) {
      const requestId = validatedInventoryOperationId(operationId);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new Error("Inventory quantity is invalid.");
      return db.transaction(() => {
        const active = requireActivePlayerCharacter(tokenHash);
        if (existingInventoryOperation(requestId, { type: "item_discarded", inventoryItemId, quantity }, active)) {
          return { replayed: true };
        }
        const { item, catalogItem } = inventoryMutationContext(tokenHash, inventoryItemId);
        if (item.equippedSlot !== null) throw new Error("Inventory item is equipped.");
        if (item.catalogItemId !== null && !catalogItem) throw new Error("Inventory catalog relation is invalid.");
        if (catalogItem && !catalogItem.discardAllowed) throw new Error("Catalog item cannot be discarded.");
        if (quantity > item.quantity) throw new Error("Inventory quantity exceeds owned amount.");
        if (quantity === item.quantity) db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.id, item.id)).run();
        else db.update(schema.inventoryItems).set({ quantity: item.quantity - quantity }).where(eq(schema.inventoryItems.id, item.id)).run();
        appendActivity({ campaignId: active.campaignId, sessionId: active.sessionId, playerId: active.playerId,
          characterId: active.characterId, catalogItemId: item.catalogItemId, operationId: requestId,
          type: "item_discarded", details: { itemName: item.name, quantity, sourceInventoryItemId: item.id } });
        return { replayed: false };
      });
    },
    listKnowledgeByCampaign(campaignId: string) {
      return db.select().from(schema.knowledgeEntries)
        .where(eq(schema.knowledgeEntries.campaignId, campaignId))
        .orderBy(asc(schema.knowledgeEntries.createdAt), asc(schema.knowledgeEntries.title)).all();
    },
    createKnowledge(campaignId: string, category: KnowledgeCategory, title: string, description: string) {
      return db.transaction(() => {
      const campaign = db.select({ id: schema.campaigns.id }).from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId)).get();
      if (!campaign) throw new Error("Campaign not found.");
      const entry = db.insert(schema.knowledgeEntries).values({
        id: randomUUID(), campaignId, category, title: validatedName(title),
        description: validatedDescription(description), visibility: "hidden", visibleToCharacterId: null,
        createdAt: new Date().toISOString()
      }).returning().get();
      appendActivity({ campaignId, type: "knowledge_created", knowledgeEntryId: entry.id, details: { knowledgeTitle: entry.title } });
      return entry;
      });
    },
    updateKnowledgeEntry(campaignId: string, entryId: string, fields: {
      category: KnowledgeCategory; title: string; description: string
    }) {
      const category = validatedKnowledgeCategory(fields.category);
      const title = validatedName(fields.title);
      const description = validatedDescription(fields.description);
      return db.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
          .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
        if (!entry) throw new Error("Knowledge entry is not in this campaign.");
        return db.update(schema.knowledgeEntries).set({ category, title, description })
          .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).returning().get()!;
      });
    },
    setKnowledgeVisibility(entryId: string, visibility: KnowledgeVisibility, characterId?: string) {
      return db.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id, campaignId: schema.knowledgeEntries.campaignId, title: schema.knowledgeEntries.title, visibility: schema.knowledgeEntries.visibility, visibleToCharacterId: schema.knowledgeEntries.visibleToCharacterId })
          .from(schema.knowledgeEntries).where(eq(schema.knowledgeEntries.id, entryId)).get();
        if (!entry) throw new Error("Knowledge entry not found.");
        let visibleToCharacterId: string | null = null;
        if (visibility === "character") {
          if (!characterId) throw new Error("A character must be selected.");
          const character = db.select({ id: schema.characters.id }).from(schema.characters)
            .where(and(
              eq(schema.characters.id, characterId),
              eq(schema.characters.campaignId, entry.campaignId)
            )).get();
          if (!character) throw new Error("Character is not in this campaign.");
          visibleToCharacterId = character.id;
        }
        const updated = db.update(schema.knowledgeEntries).set({ visibility, visibleToCharacterId })
          .where(eq(schema.knowledgeEntries.id, entryId)).returning().get()!;
        if (entry.visibility !== visibility || entry.visibleToCharacterId !== visibleToCharacterId) {
          appendActivity({ campaignId: entry.campaignId, sessionId: activeSessionId(entry.campaignId), characterId: visibleToCharacterId, knowledgeEntryId: entry.id, type: "knowledge_visibility_changed", details: { knowledgeTitle: entry.title, visibility, previousVisibility: entry.visibility as KnowledgeVisibility } });
        }
        return updated;
      });
    },
    listKnowledgeFacts(campaignId: string, entryId: string): KnowledgeFact[] {
      const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
        .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
      if (!entry) throw new Error("Knowledge entry is not in this campaign.");
      return db.select().from(schema.knowledgeFacts)
        .where(and(eq(schema.knowledgeFacts.campaignId, campaignId), eq(schema.knowledgeFacts.knowledgeEntryId, entryId)))
        .orderBy(asc(schema.knowledgeFacts.position), asc(schema.knowledgeFacts.id)).all();
    },
    listKnowledgeFactReveals(campaignId: string, entryId: string): KnowledgeFactReveal[] {
      const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
        .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
      if (!entry) throw new Error("Knowledge entry is not in this campaign.");
      return db.select({
        id: schema.knowledgeFactReveals.id, campaignId: schema.knowledgeFactReveals.campaignId,
        knowledgeFactId: schema.knowledgeFactReveals.knowledgeFactId, audience: schema.knowledgeFactReveals.audience,
        characterId: schema.knowledgeFactReveals.characterId, sessionId: schema.knowledgeFactReveals.sessionId,
        createdAt: schema.knowledgeFactReveals.createdAt
      }).from(schema.knowledgeFactReveals)
        .innerJoin(schema.knowledgeFacts, eq(schema.knowledgeFactReveals.knowledgeFactId, schema.knowledgeFacts.id))
        .where(and(eq(schema.knowledgeFactReveals.campaignId, campaignId), eq(schema.knowledgeFacts.knowledgeEntryId, entryId)))
        .orderBy(asc(schema.knowledgeFactReveals.createdAt), asc(schema.knowledgeFactReveals.id)).all();
    },
    createKnowledgeFact(campaignId: string, entryId: string, body: string): KnowledgeFact {
      return db.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
          .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
        if (!entry) throw new Error("Knowledge entry is not in this campaign.");
        const position = (client.prepare("SELECT COALESCE(MAX(position), -1) AS position FROM knowledge_facts WHERE campaign_id=? AND knowledge_entry_id=?")
          .get(campaignId, entryId) as { position: number }).position + 1;
        const now = new Date().toISOString();
        return db.insert(schema.knowledgeFacts).values({
          id: randomUUID(), campaignId, knowledgeEntryId: entryId, body: validatedKnowledgeFactBody(body),
          position, createdAt: now, updatedAt: now
        }).returning().get();
      });
    },
    updateKnowledgeFact(campaignId: string, entryId: string, factId: string, body: string): KnowledgeFact {
      const updated = db.update(schema.knowledgeFacts).set({ body: validatedKnowledgeFactBody(body), updatedAt: new Date().toISOString() })
        .where(and(eq(schema.knowledgeFacts.id, factId), eq(schema.knowledgeFacts.campaignId, campaignId), eq(schema.knowledgeFacts.knowledgeEntryId, entryId)))
        .returning().get();
      if (!updated) throw new Error("Knowledge fact not found in this entry.");
      return updated;
    },
    reorderKnowledgeFacts(campaignId: string, entryId: string, orderedFactIds: string[]): KnowledgeFact[] {
      return db.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
          .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
        if (!entry) throw new Error("Knowledge entry is not in this campaign.");
        const facts = db.select().from(schema.knowledgeFacts).where(and(
          eq(schema.knowledgeFacts.campaignId, campaignId), eq(schema.knowledgeFacts.knowledgeEntryId, entryId)
        )).orderBy(asc(schema.knowledgeFacts.position), asc(schema.knowledgeFacts.id)).all();
        if (!Array.isArray(orderedFactIds) || orderedFactIds.length !== facts.length ||
            new Set(orderedFactIds).size !== facts.length || facts.some((fact) => !orderedFactIds.includes(fact.id))) {
          throw new Error("Knowledge fact order is invalid.");
        }
        if (facts.length) {
          const maxPosition = Math.max(...facts.map((fact) => fact.position));
          const offset = maxPosition + facts.length + 1;
          const update = client.prepare("UPDATE knowledge_facts SET position=? WHERE campaign_id=? AND knowledge_entry_id=? AND id=?");
          orderedFactIds.forEach((factId, index) => update.run(offset + index, campaignId, entryId, factId));
          orderedFactIds.forEach((factId, position) => update.run(position, campaignId, entryId, factId));
        }
        return db.select().from(schema.knowledgeFacts).where(and(
          eq(schema.knowledgeFacts.campaignId, campaignId), eq(schema.knowledgeFacts.knowledgeEntryId, entryId)
        )).orderBy(asc(schema.knowledgeFacts.position), asc(schema.knowledgeFacts.id)).all();
      });
    },
    deleteKnowledgeFact(campaignId: string, entryId: string, factId: string): boolean {
      const deleted = db.delete(schema.knowledgeFacts).where(and(
        eq(schema.knowledgeFacts.id, factId), eq(schema.knowledgeFacts.campaignId, campaignId),
        eq(schema.knowledgeFacts.knowledgeEntryId, entryId)
      )).returning({ id: schema.knowledgeFacts.id }).get();
      if (!deleted) throw new Error("Knowledge fact not found in this entry.");
      return true;
    },
    revealKnowledgeFactToParty(campaignId: string, entryId: string, factId: string): KnowledgeFactAccessResult {
      return db.transaction(() => revealKnowledgeFactInTransaction(campaignId, entryId, factId, "party", null, "selected"));
    },
    revealKnowledgeFactToCharacter(campaignId: string, entryId: string, factId: string, characterId: string): KnowledgeFactAccessResult {
      return db.transaction(() => revealKnowledgeFactInTransaction(campaignId, entryId, factId, "character", characterId, "selected"));
    },
    revealNextKnowledgeFact(campaignId: string, entryId: string, audience: KnowledgeFactRevealAudience,
      characterId: string | undefined, operationId: string): KnowledgeFactAccessResult | null {
      const requestId = validatedOperationId(operationId);
      const transaction = client.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
          .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
        if (!entry) throw new Error("Knowledge entry is not in this campaign.");
        const targetId = audience === "character" ? characterId : undefined;
        if (audience === "character") {
          if (!targetId) throw new Error("A character must be selected.");
          const target = db.select({ archivedAt: schema.characters.archivedAt }).from(schema.characters)
            .where(and(eq(schema.characters.id, targetId), eq(schema.characters.campaignId, campaignId))).get();
          if (!target) throw new Error("Character is not in this campaign.");
          if (target.archivedAt) throw new Error("Archived characters cannot receive new knowledge facts.");
        } else if (audience !== "party" || characterId) throw new Error("Knowledge fact audience is invalid.");

        const previous = db.select().from(schema.campaignActivity)
          .where(eq(schema.campaignActivity.operationId, requestId)).get();
        if (previous) {
          const details = JSON.parse(previous.payload) as ActivityDetails;
          if (previous.type !== "knowledge_fact_revealed" || previous.campaignId !== campaignId || previous.knowledgeEntryId !== entryId ||
              previous.characterId !== (audience === "character" ? targetId : null) || details.audience !== audience || details.scope !== "next") {
            throw new Error("Knowledge reveal operation ID was already used.");
          }
          const priorReveal = db.select().from(schema.knowledgeFactReveals)
            .where(eq(schema.knowledgeFactReveals.operationId, requestId)).get();
          if (!priorReveal) return null;
          const fact = db.select().from(schema.knowledgeFacts).where(eq(schema.knowledgeFacts.id, priorReveal.knowledgeFactId)).get();
          if (!fact) return null;
          const { operationId: _operationId, ...publicReveal } = priorReveal;
          return { fact, reveal: publicReveal, created: false };
        }

        const fact = audience === "party"
          ? client.prepare(`SELECT f.* FROM knowledge_facts f
              WHERE f.campaign_id=? AND f.knowledge_entry_id=? AND NOT EXISTS (
                SELECT 1 FROM knowledge_fact_reveals r WHERE r.knowledge_fact_id=f.id AND r.audience='party'
              ) ORDER BY f.position, f.id LIMIT 1`).get(campaignId, entryId) as typeof schema.knowledgeFacts.$inferSelect | undefined
          : client.prepare(`SELECT f.* FROM knowledge_facts f
              WHERE f.campaign_id=? AND f.knowledge_entry_id=? AND NOT EXISTS (
                SELECT 1 FROM knowledge_fact_reveals r WHERE r.knowledge_fact_id=f.id AND r.audience='character' AND r.character_id=?
              ) ORDER BY f.position, f.id LIMIT 1`).get(campaignId, entryId, targetId!) as typeof schema.knowledgeFacts.$inferSelect | undefined;
        if (!fact) return null;
        return revealKnowledgeFactInTransaction(campaignId, entryId, fact.id, audience,
          audience === "character" ? targetId! : null, "next", requestId);
      });
      return transaction.immediate();
    },
    revealAllKnowledgeFacts(campaignId: string, entryId: string, audience: KnowledgeFactRevealAudience,
      characterId?: string): KnowledgeFactRevealBatchResult {
      return db.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
          .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
        if (!entry) throw new Error("Knowledge entry is not in this campaign.");
        if (audience === "character") {
          if (!characterId) throw new Error("A character must be selected.");
          const target = db.select({ archivedAt: schema.characters.archivedAt }).from(schema.characters)
            .where(and(eq(schema.characters.id, characterId), eq(schema.characters.campaignId, campaignId))).get();
          if (!target) throw new Error("Character is not in this campaign.");
          if (target.archivedAt) throw new Error("Archived characters cannot receive new knowledge facts.");
        } else if (audience !== "party" || characterId) throw new Error("Knowledge fact audience is invalid.");
        const facts = db.select().from(schema.knowledgeFacts).where(and(
          eq(schema.knowledgeFacts.campaignId, campaignId), eq(schema.knowledgeFacts.knowledgeEntryId, entryId)
        )).orderBy(asc(schema.knowledgeFacts.position), asc(schema.knowledgeFacts.id)).all();
        const existing = db.select({ factId: schema.knowledgeFactReveals.knowledgeFactId }).from(schema.knowledgeFactReveals).where(and(
          eq(schema.knowledgeFactReveals.campaignId, campaignId), eq(schema.knowledgeFactReveals.audience, audience),
          audience === "character" ? eq(schema.knowledgeFactReveals.characterId, characterId!) : eq(schema.knowledgeFactReveals.audience, "party")
        )).all();
        const existingIds = new Set(existing.map((row) => row.factId));
        const sessionId = activeSessionId(campaignId);
        const now = new Date().toISOString();
        const insertedIds: string[] = [];
        for (const fact of facts) {
          if (existingIds.has(fact.id)) continue;
          const inserted = db.insert(schema.knowledgeFactReveals).values({
            id: randomUUID(), campaignId, knowledgeFactId: fact.id, audience,
            characterId: audience === "character" ? characterId! : null, sessionId,
            operationId: null, createdAt: now
          }).onConflictDoNothing().returning({ id: schema.knowledgeFactReveals.id }).get();
          if (inserted) insertedIds.push(inserted.id);
        }
        if (insertedIds.length) appendActivity({ campaignId, sessionId, characterId: audience === "character" ? characterId : null,
          knowledgeEntryId: entryId, type: "knowledge_fact_revealed",
          details: { audience, factCount: insertedIds.length, scope: "all" } });
        const reveals = db.select().from(schema.knowledgeFactReveals).where(and(
          eq(schema.knowledgeFactReveals.campaignId, campaignId), eq(schema.knowledgeFactReveals.audience, audience),
          inArray(schema.knowledgeFactReveals.knowledgeFactId, facts.map((fact) => fact.id).length ? facts.map((fact) => fact.id) : [""]),
          audience === "character" ? eq(schema.knowledgeFactReveals.characterId, characterId!) : eq(schema.knowledgeFactReveals.audience, "party")
        )).all().map(({ operationId: _operationId, ...row }) => row);
        return { reveals, createdCount: insertedIds.length };
      });
    },
    revokeKnowledgeFactReveal(campaignId: string, entryId: string, factId: string,
      audience: KnowledgeFactRevealAudience, characterId?: string): boolean {
      return db.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id }).from(schema.knowledgeEntries)
          .where(and(eq(schema.knowledgeEntries.id, entryId), eq(schema.knowledgeEntries.campaignId, campaignId))).get();
        if (!entry) throw new Error("Knowledge entry is not in this campaign.");
        const fact = db.select({ id: schema.knowledgeFacts.id }).from(schema.knowledgeFacts).where(and(
          eq(schema.knowledgeFacts.id, factId), eq(schema.knowledgeFacts.campaignId, campaignId),
          eq(schema.knowledgeFacts.knowledgeEntryId, entryId)
        )).get();
        if (!fact) throw new Error("Knowledge fact not found in this entry.");
        if (audience === "character") {
          if (!characterId) throw new Error("A character must be selected.");
          const character = db.select({ id: schema.characters.id }).from(schema.characters).where(and(
            eq(schema.characters.id, characterId), eq(schema.characters.campaignId, campaignId)
          )).get();
          if (!character) throw new Error("Character is not in this campaign.");
        } else if (audience !== "party" || characterId) throw new Error("Knowledge fact audience is invalid.");
        const removed = db.delete(schema.knowledgeFactReveals).where(and(
          eq(schema.knowledgeFactReveals.campaignId, campaignId), eq(schema.knowledgeFactReveals.knowledgeFactId, factId),
          eq(schema.knowledgeFactReveals.audience, audience),
          audience === "character" ? eq(schema.knowledgeFactReveals.characterId, characterId!) : eq(schema.knowledgeFactReveals.audience, "party")
        )).returning({ id: schema.knowledgeFactReveals.id }).get();
        if (removed) appendActivity({ campaignId, sessionId: activeSessionId(campaignId), characterId: audience === "character" ? characterId : null,
          knowledgeEntryId: entryId, type: "knowledge_fact_access_revoked", details: { audience, factCount: 1, scope: "selected" } });
        return Boolean(removed);
      });
    },
    createCharacter(campaignId: string, name: string) {
      return db.transaction(() => {
      const campaign = db.select({ id: schema.campaigns.id }).from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId)).get();
      if (!campaign) throw new Error("Campaign not found.");
      const character = db.insert(schema.characters).values({
        id: randomUUID(), campaignId, name: validatedName(name), createdAt: new Date().toISOString()
      }).returning().get();
      appendActivity({ campaignId, characterId: character.id, type: "character_created", details: { characterName: character.name } });
      return characterRecord(character);
      });
    },
    archiveCharacter(characterId: string) {
      return db.transaction(() => {
        const character = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get();
        if (!character) throw new Error("Character not found.");
        if (character.archivedAt) return characterRecord(character);
        const active = db.select({ id: schema.sessions.id }).from(schema.sessionCharacterAssignments)
          .innerJoin(schema.players, eq(schema.sessionCharacterAssignments.playerId, schema.players.id))
          .innerJoin(schema.sessions, eq(schema.sessionCharacterAssignments.sessionId, schema.sessions.id))
          .where(and(eq(schema.sessionCharacterAssignments.characterId, characterId), isNull(schema.sessionCharacterAssignments.releasedAt),
            isNull(schema.players.removedAt), isNull(schema.sessions.removedAt), eq(schema.sessions.status, "active"), eq(schema.players.status, "approved"))).get();
        if (active) throw new Error("An active character cannot be archived.");
        const updated = db.update(schema.characters).set({ archivedAt: new Date().toISOString() })
          .where(eq(schema.characters.id, characterId)).returning().get()!;
        appendActivity({ campaignId: character.campaignId, sessionId: activeSessionId(character.campaignId), characterId, type: "character_archived", details: { characterName: character.name } });
        return characterRecord(updated);
      });
    },
    restoreCharacter(characterId: string) {
      return db.transaction(() => {
        const character = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get();
        if (!character) throw new Error("Character not found.");
        if (!character.archivedAt) return character;
        const updated = db.update(schema.characters).set({ archivedAt: null })
          .where(eq(schema.characters.id, characterId)).returning().get()!;
        appendActivity({ campaignId: character.campaignId, sessionId: activeSessionId(character.campaignId), characterId, type: "character_restored", details: { characterName: character.name } });
        return characterRecord(updated);
      });
    },
    grantInventoryItem(characterId: string, catalogItemId: string, quantity: number) {
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
        throw new Error("Item quantity must be between 1 and 9999.");
      }
      return db.transaction(() => {
        const character = db.select({
          id: schema.characters.id,
          campaignId: schema.characters.campaignId,
          inventoryCapacity: schema.characters.inventoryCapacity,
          archivedAt: schema.characters.archivedAt
        }).from(schema.characters).where(eq(schema.characters.id, characterId)).get();
        if (!character) throw new Error("Character not found.");
        if (character.archivedAt) throw new Error("Archived character cannot receive inventory items.");
        const catalogItem = db.select().from(schema.catalogItems)
          .where(and(eq(schema.catalogItems.id, catalogItemId), eq(schema.catalogItems.campaignId, character.campaignId))).get();
        if (!catalogItem) throw new Error("Catalog item is unavailable for this campaign.");
        const sessionId = activeSessionId(character.campaignId);
        const existing = db.select().from(schema.inventoryItems).where(and(
          eq(schema.inventoryItems.characterId, characterId), eq(schema.inventoryItems.catalogItemId, catalogItemId),
          isNull(schema.inventoryItems.equippedSlot)
        )).get();
        if (existing) {
          if (existing.quantity + quantity > 9999) throw new Error("Item quantity limit exceeded.");
          const item = db.update(schema.inventoryItems)
            .set({ quantity: existing.quantity + quantity })
            .where(eq(schema.inventoryItems.id, existing.id)).returning().get();
          appendActivity({ campaignId: character.campaignId, sessionId, characterId, catalogItemId, type: "item_granted", details: { itemName: catalogItem.name, quantity, totalQuantity: item.quantity } });
          return item;
        }
        const usedSlots = client.prepare("SELECT count(*) AS count FROM inventory_items WHERE character_id=? AND equipped_slot IS NULL")
          .get(characterId) as { count: number };
        if (usedSlots.count >= character.inventoryCapacity) throw new Error("Inventory capacity is full.");
        const item = db.insert(schema.inventoryItems).values({
          id: randomUUID(), characterId, catalogItemId, name: catalogItem.name, quantity, createdAt: new Date().toISOString()
        }).returning().get();
        appendActivity({ campaignId: character.campaignId, sessionId, characterId, catalogItemId, type: "item_granted", details: { itemName: catalogItem.name, quantity, totalQuantity: item.quantity } });
        return item;
      });
    },
    approvePlayer(playerId: string, assignment: { characterId: string } | { characterName: string }) {
      return db.transaction(() => {
        const request = db.select({
          id: schema.players.id,
          status: schema.players.status,
          sessionId: schema.players.sessionId,
          sessionStatus: schema.sessions.status,
          sessionRemovedAt: schema.sessions.removedAt,
          removedAt: schema.players.removedAt,
          campaignId: schema.sessions.campaignId
        }).from(schema.players)
          .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
          .where(eq(schema.players.id, playerId)).get();
        if (!request || request.removedAt) throw new Error("Player request not found.");
        if (request.status === "approved") return getPlayer(playerId)!;
        if (request.status === "rejected") throw new Error("Rejected request cannot be approved.");
        if (request.sessionRemovedAt || request.sessionStatus !== "active") throw new Error("Session has ended.");

        if ("characterId" in assignment) {
          const character = db.select().from(schema.characters)
            .where(and(eq(schema.characters.id, assignment.characterId), eq(schema.characters.campaignId, request.campaignId)))
            .get();
          if (!character || character.archivedAt) throw new Error("Character is unavailable for this campaign.");
          const existingAssignment = db.select({ playerId: schema.sessionCharacterAssignments.playerId })
            .from(schema.sessionCharacterAssignments)
            .where(and(
              eq(schema.sessionCharacterAssignments.sessionId, request.sessionId),
              eq(schema.sessionCharacterAssignments.characterId, character.id),
              isNull(schema.sessionCharacterAssignments.releasedAt)
            )).get();
          if (existingAssignment) throw new Error("Character is already assigned in this session.");
          db.insert(schema.sessionCharacterAssignments).values({
            playerId, sessionId: request.sessionId, characterId: character.id, createdAt: new Date().toISOString()
          }).run();
          appendActivity({ campaignId: request.campaignId, sessionId: request.sessionId, playerId, characterId: character.id, type: "character_assigned", details: { characterName: character.name } });
        } else {
          const name = validatedName(assignment.characterName);
          const character = db.insert(schema.characters).values({
            id: randomUUID(), campaignId: request.campaignId, name, createdAt: new Date().toISOString()
          }).returning().get();
          db.insert(schema.sessionCharacterAssignments).values({
            playerId, sessionId: request.sessionId, characterId: character.id, createdAt: new Date().toISOString()
          }).run();
          appendActivity({ campaignId: request.campaignId, sessionId: request.sessionId, characterId: character.id, type: "character_created", details: { characterName: character.name } });
          appendActivity({ campaignId: request.campaignId, sessionId: request.sessionId, playerId, characterId: character.id, type: "character_assigned", details: { characterName: character.name } });
        }
        db.update(schema.players).set({ status: "approved" })
          .where(and(eq(schema.players.id, playerId), eq(schema.players.status, "pending"))).run();
        appendActivity({ campaignId: request.campaignId, sessionId: request.sessionId, playerId, type: "player_approved", details: { playerName: getPlayer(playerId)!.displayName } });
        return getPlayer(playerId)!;
      });
    },
    rejectPlayer(playerId: string) {
      return db.transaction(() => {
      const player = getPlayer(playerId);
      if (!player) throw new Error("Player request not found.");
      if (player.removedAt) throw new Error("Player request not found.");
      if (player.status === "approved") throw new Error("Approved player cannot be rejected.");
      if (player.status === "rejected") return player;
      db.update(schema.players).set({ status: "rejected" })
        .where(and(eq(schema.players.id, playerId), eq(schema.players.status, "pending"))).run();
      const session = getSession(player.sessionId)!;
      appendActivity({ campaignId: session.campaignId, sessionId: session.id, playerId, type: "player_rejected", details: { playerName: player.displayName } });
      return getPlayer(playerId)!;
      });
    },
    createSession(campaignId: string, name: string): Session {
      return db.transaction(() => {
      const session = db.insert(schema.sessions).values({
        id: randomUUID(),
        campaignId,
        name: validatedName(name),
        joinToken: randomBytes(32).toString("base64url"),
        createdAt: new Date().toISOString()
      }).returning().get();
      appendActivity({ campaignId, sessionId: session.id, type: "session_created", details: { sessionName: session.name } });
      return session;
      });
    },
    activateSession(id: string, expectedActiveSessionId?: string | null): Session {
      // End the previous session and activate the next one as one atomic change.
      return db.transaction(() => {
        const session = getSession(id);
        if (!session || session.removedAt) throw new Error("Session not found.");
        if (session.status === "ended") throw new Error("An ended session cannot be activated.");
        if (session.status === "active") return session;
        if (expectedActiveSessionId !== undefined) {
          const current = db.select().from(schema.sessions).where(and(eq(schema.sessions.status, "active"), isNull(schema.sessions.removedAt))).get();
          if ((current?.id ?? null) !== expectedActiveSessionId) throw new Error("Active session changed.");
        }
        const previous = db.select().from(schema.sessions).where(and(eq(schema.sessions.status, "active"), isNull(schema.sessions.removedAt))).get();
        if (previous) {
          db.update(schema.sessions).set({ status: "ended" }).where(eq(schema.sessions.id, previous.id)).run();
          appendActivity({ campaignId: previous.campaignId, sessionId: previous.id, type: "session_ended", details: { sessionName: previous.name } });
        }
        const active = db.update(schema.sessions).set({ status: "active" }).where(eq(schema.sessions.id, id)).returning().get()!;
        appendActivity({ campaignId: active.campaignId, sessionId: active.id, type: "session_started", details: { sessionName: active.name } });
        return active;
      });
    },
    endSession(id: string): Session {
      return db.transaction(() => {
      const session = getSession(id);
      if (!session || session.removedAt) throw new Error("Session not found.");
      if (session.status === "ended") return session;
      if (session.status !== "active") throw new Error("Only an active session can be ended.");
      const ended = db.update(schema.sessions).set({ status: "ended" }).where(eq(schema.sessions.id, id)).returning().get()!;
      appendActivity({ campaignId: session.campaignId, sessionId: id, type: "session_ended", details: { sessionName: session.name } });
      return ended;
      });
    },
    getCurrentSession(): SessionSnapshot | null {
      return db.select({ campaign: schema.campaigns, session: schema.sessions }).from(schema.sessions)
        .innerJoin(schema.campaigns, eq(schema.sessions.campaignId, schema.campaigns.id))
        .where(and(eq(schema.sessions.status, "active"), isNull(schema.sessions.removedAt))).get() ?? null;
    }
  };
}

export type GameDatabase = ReturnType<typeof openDatabase>;
