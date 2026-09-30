import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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

export function openDatabase(options: { file?: string } = {}) {
  const file = resolveDatabaseFile(options.file);
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });

  const client = new SQLite(file);
  const db = drizzle(client, { schema });
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
    listCampaigns(): Campaign[] {
      return db.select().from(schema.campaigns).orderBy(asc(schema.campaigns.createdAt), asc(schema.campaigns.id)).all();
    },
    getCampaign(id: string): Campaign | null {
      return db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get() ?? null;
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
                eq(schema.knowledgeEntries.visibility, "player"),
                eq(schema.knowledgeEntries.visibleToPlayerId, player.id)
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
        description: validatedDescription(description), visibility: "hidden", visibleToPlayerId: null,
        createdAt: new Date().toISOString()
      }).returning().get();
    },
    setKnowledgeVisibility(entryId: string, visibility: KnowledgeVisibility, playerId?: string) {
      return db.transaction(() => {
        const entry = db.select({ id: schema.knowledgeEntries.id, campaignId: schema.knowledgeEntries.campaignId })
          .from(schema.knowledgeEntries).where(eq(schema.knowledgeEntries.id, entryId)).get();
        if (!entry) throw new Error("Knowledge entry not found.");
        let visibleToPlayerId: string | null = null;
        if (visibility === "player") {
          if (!playerId) throw new Error("A player must be selected.");
          const player = db.select({ id: schema.players.id }).from(schema.players)
            .innerJoin(schema.sessions, eq(schema.players.sessionId, schema.sessions.id))
            .where(and(
              eq(schema.players.id, playerId),
              eq(schema.players.status, "approved"),
              eq(schema.sessions.status, "active"),
              eq(schema.sessions.campaignId, entry.campaignId)
            )).get();
          if (!player) throw new Error("Player is not in the active campaign session.");
          visibleToPlayerId = player.id;
        }
        return db.update(schema.knowledgeEntries).set({ visibility, visibleToPlayerId })
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
