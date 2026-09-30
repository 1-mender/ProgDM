import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import SQLite from "better-sqlite3";
import { and, asc, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Campaign, CampaignItem, KnowledgeCategory, KnowledgeVisibility, Session, SessionSnapshot } from "@progdm/shared";
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

  const client = new SQLite(file);
  const db = drizzle(client, { schema });
  const backupIdPattern = /^progdm-backup-([0-9a-f-]{36})\.db$/;
  const backupTables = ["campaigns", "sessions", "players", "characters", "session_character_assignments", "catalog_items", "inventory_items", "knowledge_entries", "knowledge_migration_issues", "__drizzle_migrations"];

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
        staged.pragma("foreign_keys = OFF");
        migrate(drizzle(staged, { schema }), { migrationsFolder });
        staged.pragma("foreign_keys = ON");

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
    listCampaigns(): Campaign[] {
      return db.select().from(schema.campaigns).orderBy(asc(schema.campaigns.createdAt), asc(schema.campaigns.id)).all();
    },
    getCampaign(id: string): Campaign | null {
      return db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get() ?? null;
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
      }).from(schema.players).where(or(...sessionIds.map((sessionId) => eq(schema.players.sessionId, sessionId)))).all() : [];
      const characters = db.select({
        id: schema.characters.id, name: schema.characters.name, createdAt: schema.characters.createdAt
      }).from(schema.characters).where(eq(schema.characters.campaignId, id)).all();
      const characterIds = characters.map((character) => character.id);
      const assignments = sessionIds.length ? db.select({
        playerId: schema.sessionCharacterAssignments.playerId,
        sessionId: schema.sessionCharacterAssignments.sessionId,
        characterId: schema.sessionCharacterAssignments.characterId,
        createdAt: schema.sessionCharacterAssignments.createdAt
      }).from(schema.sessionCharacterAssignments)
        .where(or(...sessionIds.map((sessionId) => eq(schema.sessionCharacterAssignments.sessionId, sessionId)))).all() : [];
      const catalogItems = db.select({
        id: schema.catalogItems.id, name: schema.catalogItems.name, createdAt: schema.catalogItems.createdAt
      }).from(schema.catalogItems).where(eq(schema.catalogItems.campaignId, id)).all();
      const inventoryItems = characterIds.length ? db.select({
        id: schema.inventoryItems.id, characterId: schema.inventoryItems.characterId,
        catalogItemId: schema.inventoryItems.catalogItemId, name: schema.inventoryItems.name,
        quantity: schema.inventoryItems.quantity, createdAt: schema.inventoryItems.createdAt
      }).from(schema.inventoryItems)
        .where(or(...characterIds.map((characterId) => eq(schema.inventoryItems.characterId, characterId)))).all() : [];
      const knowledge = db.select({
        id: schema.knowledgeEntries.id, category: schema.knowledgeEntries.category, title: schema.knowledgeEntries.title,
        description: schema.knowledgeEntries.description, visibility: schema.knowledgeEntries.visibility,
        visibleToCharacterId: schema.knowledgeEntries.visibleToCharacterId, createdAt: schema.knowledgeEntries.createdAt
      }).from(schema.knowledgeEntries).where(eq(schema.knowledgeEntries.campaignId, id)).all()
        .map((entry) => ({ ...entry }));
      return {
        format: "progdm-campaign", version: 1, exportedAt: new Date().toISOString(), campaign,
        sessions, players, assignments, characters, catalogItems, inventoryItems, knowledge
      };
    },
    importCampaign(source: unknown) {
      const archive = transferRecord(source);
      if (archive.format !== "progdm-campaign" || archive.version !== 1) throw new Error("Campaign file format is not supported.");
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
      const catalogItems = transferArray(archive, "catalogItems");
      const inventoryItems = transferArray(archive, "inventoryItems");
      const knowledge = transferArray(archive, "knowledge");
      const campaignId = randomUUID();
      const sessionsWithPlayers = new Set(players.map((row) => transferString(row, "sessionId")));
      const sessionIds = new Map(sessions.map((row) => [transferString(row, "id"), randomUUID()]));
      const playerIds = new Map(players.map((row) => [transferString(row, "id"), randomUUID()]));
      const characterIds = new Map(characters.map((row) => [transferString(row, "id"), randomUUID()]));
      const catalogIds = new Map(catalogItems.map((row) => [transferString(row, "id"), randomUUID()]));
      const requireMapped = (map: Map<string, string>, id: unknown) => {
        if (typeof id !== "string" || !map.has(id)) throw new Error("Campaign file contains an invalid reference.");
        return map.get(id)!;
      };
      const playerSessionIds = new Map(players.map((row) => [transferString(row, "id"), transferString(row, "sessionId")]));
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
        for (const row of characters) db.insert(schema.characters).values({
          id: requireMapped(characterIds, row.id), campaignId, name: validatedName(transferString(row, "name", 120)), createdAt: createdAt(row)
        }).run();
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
          const category = transferString(row, "category");
          const sourceVisibility = transferString(row, "visibility");
          if (!["npc", "monster", "note", "quest"].includes(category) || !["hidden", "character", "party", "player"].includes(sourceVisibility)) throw new Error("Campaign file is invalid.");
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
            id: newId(), campaignId, category: category as KnowledgeCategory,
            title: validatedName(transferString(row, "title", 120)),
            description: validatedDescription(transferString(row, "description", 2000)),
            visibility, visibleToCharacterId, createdAt: createdAt(row)
          }).run();
        }
        return campaign;
      });
    },
    createCampaign(name: string): Campaign {
      return db.insert(schema.campaigns).values({
        id: randomUUID(),
        name: validatedName(name),
        createdAt: new Date().toISOString()
      }).returning().get();
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
        characterName: schema.characters.name
      }).from(schema.players)
        .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
        .innerJoin(schema.campaigns, eq(schema.sessions.campaignId, schema.campaigns.id))
        .leftJoin(schema.sessionCharacterAssignments, and(
          eq(schema.sessionCharacterAssignments.playerId, schema.players.id),
          eq(schema.sessionCharacterAssignments.sessionId, schema.players.sessionId)
        ))
        .leftJoin(schema.characters, eq(schema.characters.id, schema.sessionCharacterAssignments.characterId))
        .where(eq(schema.players.tokenHash, tokenHash)).get();
      if (!player) return null;
      const knowledge = player.status === "approved"
        ? db.select().from(schema.knowledgeEntries)
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
          .orderBy(asc(schema.knowledgeEntries.createdAt), asc(schema.knowledgeEntries.title)).all()
        : [];
      return {
        displayName: player.displayName,
        status: player.status,
        campaignName: player.campaignName,
        sessionName: player.sessionName,
        characterName: player.characterName,
        inventory: player.characterId
          ? db.select().from(schema.inventoryItems)
            .where(eq(schema.inventoryItems.characterId, player.characterId))
            .orderBy(asc(schema.inventoryItems.createdAt), asc(schema.inventoryItems.name)).all()
          : [],
        knowledge
      };
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
          return getPlayer(existing.id)!;
        }
        const player = db.insert(schema.players).values({
          id: randomUUID(), sessionId, displayName: name, tokenHash, status: "pending", createdAt
        }).returning().get();
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
        createdAt: schema.characters.createdAt
      }).from(schema.characters).where(eq(schema.characters.campaignId, campaignId))
        .orderBy(asc(schema.characters.name), asc(schema.characters.id)).all();
    },
    listCatalogItemsByCampaign(campaignId: string): CampaignItem[] {
      return db.select().from(schema.catalogItems).where(eq(schema.catalogItems.campaignId, campaignId))
        .orderBy(asc(schema.catalogItems.name), asc(schema.catalogItems.id)).all();
    },
    createCatalogItem(campaignId: string, name: string): CampaignItem {
      const campaign = db.select({ id: schema.campaigns.id }).from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId)).get();
      if (!campaign) throw new Error("Campaign not found.");
      const itemName = validatedName(name);
      const duplicate = db.select({ name: schema.catalogItems.name }).from(schema.catalogItems)
        .where(eq(schema.catalogItems.campaignId, campaignId)).all()
        .some((item) => item.name.toLocaleLowerCase("ru") === itemName.toLocaleLowerCase("ru"));
      if (duplicate) throw new Error("Catalog item already exists.");
      return db.insert(schema.catalogItems).values({
        id: randomUUID(), campaignId, name: itemName, createdAt: new Date().toISOString()
      }).returning().get();
    },
    listKnowledgeByCampaign(campaignId: string) {
      return db.select().from(schema.knowledgeEntries)
        .where(eq(schema.knowledgeEntries.campaignId, campaignId))
        .orderBy(asc(schema.knowledgeEntries.createdAt), asc(schema.knowledgeEntries.title)).all();
    },
    createKnowledge(campaignId: string, category: KnowledgeCategory, title: string, description: string) {
      const campaign = db.select({ id: schema.campaigns.id }).from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId)).get();
      if (!campaign) throw new Error("Campaign not found.");
      return db.insert(schema.knowledgeEntries).values({
        id: randomUUID(), campaignId, category, title: validatedName(title),
        description: validatedDescription(description), visibility: "hidden", visibleToCharacterId: null,
        createdAt: new Date().toISOString()
      }).returning().get();
    },
    setKnowledgeVisibility(entryId: string, visibility: KnowledgeVisibility, characterId?: string) {
      return db.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id, campaignId: schema.knowledgeEntries.campaignId })
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
        return db.update(schema.knowledgeEntries).set({ visibility, visibleToCharacterId })
          .where(eq(schema.knowledgeEntries.id, entryId)).returning().get()!;
      });
    },
    createCharacter(campaignId: string, name: string) {
      const campaign = db.select({ id: schema.campaigns.id }).from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId)).get();
      if (!campaign) throw new Error("Campaign not found.");
      return db.insert(schema.characters).values({
        id: randomUUID(), campaignId, name: validatedName(name), createdAt: new Date().toISOString()
      }).returning().get();
    },
    grantInventoryItem(characterId: string, catalogItemId: string, quantity: number) {
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
        throw new Error("Item quantity must be between 1 and 9999.");
      }
      return db.transaction(() => {
        const character = db.select({
          id: schema.characters.id,
          campaignId: schema.characters.campaignId
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
          return db.update(schema.inventoryItems)
            .set({ quantity: existing.quantity + quantity, catalogItemId })
            .where(eq(schema.inventoryItems.id, existing.id)).returning().get();
        }
        return db.insert(schema.inventoryItems).values({
          id: randomUUID(), characterId, catalogItemId, name: catalogItem.name, quantity, createdAt: new Date().toISOString()
        }).returning().get();
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
          if (!character) throw new Error("Character is unavailable for this campaign.");
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
        } else {
          const name = validatedName(assignment.characterName);
          const character = db.insert(schema.characters).values({
            id: randomUUID(), campaignId: request.campaignId, name, createdAt: new Date().toISOString()
          }).returning().get();
          db.insert(schema.sessionCharacterAssignments).values({
            playerId, sessionId: request.sessionId, characterId: character.id, createdAt: new Date().toISOString()
          }).run();
        }
        db.update(schema.players).set({ status: "approved" })
          .where(and(eq(schema.players.id, playerId), eq(schema.players.status, "pending"))).run();
        return getPlayer(playerId)!;
      });
    },
    rejectPlayer(playerId: string) {
      const player = getPlayer(playerId);
      if (!player) throw new Error("Player request not found.");
      if (player.status === "approved") throw new Error("Approved player cannot be rejected.");
      if (player.status === "rejected") return player;
      db.update(schema.players).set({ status: "rejected" })
        .where(and(eq(schema.players.id, playerId), eq(schema.players.status, "pending"))).run();
      return getPlayer(playerId)!;
    },
    createSession(campaignId: string, name: string): Session {
      return db.insert(schema.sessions).values({
        id: randomUUID(),
        campaignId,
        name: validatedName(name),
        joinToken: randomBytes(32).toString("base64url"),
        createdAt: new Date().toISOString()
      }).returning().get();
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
        db.update(schema.sessions).set({ status: "ended" }).where(eq(schema.sessions.status, "active")).run();
        return db.update(schema.sessions).set({ status: "active" }).where(eq(schema.sessions.id, id)).returning().get()!;
      });
    },
    endSession(id: string): Session {
      const session = getSession(id);
      if (!session) throw new Error("Session not found.");
      if (session.status === "ended") return session;
      if (session.status !== "active") throw new Error("Only an active session can be ended.");
      return db.update(schema.sessions).set({ status: "ended" }).where(eq(schema.sessions.id, id)).returning().get()!;
    },
    getCurrentSession(): SessionSnapshot | null {
      return db.select({ campaign: schema.campaigns, session: schema.sessions }).from(schema.sessions)
        .innerJoin(schema.campaigns, eq(schema.sessions.campaignId, schema.campaigns.id))
        .where(eq(schema.sessions.status, "active")).get() ?? null;
    }
  };
}

export type GameDatabase = ReturnType<typeof openDatabase>;
