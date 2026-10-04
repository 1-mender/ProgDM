import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, cpSync, copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import SQLite from "better-sqlite3";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { ACTIVITY_TYPES, type ActivityDetails, type ActivityType, type Campaign, type CampaignActivity, type CampaignItem, type CampaignProfileFieldDefinition, type Character, type CharacterProfileFieldValue, type DataHealth, type HealthCheck, type KnowledgeCategory, type KnowledgeFact, type KnowledgeFactAccessResult, type KnowledgeFactReveal, type KnowledgeFactRevealAudience, type KnowledgeFactRevealBatchResult, type KnowledgeFactRevealScope, type KnowledgeVisibility, type PersonalNoteMarker, type PlayerActivityEvent, type PlayerKnowledgeEntry, type Session, type SessionSnapshot } from "@progdm/shared";
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
        eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId)))
      .innerJoin(schema.characters, eq(schema.characters.id, schema.sessionCharacterAssignments.characterId))
      .where(and(eq(schema.players.tokenHash, tokenHash), eq(schema.players.status, "approved"), eq(schema.sessions.status, "active"), eq(schema.characters.campaignId, schema.sessions.campaignId))).get() ?? null;
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
      catalogItemId: event.catalogItemId ?? null, knowledgeEntryId: event.knowledgeEntryId ?? null,
      operationId: event.operationId ?? null,
      type: event.type, createdAt: new Date(timestamp).toISOString(), payload: JSON.stringify(event.details ?? {})
    }).run();
  }

  function activeSessionId(campaignId: string): string | null {
    return db.select({ id: schema.sessions.id }).from(schema.sessions)
      .where(and(eq(schema.sessions.campaignId, campaignId), eq(schema.sessions.status, "active"))).get()?.id ?? null;
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
      characterId: row.characterId, catalogItemId: row.catalogItemId,
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
      createdAt: schema.players.createdAt,
      characterId: schema.characters.id,
      characterName: schema.characters.name
    }).from(schema.players)
      .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
      .leftJoin(schema.sessionCharacterAssignments, and(
        eq(schema.sessionCharacterAssignments.playerId, schema.players.id),
        eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId)
      ))
      .leftJoin(schema.characters, eq(schema.characters.id, schema.sessionCharacterAssignments.characterId))
      .where(eq(schema.players.id, playerId)).get() ?? null;
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
        ["Инвентарь", "SELECT count(*) AS count FROM inventory_items i JOIN characters c ON c.id=i.character_id JOIN catalog_items ci ON ci.id=i.catalog_item_id WHERE c.campaign_id!=ci.campaign_id"],
        ["Активные игроки", "SELECT count(*) AS count FROM players p JOIN sessions s ON s.id=p.session_id LEFT JOIN session_character_assignments a ON a.player_id=p.id WHERE p.status='approved' AND s.status='active' AND a.player_id IS NULL"],
        ["Архивные персонажи", "SELECT count(*) AS count FROM session_character_assignments a JOIN characters c ON c.id=a.character_id JOIN sessions s ON s.id=a.session_id JOIN players p ON p.id=a.player_id WHERE c.archived_at IS NOT NULL AND s.status='active' AND p.status='approved'"],
        ["Отметки просмотра", "SELECT count(*) AS count FROM character_read_state r JOIN characters c ON c.id=r.character_id LEFT JOIN campaign_activity a ON a.id=r.last_seen_id WHERE a.id IS NULL OR a.campaign_id!=c.campaign_id OR a.created_at!=r.last_seen_at"],
        ["История кампании", "SELECT count(*) AS count FROM campaign_activity a LEFT JOIN sessions s ON s.id=a.session_id LEFT JOIN players p ON p.id=a.player_id LEFT JOIN characters c ON c.id=a.character_id LEFT JOIN catalog_items i ON i.id=a.catalog_item_id LEFT JOIN knowledge_entries k ON k.id=a.knowledge_entry_id WHERE (s.id IS NOT NULL AND s.campaign_id!=a.campaign_id) OR (p.id IS NOT NULL AND (a.session_id IS NULL OR p.session_id!=a.session_id)) OR (c.id IS NOT NULL AND c.campaign_id!=a.campaign_id) OR (i.id IS NOT NULL AND i.campaign_id!=a.campaign_id) OR (k.id IS NOT NULL AND k.campaign_id!=a.campaign_id)"],
        ["Личные заметки", "SELECT count(*) AS count FROM character_personal_notes n LEFT JOIN characters c ON c.id=n.character_id WHERE c.id IS NULL OR length(n.title)>120 OR length(trim(n.body)) NOT BETWEEN 1 AND 2000 OR n.marker NOT IN ('normal', 'important', 'check', 'question') OR typeof(n.pinned)!='integer' OR n.pinned NOT IN (0, 1)"]
      ] as const;
      for (const [name, query] of domainQueries) check(name, () => {
        const count = (client.prepare(query).get() as { count: number }).count;
        return count === 0 ? { status: "ok", message: "Нарушений не найдено." }
          : { status: "error", message: `Найдено несогласованных записей: ${count}.` };
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
        id: schema.sessions.id, name: schema.sessions.name, status: schema.sessions.status, createdAt: schema.sessions.createdAt
      }).from(schema.sessions).where(eq(schema.sessions.campaignId, id)).all();
      const sessionIds = sessions.map((session) => session.id);
      const players = sessionIds.length ? db.select({
        id: schema.players.id, sessionId: schema.players.sessionId, displayName: schema.players.displayName,
        status: schema.players.status, createdAt: schema.players.createdAt
      }).from(schema.players).where(inArray(schema.players.sessionId, sessionIds)).all() : [];
      const characters = db.select({
        id: schema.characters.id, name: schema.characters.name, createdAt: schema.characters.createdAt, archivedAt: schema.characters.archivedAt,
        shortDescription: schema.characters.shortDescription, archetype: schema.characters.archetype,
        origin: schema.characters.origin, personalGoal: schema.characters.personalGoal, dmNotes: schema.characters.dmNotes,
        traits: schema.characters.traits, appearance: schema.characters.appearance, quote: schema.characters.quote
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
        createdAt: schema.sessionCharacterAssignments.createdAt
      }).from(schema.sessionCharacterAssignments)
        .where(inArray(schema.sessionCharacterAssignments.sessionId, sessionIds)).all() : [];
      const catalogItems = db.select({
        id: schema.catalogItems.id, name: schema.catalogItems.name, createdAt: schema.catalogItems.createdAt
      }).from(schema.catalogItems).where(eq(schema.catalogItems.campaignId, id)).all();
      const inventoryItems = characterIds.length ? db.select({
        id: schema.inventoryItems.id, characterId: schema.inventoryItems.characterId,
        catalogItemId: schema.inventoryItems.catalogItemId, name: schema.inventoryItems.name,
        quantity: schema.inventoryItems.quantity, createdAt: schema.inventoryItems.createdAt
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
        format: "progdm-campaign", version: 8, exportedAt: new Date().toISOString(), campaign,
        sessions, players, assignments, characters, profileFields, profileFieldValues, personalNotes, catalogItems, inventoryItems, knowledge,
        knowledgeFacts, knowledgeFactReveals,
        activity: activityRows(db.select().from(schema.campaignActivity)
          .where(eq(schema.campaignActivity.campaignId, id))
          .orderBy(asc(schema.campaignActivity.createdAt), asc(schema.campaignActivity.id)).all())
      };
    },
    importCampaign(source: unknown) {
      const archive = transferRecord(source);
      if (archive.format !== "progdm-campaign" || ![1, 2, 3, 4, 5, 6, 7, 8].includes(archive.version as number)) throw new Error("Campaign file format is not supported.");
      const archiveVersion = archive.version as number;
      const campaignSource = transferRecord(archive.campaign);
      const sourceCampaignName = validatedName(transferString(campaignSource, "name", 120));
      const createdAt = (record: Record<string, unknown>) => {
        const value = transferString(record, "createdAt", 64);
        if (!value || Number.isNaN(Date.parse(value))) throw new Error("Campaign file is invalid.");
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
      }
      const newId = () => randomUUID();
      return db.transaction(() => {
        const campaign = db.insert(schema.campaigns).values({
          id: campaignId, name: sourceCampaignName, createdAt: createdAt(campaignSource)
        }).returning().get();
        for (const row of sessions) {
          const status = transferString(row, "status");
          if (!["planned", "active", "ended"].includes(status)) throw new Error("Campaign file is invalid.");
          db.insert(schema.sessions).values({
            id: requireMapped(sessionIds, row.id), campaignId, name: validatedName(transferString(row, "name", 120)),
            status: status === "active" || sessionsWithPlayers.has(transferString(row, "id"))
              ? "ended" : status as "planned" | "ended",
            joinToken: randomBytes(32).toString("base64url"), createdAt: createdAt(row)
          }).run();
        }
        for (const row of players) {
          const status = transferString(row, "status");
          if (!["pending", "approved", "rejected"].includes(status)) throw new Error("Campaign file is invalid.");
          db.insert(schema.players).values({
            id: requireMapped(playerIds, row.id), sessionId: requireMapped(sessionIds, row.sessionId),
            displayName: validatedPlayerName(transferString(row, "displayName", 60)),
            tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
            status: status as "pending" | "approved" | "rejected", createdAt: createdAt(row)
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
            quote: archiveVersion >= 5 ? profileText(transferString(row, "quote", 300), 300) : ""
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
          id: requireMapped(catalogIds, row.id), campaignId, name: validatedName(transferString(row, "name", 120)), createdAt: createdAt(row)
        }).run();
        for (const row of assignments) db.insert(schema.sessionCharacterAssignments).values({
          playerId: requireMapped(playerIds, row.playerId), sessionId: requireMapped(sessionIds, row.sessionId),
          characterId: requireMapped(characterIds, row.characterId), createdAt: createdAt(row)
        }).run();
        for (const row of inventoryItems) {
          const quantity = row.quantity;
          if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 9999) throw new Error("Campaign file is invalid.");
          db.insert(schema.inventoryItems).values({
            id: newId(), characterId: requireMapped(characterIds, row.characterId),
            catalogItemId: row.catalogItemId === null ? null : requireMapped(catalogIds, row.catalogItemId),
            name: validatedName(transferString(row, "name", 120)), quantity: quantity as number, createdAt: createdAt(row)
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
          if (row.playerId !== null && playerSessionIds.get(String(row.playerId)) !== row.sessionId) throw new Error("Campaign file contains an invalid event session.");
          const mapped = (value: unknown, ids: Map<string, string>) => value === null ? null : requireMapped(ids, value);
          const details = parsedActivityDetails(row.details);
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
            characterId: mapped(row.characterId, characterIds), catalogItemId: mapped(row.catalogItemId, catalogIds),
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
    listSessions(campaignId: string): Session[] {
      return db.select().from(schema.sessions).where(eq(schema.sessions.campaignId, campaignId))
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
        .where(eq(schema.sessions.joinToken, joinToken)).get();
      return info?.status === "active" ? info : null;
    },
    getPlayerByTokenHash(tokenHash: string) {
      const player = db.select({ id: schema.players.id }).from(schema.players)
        .where(eq(schema.players.tokenHash, tokenHash)).get();
      return player ? getPlayer(player.id) : null;
    },
    getPlayerState(tokenHash: string) {
      const player = db.select({
        id: schema.players.id,
        campaignId: schema.sessions.campaignId,
        characterId: schema.characters.id,
        displayName: schema.players.displayName,
        status: schema.players.status,
        campaignName: schema.campaigns.name,
        sessionName: schema.sessions.name,
        characterName: schema.characters.name,
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
          eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId)
        ))
        .leftJoin(schema.characters, and(eq(schema.characters.id, schema.sessionCharacterAssignments.characterId),
          eq(schema.characters.campaignId, schema.sessions.campaignId), eq(schema.players.status, "approved")))
        .where(eq(schema.players.tokenHash, tokenHash)).get();
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
      const relevant: PlayerActivityEvent[] = [];
      if (active) {
        const safeEntries = new Map(knowledge.map((entry) => [entry.id, entry]));
        const sessionNames = new Map(db.select({ id: schema.sessions.id, name: schema.sessions.name }).from(schema.sessions)
          .where(eq(schema.sessions.campaignId, active.campaignId)).all().map((session) => [session.id, session.name]));
        const campaignEvents = activityRows(db.select().from(schema.campaignActivity)
          .where(eq(schema.campaignActivity.campaignId, active.campaignId))
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
            if (openedToCharacter && entry?.summaryVisible) {
              relevant.push({
                id: event.id, kind: "knowledge_summary_opened", createdAt: event.createdAt,
                sessionId: event.sessionId, sessionName: event.sessionId ? sessionNames.get(event.sessionId) ?? null : null,
                knowledgeEntryId: entry.id, knowledgeTitle: entry.title
              });
            }
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
        relevant.splice(20);
      }
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
        inventory: player.characterId
          ? db.select().from(schema.inventoryItems)
            .where(eq(schema.inventoryItems.characterId, player.characterId))
            .orderBy(asc(schema.inventoryItems.createdAt), asc(schema.inventoryItems.name)).all()
          : [],
        knowledge,
        notes: active ? db.select().from(schema.characterPersonalNotes)
          .where(eq(schema.characterPersonalNotes.characterId, active.characterId))
          .orderBy(desc(schema.characterPersonalNotes.updatedAt), desc(schema.characterPersonalNotes.id)).all() : [],
        recentActivity: relevant,
        newActivity: relevant.filter(isNew)
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
      const active = requireActivePlayerCharacter(tokenHash);
      const name = validatedPlayerName(displayName);
      const duplicate = db.select().from(schema.players).where(eq(schema.players.sessionId, active.sessionId)).all()
        .some((player) => player.id !== active.playerId && player.displayName.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"));
      if (duplicate) throw new Error("A player with this name already requested access.");
      return db.update(schema.players).set({ displayName: name })
        .where(eq(schema.players.id, active.playerId)).returning().get();
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
        if (!session || session.status !== "active") throw new Error("Session is not accepting requests.");
        const name = validatedPlayerName(displayName);
        const existing = db.select().from(schema.players).where(eq(schema.players.tokenHash, tokenHash)).get();
        if (existing && existing.sessionId !== sessionId) {
          throw new Error("This device already belongs to another session.");
        }
        if (existing && existing.status !== "rejected") return getPlayer(existing.id)!;
        const sameSession = db.select({ id: schema.players.id, displayName: schema.players.displayName })
          .from(schema.players).where(eq(schema.players.sessionId, sessionId)).all();
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
        createdAt: schema.players.createdAt,
        characterId: schema.characters.id,
        characterName: schema.characters.name
      }).from(schema.players)
        .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
        .leftJoin(schema.sessionCharacterAssignments, and(
          eq(schema.sessionCharacterAssignments.playerId, schema.players.id),
          eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId)
        ))
        .leftJoin(schema.characters, eq(schema.characters.id, schema.sessionCharacterAssignments.characterId))
        .where(eq(schema.sessions.campaignId, campaignId))
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
        quote: schema.characters.quote
      }).from(schema.characters).where(eq(schema.characters.campaignId, campaignId))
        .orderBy(asc(schema.characters.name), asc(schema.characters.id)).all().map(characterRecord);
    },
    listPersonalNotesByCharacter(characterId: string) {
      return db.select().from(schema.characterPersonalNotes)
        .where(eq(schema.characterPersonalNotes.characterId, characterId))
        .orderBy(desc(schema.characterPersonalNotes.updatedAt), desc(schema.characterPersonalNotes.id)).all();
    },
    listCharacterActivity(characterId: string, limit = 20) {
      return activityRows(db.select().from(schema.campaignActivity)
        .where(eq(schema.campaignActivity.characterId, characterId))
        .orderBy(desc(schema.campaignActivity.createdAt), desc(schema.campaignActivity.id)).limit(limit).all());
    },
    getCharacterOverview(characterId: string) {
      const character = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get();
      if (!character) return null;
      const player = db.select({ id: schema.players.id, displayName: schema.players.displayName })
        .from(schema.sessionCharacterAssignments)
        .innerJoin(schema.players, eq(schema.sessionCharacterAssignments.playerId, schema.players.id))
        .innerJoin(schema.sessions, eq(schema.sessionCharacterAssignments.sessionId, schema.sessions.id))
        .where(and(eq(schema.sessionCharacterAssignments.characterId, characterId), eq(schema.players.status, "approved"), eq(schema.sessions.status, "active"))).get() ?? null;
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
          .where(and(eq(schema.sessionCharacterAssignments.characterId, characterId), eq(schema.sessions.status, "active"), eq(schema.players.status, "approved"))).get();
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
          sessionId: schema.sessions.id
        }).from(schema.characters)
          .innerJoin(schema.sessionCharacterAssignments, eq(schema.characters.id, schema.sessionCharacterAssignments.characterId))
          .innerJoin(schema.players, and(
            eq(schema.sessionCharacterAssignments.playerId, schema.players.id),
            eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId)
          ))
          .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
          .where(and(
            eq(schema.characters.id, characterId),
            eq(schema.players.status, "approved"),
            eq(schema.sessions.status, "active"),
            eq(schema.sessions.campaignId, schema.characters.campaignId)
          )).get();
        if (!character) throw new Error("Character is not in the active session.");
        const catalogItem = db.select().from(schema.catalogItems)
          .where(and(eq(schema.catalogItems.id, catalogItemId), eq(schema.catalogItems.campaignId, character.campaignId))).get();
        if (!catalogItem) throw new Error("Catalog item is unavailable for this campaign.");
        const existing = db.select().from(schema.inventoryItems)
          .where(eq(schema.inventoryItems.characterId, characterId)).all()
          .find((item) => item.name.toLocaleLowerCase("ru") === catalogItem.name.toLocaleLowerCase("ru"));
        if (existing) {
          if (existing.quantity + quantity > 9999) throw new Error("Item quantity limit exceeded.");
          const item = db.update(schema.inventoryItems)
            .set({ quantity: existing.quantity + quantity, catalogItemId })
            .where(eq(schema.inventoryItems.id, existing.id)).returning().get();
          appendActivity({ campaignId: character.campaignId, sessionId: character.sessionId, characterId, catalogItemId, type: "item_granted", details: { itemName: catalogItem.name, quantity, totalQuantity: item.quantity } });
          return item;
        }
        const item = db.insert(schema.inventoryItems).values({
          id: randomUUID(), characterId, catalogItemId, name: catalogItem.name, quantity, createdAt: new Date().toISOString()
        }).returning().get();
        appendActivity({ campaignId: character.campaignId, sessionId: character.sessionId, characterId, catalogItemId, type: "item_granted", details: { itemName: catalogItem.name, quantity, totalQuantity: item.quantity } });
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
          campaignId: schema.sessions.campaignId
        }).from(schema.players)
          .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
          .where(eq(schema.players.id, playerId)).get();
        if (!request) throw new Error("Player request not found.");
        if (request.status === "approved") return getPlayer(playerId)!;
        if (request.status === "rejected") throw new Error("Rejected request cannot be approved.");
        if (request.sessionStatus !== "active") throw new Error("Session has ended.");

        if ("characterId" in assignment) {
          const character = db.select().from(schema.characters)
            .where(and(eq(schema.characters.id, assignment.characterId), eq(schema.characters.campaignId, request.campaignId)))
            .get();
          if (!character || character.archivedAt) throw new Error("Character is unavailable for this campaign.");
          const existingAssignment = db.select({ playerId: schema.sessionCharacterAssignments.playerId })
            .from(schema.sessionCharacterAssignments)
            .where(and(
              eq(schema.sessionCharacterAssignments.sessionId, request.sessionId),
              eq(schema.sessionCharacterAssignments.characterId, character.id)
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
        if (!session) throw new Error("Session not found.");
        if (session.status === "ended") throw new Error("An ended session cannot be activated.");
        if (session.status === "active") return session;
        if (expectedActiveSessionId !== undefined) {
          const current = db.select().from(schema.sessions).where(eq(schema.sessions.status, "active")).get();
          if ((current?.id ?? null) !== expectedActiveSessionId) throw new Error("Active session changed.");
        }
        const previous = db.select().from(schema.sessions).where(eq(schema.sessions.status, "active")).get();
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
      if (!session) throw new Error("Session not found.");
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
        .where(eq(schema.sessions.status, "active")).get() ?? null;
    }
  };
}

export type GameDatabase = ReturnType<typeof openDatabase>;
