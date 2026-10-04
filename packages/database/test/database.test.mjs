import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { fileURLToPath } from "node:url";
import SQLite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { ACTIVITY_TYPES } from "@progdm/shared";
import { openDatabase, resolveDatabaseFile } from "../dist/index.js";

function temporaryFile(t) {
  const directory = mkdtempSync(join(tmpdir(), "progdm-db-test-"));
  t.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return join(directory, "nested", "game.db");
}

function memoryDatabase(t) {
  const database = openDatabase({ file: ":memory:" });
  t.after(() => database.close());
  return database;
}

function activeInventoryPair(database, campaignName = "Transfers") {
  const campaign = database.createCampaign(campaignName);
  const sender = database.createCharacter(campaign.id, "Mira");
  const recipient = database.createCharacter(campaign.id, "Rowan");
  const session = database.createSession(campaign.id, "Active session");
  database.activateSession(session.id);
  const senderPlayer = database.submitPlayerRequest(session.id, "Mira player", `${campaignName}-sender-token`);
  const recipientPlayer = database.submitPlayerRequest(session.id, "Rowan player", `${campaignName}-recipient-token`);
  database.approvePlayer(senderPlayer.id, { characterId: sender.id });
  database.approvePlayer(recipientPlayer.id, { characterId: recipient.id });
  return { campaign, sender, recipient, session, senderPlayer, recipientPlayer,
    senderToken: `${campaignName}-sender-token`, recipientToken: `${campaignName}-recipient-token` };
}

test("failed activity append rolls back an inventory grant", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Campaign");
    const mira = db.createCharacter(campaign.id, "Mira");
    const item = db.createCatalogItem(campaign.id, "Key");
    const session = db.createSession(campaign.id, "Session");
    db.activateSession(session.id);
    const player = db.submitPlayerRequest(session.id, "A", "hash-a");
    db.approvePlayer(player.id, { characterId: mira.id });
    const raw = new SQLite(file);
    raw.exec("CREATE TRIGGER reject_grant_event BEFORE INSERT ON campaign_activity WHEN NEW.type='item_granted' BEGIN SELECT RAISE(ABORT, 'test activity failure'); END");
    raw.close();
    const before = db.listCampaignActivity(campaign.id);
    assert.throws(() => db.grantInventoryItem(mira.id, item.id, 1), /test activity failure/);
    assert.deepEqual(db.getPlayerState("hash-a").inventory, []);
    assert.deepEqual(db.listCampaignActivity(campaign.id), before);
  } finally { db.close(); }
});

test("backup migration hashes remain compatible across LF and CRLF checkouts", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    db.createCampaign("Portable backup");
    const raw = new SQLite(file);
    const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../migrations/", import.meta.url)) });
    for (const migration of migrations) {
      const sql = migration.sql.join("--> statement-breakpoint");
      const alternate = sql.includes("\r\n") ? sql.replace(/\r\n/g, "\n") : sql.replace(/\n/g, "\r\n");
      raw.prepare("UPDATE __drizzle_migrations SET hash=? WHERE created_at=?")
        .run(createHash("sha256").update(alternate).digest("hex"), migration.folderMillis);
    }
    raw.close();
    assert.equal(db.checkDataHealth().ok, true);
    const backup = await db.createBackup();
    db.createCampaign("Later");
    await db.restoreBackup(backup.id);
    assert.deepEqual(db.listCampaigns().map((row) => row.name), ["Portable backup"]);
    assert.equal(db.checkDataHealth().ok, true);
  } finally { db.close(); }
});

test("legacy campaign formats v1 through v8 import with inventory defaults and ID remapping", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Legacy");
  const mira = db.createCharacter(campaign.id, "Mira");
  const legacyItem = db.createCatalogItem(campaign.id, "Legacy catalog item");
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "secret-hash");
  db.approvePlayer(player.id, { characterId: mira.id });
  db.grantInventoryItem(mira.id, legacyItem.id, 1);
  db.createPersonalNote("secret-hash", "Legacy note body");
  const clue = db.createKnowledge(campaign.id, "fact", "Clue", "Personal knowledge");
  db.setKnowledgeVisibility(clue.id, "character", mira.id);
  const current = db.exportCampaign(campaign.id);
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const legacy = structuredClone(current);
    legacy.version = version;
    if (version < 7) legacy.knowledge[0].category = "note";
    for (const character of legacy.characters) {
      if (version < 9) delete character.inventoryCapacity;
      if (version < 5) {
        delete character.traits;
        delete character.appearance;
        delete character.quote;
      }
      if (version < 3) {
        delete character.shortDescription;
        delete character.archetype;
        delete character.origin;
        delete character.personalGoal;
        delete character.dmNotes;
      }
    }
    if (version < 9) {
      for (const item of legacy.catalogItems) {
        delete item.description;
        delete item.category;
        delete item.rarity;
        delete item.equipmentSlot;
        delete item.transferAllowed;
        delete item.discardAllowed;
      }
      for (const item of legacy.inventoryItems) delete item.equippedSlot;
    }
    if (version < 3) delete legacy.personalNotes;
    if (version === 1) {
      delete legacy.activity;
      delete legacy.characters[0].archivedAt;
      legacy.knowledge[0].visibility = "player";
      legacy.knowledge[0].visibleToPlayerId = player.id;
      delete legacy.knowledge[0].visibleToCharacterId;
    }
    if (version < 6) {
      delete legacy.profileFields;
      delete legacy.profileFieldValues;
    }
    let imported;
    try { imported = db.importCampaign(legacy); }
    catch (error) { throw new Error(`Legacy archive v${version} failed: ${error.message}`, { cause: error }); }
    const exported = db.exportCampaign(imported.id);
    assert.equal(exported.knowledge[0].category, "fact");
    assert.equal(exported.sessions[0].status, "ended");
    assert.equal(exported.knowledge[0].visibility, "character");
    assert.equal(exported.knowledge[0].visibleToCharacterId, exported.characters[0].id);
    assert.equal(exported.assignments[0].playerId, exported.players[0].id);
    assert.equal(exported.assignments[0].sessionId, exported.sessions[0].id);
    assert.deepEqual({ traits: exported.characters[0].traits, appearance: exported.characters[0].appearance, quote: exported.characters[0].quote }, {
      traits: [], appearance: "", quote: ""
    });
    assert.equal(exported.characters[0].inventoryCapacity, 12);
    assert.deepEqual({ description: exported.catalogItems[0].description, category: exported.catalogItems[0].category,
      rarity: exported.catalogItems[0].rarity, equipmentSlot: exported.catalogItems[0].equipmentSlot,
      transferAllowed: exported.catalogItems[0].transferAllowed, discardAllowed: exported.catalogItems[0].discardAllowed },
    { description: "", category: "special", rarity: null, equipmentSlot: null, transferAllowed: true, discardAllowed: true });
    assert.equal(exported.inventoryItems[0].equippedSlot, null);
    if (version === 3) assert.deepEqual({ title: exported.personalNotes[0].title, marker: exported.personalNotes[0].marker, pinned: exported.personalNotes[0].pinned }, {
      title: "", marker: "normal", pinned: false
    });
    assert.equal(JSON.stringify(exported).includes("secret-hash"), false);
    assert.equal(db.checkDataHealth().ok, true, `legacy archive v${version}: ${JSON.stringify(db.checkDataHealth())}`);
  }
});

test("campaign export supports more than SQLite's OR expression depth in characters", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Large campaign");
  for (let i = 0; i < 1001; i++) db.createCharacter(campaign.id, "Character " + i);
  const exported = db.exportCampaign(campaign.id);
  assert.equal(exported.characters.length, 1001);
  const imported = db.importCampaign(exported);
  assert.equal(db.listCharactersByCampaign(imported.id).length, 1001);
});

test("inconsistent assignment sessions cannot grant private reads or writes", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Campaign");
    const mira = db.createCharacter(campaign.id, "Mira");
    const active = db.createSession(campaign.id, "Active");
    const planned = db.createSession(campaign.id, "Planned");
    db.activateSession(active.id);
    const player = db.submitPlayerRequest(active.id, "A", "hash-a");
    db.approvePlayer(player.id, { characterId: mira.id });
    db.createPersonalNote("hash-a", "Private note");
    const raw = new SQLite(file);
    raw.prepare("UPDATE session_character_assignments SET session_id=? WHERE player_id=?").run(planned.id, player.id);
    raw.close();
    assert.equal(db.checkDataHealth().ok, false);
    const view = db.getPlayerState("hash-a");
    assert.equal(view.canEdit, false);
    assert.deepEqual(view.notes, []);
    assert.throws(() => db.updatePlayerProfile("hash-a", { shortDescription: "Invalid", personalGoal: "Invalid" }), /Active character/);
    const other = db.createCampaign("Other");
    const foreignCharacter = db.createCharacter(other.id, "Nora");
    const rawForeign = new SQLite(file);
    rawForeign.prepare("UPDATE session_character_assignments SET session_id=?, character_id=? WHERE player_id=?")
      .run(active.id, foreignCharacter.id, player.id);
    rawForeign.close();
    const foreignView = db.getPlayerState("hash-a");
    assert.equal(foreignView.characterId, null);
    assert.equal(foreignView.canEdit, false);
    assert.deepEqual(foreignView.inventory, []);
  } finally { db.close(); }
});

test("Player inventory projection scopes catalog metadata to its campaign and preserves safe legacy rows", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "progdm-db-test-"));
  const file = join(directory, "nested", "game.db");
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  t.after(() => db.close());
  t.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const campaign = db.createCampaign("Projection");
  const otherCampaign = db.createCampaign("Foreign");
  const character = db.createCharacter(campaign.id, "Mira");
  const otherCharacter = db.createCharacter(otherCampaign.id, "Nora");
  const ownCatalog = db.createCatalogItem(campaign.id, "Compass");
  const foreignCatalog = db.createCatalogItem(otherCampaign.id, "Foreign relic");
  db.updateCatalogItemMetadata(ownCatalog.id, { description: "A brass compass", category: "tool", rarity: "rare", equipmentSlot: "accessory" });
  db.updateCatalogItemMetadata(foreignCatalog.id, { description: "Secret campaign metadata", category: "artifact", rarity: "unique", equipmentSlot: "special" });
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const approved = db.submitPlayerRequest(session.id, "A", "projection-approved");
  db.approvePlayer(approved.id, { characterId: character.id });
  const pending = db.submitPlayerRequest(session.id, "Pending", "projection-pending");
  const rejected = db.submitPlayerRequest(session.id, "Rejected", "projection-rejected");
  db.rejectPlayer(rejected.id);

  const ownRow = db.grantInventoryItem(character.id, ownCatalog.id, 1);
  const raw = new SQLite(db.file);
  try {
    raw.pragma("foreign_keys = OFF");
    raw.prepare(`INSERT INTO inventory_items (id, character_id, catalog_item_id, name, quantity, equipped_slot, created_at)
      VALUES (?, ?, NULL, ?, ?, NULL, ?), (?, ?, ?, ?, ?, NULL, ?)`)
      .run("legacy-player-row", character.id, "Old item", 3, "2026-01-01T00:00:00.000Z",
        "foreign-player-row", character.id, foreignCatalog.id, "Borrowed row", 1, "2026-01-02T00:00:00.000Z");
  } finally { raw.close(); }
  db.updateCharacterInventoryCapacity(character.id, 7);
  const state = db.getPlayerState("projection-approved");
  assert.equal(state.inventoryCapacity, 7);
  assert.deepEqual(state.inventory.find((item) => item.id === ownRow.id), {
    id: ownRow.id, catalogItemId: ownCatalog.id, name: "Compass", quantity: 1,
    description: "A brass compass", category: "tool", rarity: "rare", equipmentSlot: "accessory",
    transferAllowed: true, discardAllowed: true, equippedSlot: null, createdAt: ownRow.createdAt
  });
  assert.deepEqual(state.inventory.find((item) => item.id === "legacy-player-row"), {
    id: "legacy-player-row", catalogItemId: null, name: "Old item", quantity: 3,
    description: "", category: "special", rarity: null, equipmentSlot: null, transferAllowed: true, discardAllowed: true, equippedSlot: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(state.inventory.find((item) => item.id === "foreign-player-row"), {
    id: "foreign-player-row", catalogItemId: null, name: "Borrowed row", quantity: 1,
    description: "", category: "special", rarity: null, equipmentSlot: null, transferAllowed: false, discardAllowed: false, equippedSlot: null,
    createdAt: "2026-01-02T00:00:00.000Z"
  });
  assert.equal(JSON.stringify(state.inventory).includes("Secret campaign metadata"), false);
  for (const token of ["projection-pending", "projection-rejected"]) {
    const restricted = db.getPlayerState(token);
    assert.deepEqual(restricted.inventory, []);
    assert.equal(restricted.inventoryCapacity, null);
  }
  assert.equal(db.getCharacterOverview(otherCharacter.id).inventory.length, 0);
});

test("import rejects activity tied to another player's session and rolls back", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Audit");
  const first = db.createSession(campaign.id, "First");
  db.activateSession(first.id);
  const player = db.submitPlayerRequest(first.id, "A", "hash-a");
  const second = db.createSession(campaign.id, "Second");
  const archive = db.exportCampaign(campaign.id);
  const event = archive.activity.find((row) => row.playerId === player.id);
  event.sessionId = second.id;
  const before = db.listCampaigns().length;
  assert.throws(() => db.importCampaign(archive), /invalid event session/);
  assert.equal(db.listCampaigns().length, before);
});

test("health and restore reject altered migration hashes without changing the backup", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Original");
    const backup = await db.createBackup();
    const raw = new SQLite(db.backupFile(backup.id));
    assert.equal(raw.prepare("UPDATE __drizzle_migrations SET hash = 'tampered' WHERE rowid = 1").run().changes, 1);
    raw.close();
    const backupBytes = readFileSync(db.backupFile(backup.id));
    const later = db.createCampaign("Later");
    await assert.rejects(db.restoreBackup(backup.id), /migration history/);
    assert.ok(db.getCampaign(campaign.id));
    assert.ok(db.getCampaign(later.id));
    assert.deepEqual(readFileSync(db.backupFile(backup.id)), backupBytes);
    const live = new SQLite(file);
    assert.equal(live.prepare("UPDATE __drizzle_migrations SET hash = 'tampered' WHERE rowid = 1").run().changes, 1);
    live.close();
    assert.equal(db.checkDataHealth().checks.find((check) => check.name === "Миграции").status, "error");
  } finally { db.close(); }
});

test("migrations create an empty database and preserve data across process restarts", (t) => {
  const file = temporaryFile(t);
  let database = openDatabase({ file });
  let expected;
  try {
    assert.deepEqual(database.listCampaigns(), []);
    assert.equal(database.getCurrentSession(), null);
    const campaign = database.createCampaign("  First campaign  ");
    assert.equal(campaign.name, "First campaign");
    const session = database.createSession(campaign.id, "First session");
    database.activateSession(session.id);
    expected = database.getCurrentSession();
  } finally {
    database.close();
  }

  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { openDatabase } from ${JSON.stringify(moduleUrl)};
    const database = openDatabase();
    try { console.log(JSON.stringify(database.getCurrentSession())); }
    finally { database.close(); }
  `], { env: { ...process.env, PROGDM_DATABASE_FILE: file }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), expected);

  database = openDatabase({ file });
  try {
    assert.equal(database.listCampaigns().length, 1);
    assert.equal(database.listSessions(expected.campaign.id).length, 1);
    assert.deepEqual(database.getCurrentSession(), expected);
  } finally {
    database.close();
  }
});

test("activity and archive preserve a character across sessions and campaign export", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Long story");
  const mira = db.createCharacter(campaign.id, "Mira");
  const item = db.createCatalogItem(campaign.id, "Compass");
  const first = db.createSession(campaign.id, "First night");
  db.activateSession(first.id);
  const playerA = db.submitPlayerRequest(first.id, "Player A", "private-player-hash");
  db.approvePlayer(playerA.id, { characterId: mira.id });
  assert.throws(() => db.archiveCharacter(mira.id), /active character/);
  assert.equal(db.listCampaignActivity(campaign.id).some((event) => event.type === "character_archived"), false);
  db.grantInventoryItem(mira.id, item.id, 2);
  const knowledge = db.createKnowledge(campaign.id, "fact", "Secret door", "Behind the library");
  db.setKnowledgeVisibility(knowledge.id, "character", mira.id);
  assert.equal(db.getPlayerState("private-player-hash").knowledge.some((entry) => entry.id === knowledge.id), true);
  db.endSession(first.id);

  const archived = db.archiveCharacter(mira.id);
  assert.ok(archived.archivedAt);
  const history = db.listCampaignActivity(campaign.id);
  assert.deepEqual(history.map((event) => event.type), [
    "campaign_created", "character_created", "catalog_item_created", "session_created", "session_started",
    "player_requested", "character_assigned", "player_approved", "item_granted", "knowledge_created",
    "knowledge_visibility_changed", "session_ended", "character_archived"
  ]);
  assert.equal(history.find((event) => event.type === "item_granted").details.quantity, 2);
  assert.equal(db.listSessionActivity(first.id).some((event) => event.type === "item_granted"), true);
  assert.equal(JSON.stringify(history).includes("private-player-hash"), false);
  assert.equal(JSON.stringify(history).includes(first.joinToken), false);

  const archive = db.exportCampaign(campaign.id);
  assert.equal(archive.version, 10);
  assert.equal(archive.characters.find((row) => row.id === mira.id).archivedAt, archived.archivedAt);
  assert.equal(JSON.stringify(archive).includes("private-player-hash"), false);
  assert.equal(JSON.stringify(archive).includes(first.joinToken), false);
  const imported = db.importCampaign(archive);
  const importedMira = db.listCharactersByCampaign(imported.id)[0];
  assert.ok(importedMira.archivedAt);
  assert.equal(db.listKnowledgeByCampaign(imported.id)[0].visibleToCharacterId, importedMira.id);
  assert.equal(db.listCampaignActivity(imported.id).find((event) => event.type === "item_granted").characterId, importedMira.id);
  assert.equal(db.listCampaignActivity(imported.id).find((event) => event.type === "knowledge_visibility_changed").knowledgeEntryId,
    db.listKnowledgeByCampaign(imported.id)[0].id);
  assert.equal(JSON.stringify(db.listCampaignActivity(imported.id)).includes("private-player-hash"), false);
  assert.equal(db.listCampaignActivity(imported.id).at(-1).type, "campaign_imported");
  assert.equal(db.listPlayersByCampaign(campaign.id)[0].characterId, mira.id);
  assert.equal(db.getPlayerState("private-player-hash").inventory[0].quantity, 2);

  const second = db.createSession(campaign.id, "Second night");
  db.activateSession(second.id);
  const playerB = db.submitPlayerRequest(second.id, "Player B", "new-player-hash");
  assert.equal(db.listCharactersByCampaign(campaign.id)[0].archivedAt, archived.archivedAt);
  assert.throws(() => db.approvePlayer(playerB.id, { characterId: mira.id }), /unavailable/);
  db.restoreCharacter(mira.id);
  db.approvePlayer(playerB.id, { characterId: mira.id });
  assert.equal(db.getPlayerState("new-player-hash").inventory[0].quantity, 2);
  assert.equal(db.getPlayerState("new-player-hash").knowledge[0].id, knowledge.id);
  assert.equal(db.listPlayersByCampaign(campaign.id).find((row) => row.id === playerA.id).characterId, mira.id);
  assert.deepEqual(db.listCampaignActivity(campaign.id).filter((event) => event.type.startsWith("character_")).map((event) => event.type), [
    "character_created", "character_assigned", "character_archived", "character_restored", "character_assigned"
  ]);
});

test("profile, personal notes and read marker belong to the character, not an old player", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Story");
  const mira = db.createCharacter(campaign.id, "Mira");
  const other = db.createCharacter(campaign.id, "Nora");
  const item = db.createCatalogItem(campaign.id, "Key");
  const first = db.createSession(campaign.id, "First");
  db.activateSession(first.id);
  const a = db.submitPlayerRequest(first.id, "A", "token-a-hash");
  db.approvePlayer(a.id, { characterId: mira.id });
  db.updateCharacterProfile(mira.id, { name: "Mira", shortDescription: "Explorer", archetype: "Scout", origin: "North", personalGoal: "Find home", dmNotes: "Secret",
    traits: ["Observant", " Careful ", "Observant"], appearance: "Short dark hair", quote: "Keep moving." });
  db.updatePlayerProfile("token-a-hash", { shortDescription: "Explorer of ruins", personalGoal: "Find the map",
    traits: ["Observant", "Careful"], appearance: "A weathered coat", quote: "Not yet." });
  const profileEvent = db.listCampaignActivity(campaign.id).find((event) => event.type === "character_profile_updated");
  assert.deepEqual(Object.keys(profileEvent.details), ["characterName"]);
  assert.equal(JSON.stringify(profileEvent).includes("weathered coat"), false);
  assert.equal(JSON.stringify(profileEvent).includes("Find the map"), false);
  const note = db.createPersonalNote("token-a-hash", "The old door is suspicious.\nCheck the cellar entrance.", {
    title: "Старая дверь", marker: "check", pinned: true
  });
  const noteEvent = db.listCampaignActivity(campaign.id).find((event) => event.type === "personal_note_created");
  assert.deepEqual(noteEvent.details, {});
  assert.equal(JSON.stringify(noteEvent).includes(note.body), false);
  assert.equal(JSON.stringify(noteEvent).includes(note.title), false);
  db.grantInventoryItem(mira.id, item.id, 1);
  const clue = db.createKnowledge(campaign.id, "fact", "Door", "Behind the library");
  db.setKnowledgeVisibility(clue.id, "character", mira.id);
  const firstView = db.getPlayerState("token-a-hash");
  assert.equal(firstView.profile.personalGoal, "Find the map");
  assert.deepEqual(firstView.profile.traits, ["Observant", "Careful"]);
  assert.equal(firstView.profile.appearance, "A weathered coat");
  assert.equal(firstView.profile.quote, "Not yet.");
  assert.equal(firstView.profile.dmNotes, undefined);
  assert.equal(firstView.notes[0].id, note.id);
  assert.deepEqual({ title: firstView.notes[0].title, body: firstView.notes[0].body, marker: firstView.notes[0].marker, pinned: firstView.notes[0].pinned }, {
    title: "Старая дверь", body: note.body, marker: "check", pinned: true
  });
  assert.deepEqual(firstView.newActivity.map((event) => event.kind), ["knowledge_summary_opened", "item_received"]);
  db.markPlayerActivitySeen("token-a-hash", firstView.newActivity[0].id);
  assert.equal(db.getPlayerState("token-a-hash").newActivity.length, 0);
  assert.equal(db.getPlayerState("token-a-hash").inventory.length, 1);
  assert.equal(db.getPlayerState("token-a-hash").knowledge.length, 1);

  db.endSession(first.id);
  assert.throws(() => db.updatePlayerProfile("token-a-hash", { shortDescription: "Stolen", personalGoal: "Stolen" }), /Active character/);
  assert.throws(() => db.createPersonalNote("token-a-hash", "Stolen"), /Active character/);
  assert.throws(() => db.markPlayerActivitySeen("token-a-hash", firstView.newActivity[0].id), /Active character/);
  const oldView = db.getPlayerState("token-a-hash");
  assert.equal(oldView.canEdit, false);
  assert.equal(oldView.profile, null);
  assert.deepEqual(oldView.notes, []);
  assert.deepEqual(oldView.recentActivity, []);
  assert.equal(oldView.inventory.length, 1);

  db.archiveCharacter(mira.id);
  assert.equal(db.listPersonalNotesByCharacter(mira.id)[0].body, note.body);
  assert.equal(db.listCharactersByCampaign(campaign.id).find((row) => row.id === mira.id).personalGoal, "Find the map");
  db.restoreCharacter(mira.id);
  const second = db.createSession(campaign.id, "Second");
  db.activateSession(second.id);
  const b = db.submitPlayerRequest(second.id, "B", "token-b-hash");
  db.approvePlayer(b.id, { characterId: mira.id });
  const c = db.submitPlayerRequest(second.id, "C", "token-c-hash");
  db.approvePlayer(c.id, { characterId: other.id });
  assert.equal(db.getPlayerState("token-b-hash").profile.shortDescription, "Explorer of ruins");
  assert.deepEqual(db.getPlayerState("token-b-hash").profile.traits, ["Observant", "Careful"]);
  assert.equal(db.getPlayerState("token-b-hash").profile.appearance, "A weathered coat");
  assert.equal(db.getPlayerState("token-b-hash").profile.quote, "Not yet.");
  assert.equal(db.getPlayerState("token-b-hash").notes[0].id, note.id);
  assert.equal(db.getPlayerState("token-b-hash").notes[0].title, "Старая дверь");
  assert.equal(db.getPlayerState("token-b-hash").notes[0].pinned, true);
  assert.deepEqual(db.getPlayerState("token-c-hash").notes, []);
  assert.equal(db.getPlayerState("token-c-hash").knowledge.some((entry) => entry.id === clue.id), false);
  assert.throws(() => db.updatePersonalNote("token-c-hash", note.id, "Changed"), /not found/);
  assert.equal(db.getPlayerState("token-b-hash").newActivity.length, 0);
  db.grantInventoryItem(mira.id, item.id, 1);
  assert.deepEqual(db.getPlayerState("token-b-hash").newActivity.map((event) => event.kind), ["item_received"]);

  const exported = db.exportCampaign(campaign.id);
  assert.equal(exported.version, 10);
  assert.deepEqual({ traits: exported.characters[0].traits, appearance: exported.characters[0].appearance, quote: exported.characters[0].quote }, {
    traits: ["Observant", "Careful"], appearance: "A weathered coat", quote: "Not yet."
  });
  assert.equal(exported.personalNotes.length, 1);
  assert.deepEqual({ title: exported.personalNotes[0].title, marker: exported.personalNotes[0].marker, pinned: exported.personalNotes[0].pinned }, {
    title: "Старая дверь", marker: "check", pinned: true
  });
  assert.equal("readState" in exported, false);
  assert.equal(JSON.stringify(exported).includes("token-a-hash"), false);
  const imported = db.importCampaign(exported);
  const importedMira = db.listCharactersByCampaign(imported.id).find((row) => row.name === "Mira");
  assert.deepEqual({ traits: importedMira.traits, appearance: importedMira.appearance, quote: importedMira.quote }, {
    traits: ["Observant", "Careful"], appearance: "A weathered coat", quote: "Not yet."
  });
  assert.equal(importedMira.dmNotes, "Secret");
  assert.equal(importedMira.personalGoal, "Find the map");
  assert.equal(db.listPersonalNotesByCharacter(importedMira.id)[0].body, note.body);
  assert.deepEqual({ title: db.listPersonalNotesByCharacter(importedMira.id)[0].title, marker: db.listPersonalNotesByCharacter(importedMira.id)[0].marker, pinned: db.listPersonalNotesByCharacter(importedMira.id)[0].pinned }, {
    title: "Старая дверь", marker: "check", pinned: true
  });
  const legacyV3 = structuredClone(exported);
  legacyV3.version = 3;
  legacyV3.knowledge[0].category = "note";
  for (const row of legacyV3.personalNotes) for (const key of ["title", "marker", "pinned"]) delete row[key];
  const v3Import = db.importCampaign(legacyV3);
  const v3Mira = db.listCharactersByCampaign(v3Import.id).find((row) => row.name === "Mira");
  assert.deepEqual({ title: db.listPersonalNotesByCharacter(v3Mira.id)[0].title, marker: db.listPersonalNotesByCharacter(v3Mira.id)[0].marker, pinned: db.listPersonalNotesByCharacter(v3Mira.id)[0].pinned }, {
    title: "", marker: "normal", pinned: false
  });
  const legacyExport = structuredClone(exported);
  legacyExport.version = 2;
  legacyExport.knowledge[0].category = "note";
  delete legacyExport.personalNotes;
  for (const character of legacyExport.characters) {
    for (const key of ["shortDescription", "archetype", "origin", "personalGoal", "dmNotes"]) delete character[key];
  }
  const legacyImport = db.importCampaign(legacyExport);
  const legacyMira = db.listCharactersByCampaign(legacyImport.id).find((row) => row.name === "Mira");
  assert.equal(legacyMira.personalGoal, "");
  assert.deepEqual(db.listPersonalNotesByCharacter(legacyMira.id), []);
  assert.equal(db.checkDataHealth().ok, true);
});

test("campaign archive v10 round-trips six categories and rejects unknown categories atomically", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Knowledge taxonomy");
  const mira = db.createCharacter(campaign.id, "Mira");
  const categories = ["character", "place", "creature", "item", "event", "fact"];
  const entries = categories.map((category, index) => db.createKnowledge(campaign.id, category, `Entry ${index}`, `Description ${index}`));
  db.setKnowledgeVisibility(entries[0].id, "character", mira.id);
  db.setKnowledgeVisibility(entries[1].id, "party");
  const archive = db.exportCampaign(campaign.id);
  assert.equal(archive.version, 10);
  assert.deepEqual(archive.knowledge.map(({ category }) => category), categories);

  const imported = db.importCampaign(archive);
  const importedArchive = db.exportCampaign(imported.id);
  assert.deepEqual(importedArchive.knowledge.map(({ category }) => category), categories);
  assert.notEqual(importedArchive.knowledge[0].id, entries[0].id);
  assert.equal(importedArchive.knowledge[0].visibility, "character");
  assert.equal(importedArchive.knowledge[0].visibleToCharacterId, importedArchive.characters[0].id);
  assert.equal(importedArchive.knowledge[1].visibility, "party");
  assert.equal(importedArchive.knowledge[1].visibleToCharacterId, null);

  for (const invalidCategory of ["npc", "unknown"]) {
    const invalid = structuredClone(archive);
    invalid.knowledge[0].category = invalidCategory;
    assert.throws(() => db.importCampaign(invalid), /Campaign file is invalid/);
  }
  const legacyV9 = structuredClone(archive);
  legacyV9.version = 9;
  for (const event of legacyV9.activity) delete event.relatedCharacterId;
  const legacyImported = db.importCampaign(legacyV9);
  assert.equal(db.exportCampaign(legacyImported.id).activity.every((event) => event.relatedCharacterId === null), true);
  assert.equal(db.listCampaigns().length, 3);
});

test("campaign archive v1-v6 deterministically maps every legacy knowledge category", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Legacy taxonomy");
  const mira = db.createCharacter(campaign.id, "Mira");
  const source = db.exportCampaign(campaign.id);
  source.version = 6;
  source.knowledge = ["npc", "monster", "note", "quest"].map((category, index) => ({
    id: `legacy-${index}`, campaignId: campaign.id, category,
    title: `Entry ${index}`, description: `Description ${index}`,
    visibility: index === 1 ? "party" : index === 2 ? "character" : "hidden",
    visibleToCharacterId: index === 2 ? mira.id : null,
    createdAt: "2026-01-01T00:00:00.000Z"
  }));
  const imported = db.importCampaign(source);
  const knowledge = db.exportCampaign(imported.id).knowledge;
  assert.deepEqual(knowledge.map(({ category }) => category), ["character", "creature", "fact", "event"]);
  assert.deepEqual(knowledge.map(({ visibility }) => visibility), ["hidden", "party", "character", "hidden"]);
  assert.equal(knowledge[2].visibleToCharacterId, db.listCharactersByCampaign(imported.id)[0].id);
  assert.equal(new Set(knowledge.map(({ id }) => id)).size, 4);
});

test("backup restores profile, notes and character read marker", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Backup story");
    const mira = db.createCharacter(campaign.id, "Mira");
    const item = db.createCatalogItem(campaign.id, "Key");
    db.updateCatalogItemMetadata(item.id, { description: "A small brass key.", category: "key", rarity: "rare", equipmentSlot: "accessory" });
    const session = db.createSession(campaign.id, "Night");
    db.activateSession(session.id);
    const player = db.submitPlayerRequest(session.id, "A", "backup-player-hash");
    db.approvePlayer(player.id, { characterId: mira.id });
    db.updatePlayerProfile("backup-player-hash", { shortDescription: "Before backup", personalGoal: "Remember",
      traits: ["Patient", "Curious"], appearance: "A blue cloak", quote: "One more question." });
    db.createPersonalNote("backup-player-hash", "Private thought", { title: "Идея", marker: "question", pinned: true });
    const granted = db.grantInventoryItem(mira.id, item.id, 1);
    db.equipInventoryItem(mira.id, granted.id);
    db.updateCharacterInventoryCapacity(mira.id, 4);
    db.markPlayerActivitySeen("backup-player-hash", db.getPlayerState("backup-player-hash").newActivity[0].id);
    const backup = await db.createBackup();
    db.updatePlayerProfile("backup-player-hash", { shortDescription: "After backup", personalGoal: "Changed" });
    db.updateCharacterProfile(mira.id, { name: "Mira", shortDescription: "After backup", archetype: "", origin: "", personalGoal: "Changed", dmNotes: "",
      traits: [], appearance: "", quote: "" });
    db.updateCatalogItemMetadata(item.id, { description: "Changed after backup", rarity: null });
    db.updateCharacterInventoryCapacity(mira.id, 8);
    db.createPersonalNote("backup-player-hash", "Later thought");
    db.grantInventoryItem(mira.id, item.id, 1);
    await db.restoreBackup(backup.id);
    assert.equal(db.getPlayerState("backup-player-hash").profile.shortDescription, "Before backup");
    assert.deepEqual(db.getPlayerState("backup-player-hash").profile.traits, ["Patient", "Curious"]);
    assert.equal(db.getPlayerState("backup-player-hash").profile.appearance, "A blue cloak");
    assert.equal(db.getPlayerState("backup-player-hash").profile.quote, "One more question.");
    assert.deepEqual(db.getPlayerState("backup-player-hash").notes.map((note) => note.body), ["Private thought"]);
    const restoredNote = db.getPlayerState("backup-player-hash").notes[0];
    assert.deepEqual({ title: restoredNote.title, marker: restoredNote.marker, pinned: restoredNote.pinned }, {
      title: "Идея", marker: "question", pinned: true
    });
    assert.equal(db.getPlayerState("backup-player-hash").newActivity.length, 0);
    assert.equal(db.listCharactersByCampaign(campaign.id)[0].inventoryCapacity, 4);
    assert.equal(db.listCatalogItemsByCampaign(campaign.id)[0].description, "A small brass key.");
    assert.equal(db.listCatalogItemsByCampaign(campaign.id)[0].equipmentSlot, "accessory");
    assert.equal(db.listCharacterInventory(mira.id).find(({ equippedSlot }) => equippedSlot !== null).equippedSlot, "accessory");
    assert.equal(db.checkDataHealth().ok, true);
  } finally { db.close(); }
});

test("health check reports cross-campaign knowledge and backup restores activity and archive", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
  const campaign = db.createCampaign("Original");
  const mira = db.createCharacter(campaign.id, "Mira");
  const knowledge = db.createKnowledge(campaign.id, "fact", "Clue", "Old letter");
  db.setKnowledgeVisibility(knowledge.id, "character", mira.id);
  db.archiveCharacter(mira.id);
  assert.equal(db.checkDataHealth().ok, true);
  const backup = await db.createBackup();
  db.restoreCharacter(mira.id);
  const other = db.createCampaign("Other");
  const otherCharacter = db.createCharacter(other.id, "Nora");
  const raw = new SQLite(file);
  try { raw.prepare("UPDATE knowledge_entries SET visible_to_character_id = ? WHERE id = ?").run(otherCharacter.id, knowledge.id); }
  finally { raw.close(); }
  const unhealthy = db.checkDataHealth();
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.checks.find((item) => item.name === "Личные знания").status, "error");
  await db.restoreBackup(backup.id);
  assert.equal(db.checkDataHealth().ok, true);
  assert.ok(db.listCharactersByCampaign(campaign.id)[0].archivedAt);
  assert.equal(db.listKnowledgeByCampaign(campaign.id)[0].visibleToCharacterId, mira.id);
  assert.deepEqual(db.listCampaignActivity(campaign.id).map((event) => event.type).slice(-2), ["character_archived", "backup_restored"]);
  assert.equal(db.listCampaigns().length, 1);
  } finally { db.close(); }
});

test("data health reports invalid personal note title, body, marker and pinned values", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Note health");
    const character = db.createCharacter(campaign.id, "Mira");
    const session = db.createSession(campaign.id, "Check");
    db.activateSession(session.id);
    const player = db.submitPlayerRequest(session.id, "A", "note-health-token");
    db.approvePlayer(player.id, { characterId: character.id });
    const note = db.createPersonalNote("note-health-token", "Valid body");
    const raw = new SQLite(file);
    try {
      raw.pragma("ignore_check_constraints = ON");
      const assertNoteIssue = () => {
        const health = db.checkDataHealth();
        const noteCheck = health.checks.find((check) => check.name === "Личные заметки");
        assert.equal(health.ok, false);
        assert.equal(noteCheck.status, "error");
      };
      raw.prepare("UPDATE character_personal_notes SET title = ? WHERE id = ?").run("x".repeat(121), note.id);
      assertNoteIssue();
      raw.prepare("UPDATE character_personal_notes SET title = '', marker = ? WHERE id = ?").run("invalid", note.id);
      assertNoteIssue();
      raw.prepare("UPDATE character_personal_notes SET marker = 'normal', body = '' WHERE id = ?").run(note.id);
      assertNoteIssue();
      raw.prepare("UPDATE character_personal_notes SET body = 'Valid body', pinned = 2 WHERE id = ?").run(note.id);
      assertNoteIssue();
    } finally { raw.close(); }
  } finally { db.close(); }
});

test("character-assignment migration preserves legacy assignments and inventory", (t) => {
  const file = temporaryFile(t);
  const migrationFolder = mkdtempSync(join(tmpdir(), "progdm-migrations-v4-"));
  t.after(() => {
    assert.equal(dirname(migrationFolder), resolve(tmpdir()));
    rmSync(migrationFolder, { recursive: true, force: true });
  });
  const sourceMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(sourceMigrations, "meta", "_journal.json"), "utf8"));
  const oldEntries = journal.entries.filter((entry) => entry.idx <= 4);
  mkdirSync(join(migrationFolder, "meta"));
  writeFileSync(join(migrationFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
  for (const entry of oldEntries) {
    copyFileSync(join(sourceMigrations, entry.tag + ".sql"), join(migrationFolder, entry.tag + ".sql"));
  }

  mkdirSync(dirname(file), { recursive: true });
  const legacy = new SQLite(file);
  legacy.pragma("foreign_keys = ON");
  migrate(drizzle(legacy), { migrationsFolder: migrationFolder });
  legacy.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000001", "Legacy", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO sessions (id, campaign_id, name, status, join_token, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001", "Old session", "ended", "A".repeat(43), "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO players (id, session_id, display_name, token_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000002", "Player", "legacy-player-hash", "approved", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO players (id, session_id, display_name, token_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000007", "00000000-0000-4000-8000-000000000002", "Unassigned", "unassigned-player-hash", "approved", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO characters (id, campaign_id, name, player_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000001", "Persistent hero", "00000000-0000-4000-8000-000000000003", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO catalog_items (id, campaign_id, name, created_at) VALUES (?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000001", "Old item", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO inventory_items (id, character_id, catalog_item_id, name, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000006", "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005", "Old item", 3, "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO knowledge_entries (id, campaign_id, category, title, description, visibility, visible_to_player_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000008", "00000000-0000-4000-8000-000000000001", "note", "Mira's secret", "Keep this knowledge.", "player", "00000000-0000-4000-8000-000000000003", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO knowledge_entries (id, campaign_id, category, title, description, visibility, visible_to_player_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-000000000001", "note", "Unassigned secret", "Preserve this too.", "player", "00000000-0000-4000-8000-000000000007", "2026-01-01T00:00:00.000Z");
  legacy.close();

  const database = openDatabase({ file });
  try {
    const rawBefore = new SQLite(file);
    assert.deepEqual(rawBefore.prepare("SELECT player_id, session_id, character_id FROM session_character_assignments").all(), [{
      player_id: "00000000-0000-4000-8000-000000000003",
      session_id: "00000000-0000-4000-8000-000000000002",
      character_id: "00000000-0000-4000-8000-000000000004"
    }]);
    rawBefore.close();
    const oldPlayer = database.listPlayersByCampaign("00000000-0000-4000-8000-000000000001")[0];
    assert.equal(oldPlayer.characterId, "00000000-0000-4000-8000-000000000004");
    assert.equal(database.getSession("00000000-0000-4000-8000-000000000002").status, "ended");
    const migratedKnowledge = database.listKnowledgeByCampaign("00000000-0000-4000-8000-000000000001");
    assert.equal(migratedKnowledge.find((entry) => entry.id === "00000000-0000-4000-8000-000000000008").visibility, "character");
    assert.equal(migratedKnowledge.find((entry) => entry.id === "00000000-0000-4000-8000-000000000008").visibleToCharacterId, "00000000-0000-4000-8000-000000000004");
    assert.equal(migratedKnowledge.find((entry) => entry.id === "00000000-0000-4000-8000-000000000009").visibility, "hidden");
    assert.equal(migratedKnowledge.find((entry) => entry.id === "00000000-0000-4000-8000-000000000009").description, "Preserve this too.");
    const oldPlayerState = database.getPlayerState("legacy-player-hash");
    assert.equal(oldPlayerState.characterName, "Persistent hero");
    assert.deepEqual(oldPlayerState.inventory.map(({ name, quantity }) => ({ name, quantity })), [
      { name: "Old item", quantity: 3 }
    ]);
    const raw = new SQLite(file);
    try {
      assert.equal(raw.prepare("SELECT count(*) AS count FROM session_character_assignments").get().count, 1);
      assert.equal(raw.prepare("SELECT count(*) AS count FROM pragma_table_info('characters') WHERE name = 'player_id'").get().count, 0);
      assert.equal(raw.prepare("SELECT count(*) AS count FROM pragma_table_info('knowledge_entries') WHERE name = 'visible_to_player_id'").get().count, 0);
      assert.deepEqual(raw.prepare("SELECT knowledge_entry_id, legacy_player_id, reason FROM knowledge_migration_issues").all(), [{
        knowledge_entry_id: "00000000-0000-4000-8000-000000000009",
        legacy_player_id: "00000000-0000-4000-8000-000000000007",
        reason: "missing_assignment"
      }]);
      assert.deepEqual(raw.pragma("foreign_key_check"), []);
    } finally { raw.close(); }
  } finally { database.close(); }
});

test("database paths do not depend on the shell working directory", () => {
  const expected = new URL("../../../data/game.db", import.meta.url);
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  for (const cwd of [new URL("../../../", import.meta.url), new URL("../../../apps/server/", import.meta.url)]) {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { resolveDatabaseFile } from ${JSON.stringify(moduleUrl)};
      console.log(resolveDatabaseFile("data/game.db"));
    `], { cwd, encoding: "utf8" });
    assert.equal(output.trim(), resolveDatabaseFile("data/game.db"));
  }
  assert.equal(resolveDatabaseFile(":memory:"), ":memory:");
  assert.equal(resolveDatabaseFile("data/game.db"), fileURLToPath(expected));
});

test("names are validated and failed inserts leave no records", (t) => {
  const database = memoryDatabase(t);
  for (const name of ["", " \t\n", "x".repeat(121)]) {
    assert.throws(() => database.createCampaign(name), /Name must contain/);
  }
  const campaign = database.createCampaign("x".repeat(120));
  assert.throws(() => database.createSession(campaign.id, "  "), /Name must contain/);
  assert.deepEqual(database.listSessions(campaign.id), []);
  assert.equal(database.listCampaigns().length, 1);
});

test("sessions belong to existing campaigns and have distinct join tokens", (t) => {
  const database = memoryDatabase(t);
  const first = database.createCampaign("First");
  const second = database.createCampaign("Second");
  assert.throws(() => database.createSession("missing", "Orphan"), (error) =>
    (error.cause ?? error).code === "SQLITE_CONSTRAINT_FOREIGNKEY");
  const a = database.createSession(first.id, "A");
  const b = database.createSession(second.id, "B");
  assert.deepEqual(database.listSessions(first.id), [a]);
  assert.deepEqual(database.listSessions(second.id), [b]);
  assert.notEqual(a.joinToken, b.joinToken);
  assert.match(a.joinToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(database.getCampaign("missing"), null);
  assert.equal(database.getSession("missing"), null);
  assert.equal(database.getCurrentSession(), null);
});

test("switching sessions keeps one active session and rejects invalid transitions", (t) => {
  const database = memoryDatabase(t);
  const first = database.createCampaign("First");
  const second = database.createCampaign("Second");
  const a = database.createSession(first.id, "A");
  const b = database.createSession(second.id, "B");
  assert.throws(() => database.endSession(a.id), /Only an active/);
  const active = database.activateSession(a.id);
  assert.deepEqual(database.activateSession(a.id), active);
  assert.throws(() => database.activateSession("missing"), /not found/);
  assert.equal(database.getCurrentSession().session.id, a.id);
  database.activateSession(b.id);
  assert.equal(database.getSession(a.id).status, "ended");
  assert.equal(database.getCurrentSession().campaign.id, second.id);
  assert.throws(() => database.activateSession(a.id), /ended session/);
  assert.equal(database.getCurrentSession().session.id, b.id);
  const ended = database.endSession(b.id);
  assert.deepEqual(database.endSession(b.id), ended);
  assert.equal(database.getCurrentSession(), null);
});

test("SQLite enforces status, active-session uniqueness and campaign references", (t) => {
  const file = temporaryFile(t);
  const database = openDatabase({ file });
  const raw = new SQLite(file);
  try {
    raw.pragma("foreign_keys = ON");
    assert.equal(raw.pragma("journal_mode", { simple: true }), "wal");
    const campaign = database.createCampaign("Campaign");
    const a = database.createSession(campaign.id, "A");
    const b = database.createSession(campaign.id, "B");
    database.activateSession(a.id);
    assert.throws(() => raw.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(b.id), /UNIQUE/);
    assert.throws(() => raw.prepare("UPDATE sessions SET status = 'unknown' WHERE id = ?").run(b.id), /CHECK/);
    assert.throws(() => raw.prepare("UPDATE sessions SET join_token = ? WHERE id = ?").run(a.joinToken, b.id), /UNIQUE/);
    assert.throws(() => raw.prepare("DELETE FROM campaigns WHERE id = ?").run(campaign.id), /FOREIGN KEY/);
    assert.throws(() => raw.prepare("UPDATE campaigns SET name = '' WHERE id = ?").run(campaign.id), /CHECK/);
    const migrationCount = JSON.parse(readFileSync(join(fileURLToPath(new URL("../migrations/", import.meta.url)), "meta", "_journal.json"), "utf8")).entries.length;
    assert.equal(raw.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, migrationCount);
  } finally {
    raw.close();
    database.close();
  }
});

test("failed activation rolls back the previous active session", (t) => {
  const file = temporaryFile(t);
  const database = openDatabase({ file });
  const raw = new SQLite(file);
  try {
    const campaign = database.createCampaign("Campaign");
    const a = database.createSession(campaign.id, "A");
    const b = database.createSession(campaign.id, "B");
    database.activateSession(a.id);
    raw.exec(`CREATE TRIGGER reject_activation BEFORE UPDATE OF status ON sessions
      WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'test activation failure'); END`);
    assert.throws(() => database.activateSession(b.id));
    assert.equal(database.getCurrentSession().session.id, a.id);
    assert.equal(database.getSession(b.id).status, "planned");
  } finally {
    raw.close();
    database.close();
  }
});

test("campaign export and import preserve history and inventory without copying secrets", (t) => {
  const database = memoryDatabase(t);
  const campaign = database.createCampaign("Campaign to move");
  const character = database.createCharacter(campaign.id, "Mira");
  const item = database.createCatalogItem(campaign.id, "Compass");
  const session = database.createSession(campaign.id, "Night one");
  database.activateSession(session.id);
  const player = database.submitPlayerRequest(session.id, "Player", "a".repeat(64));
  database.approvePlayer(player.id, { characterId: character.id });
  database.grantInventoryItem(character.id, item.id, 2);
  const entry = database.createKnowledge(campaign.id, "character", "Keeper", "Knows the old road.");
  database.setKnowledgeVisibility(entry.id, "character", character.id);

  const archive = database.exportCampaign(campaign.id);
  const serialized = JSON.stringify(archive);
  assert.equal(serialized.includes(session.joinToken), false);
  assert.equal(serialized.includes("a".repeat(64)), false);
  const imported = database.importCampaign(archive);
  assert.notEqual(imported.id, campaign.id);
  const importedArchive = database.exportCampaign(imported.id);
  assert.equal(importedArchive.campaign.name, campaign.name);
  assert.equal(importedArchive.sessions[0].status, "ended");
  assert.throws(() => database.activateSession(importedArchive.sessions[0].id), /ended session/);
  assert.equal(importedArchive.players[0].displayName, "Player");
  assert.equal(importedArchive.assignments.length, 1);
  assert.notEqual(importedArchive.assignments[0].characterId, character.id);
  assert.deepEqual(importedArchive.inventoryItems.map(({ name, quantity }) => ({ name, quantity })), [
    { name: "Compass", quantity: 2 }
  ]);
  assert.equal(importedArchive.knowledge[0].visibility, "character");
  assert.equal(importedArchive.knowledge[0].visibleToCharacterId, importedArchive.characters[0].id);
  assert.notEqual(importedArchive.knowledge[0].visibleToCharacterId, character.id);
  assert.throws(() => database.importCampaign({ ...archive, assignments: [{ ...archive.assignments[0], characterId: "missing" }] }), /invalid reference/);
  assert.equal(database.listCampaigns().length, 2);
});

test("backup restore checks and restores the database and uploaded files with a safety copy", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const uploads = join(root, "uploads");
  const backups = join(root, "backups");
  const assetDirectory = join(uploads, "items");
  mkdirSync(assetDirectory, { recursive: true });
  const asset = join(assetDirectory, "map.bin");
  writeFileSync(asset, "original asset");
  const database = openDatabase({ file, backupsDirectory: backups, uploadsDirectory: uploads });
  const campaign = database.createCampaign("Before restore");
  const snapshot = await database.createBackup();
  assert.equal(database.listBackups().length, 1);
  const backupDatabase = new SQLite(database.backupFile(snapshot.id), { readonly: true });
  assert.equal(backupDatabase.prepare("SELECT name FROM campaigns WHERE id = ?").get(campaign.id).name, "Before restore");
  backupDatabase.close();
  const raw = new SQLite(file);
  raw.prepare("UPDATE campaigns SET name = ? WHERE id = ?").run("After backup", campaign.id);
  raw.close();
  writeFileSync(asset, "changed asset");

  const restored = await database.restoreBackup(snapshot.id);
  const restoredRaw = new SQLite(file, { readonly: true });
  const restoredName = restoredRaw.prepare("SELECT name FROM campaigns WHERE id = ?").get(campaign.id).name;
  restoredRaw.close();
  assert.equal(restoredName, "Before restore");
  assert.equal(database.getCampaign(campaign.id).name, "Before restore");
  assert.equal(readFileSync(asset, "utf8"), "original asset");
  assert.equal(database.listBackups().length, 2);
  assert.notEqual(restored.safetyCopyId, snapshot.id);
  const safetyDatabase = new SQLite(database.backupFile(restored.safetyCopyId), { readonly: true });
  assert.equal(safetyDatabase.prepare("SELECT name FROM campaigns WHERE id = ?").get(campaign.id).name, "After backup");
  safetyDatabase.close();
  assert.throws(() => database.backupFile("..\\game.db"), /Backup not found/);
  database.close();
});

test("restoring a schema 0005 backup applies migration 0006 and preserves campaign data", async (t) => {
  const file = temporaryFile(t);
  const backups = join(dirname(dirname(file)), "backups");
  const uploads = join(dirname(dirname(file)), "uploads");
  const migrationFolder = mkdtempSync(join(tmpdir(), "progdm-migrations-v5-"));
  const backupUuid = "00000000-0000-4000-8000-000000000111";
  const backupName = `progdm-backup-${backupUuid}.db`;
  mkdirSync(backups, { recursive: true });
  mkdirSync(join(backups, `progdm-backup-${backupUuid}-uploads`), { recursive: true });
  t.after(() => {
    assert.equal(dirname(migrationFolder), resolve(tmpdir()));
    rmSync(migrationFolder, { recursive: true, force: true });
  });

  const sourceMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(sourceMigrations, "meta", "_journal.json"), "utf8"));
  const versionFiveEntries = journal.entries.filter((entry) => entry.idx <= 5);
  mkdirSync(join(migrationFolder, "meta"));
  writeFileSync(join(migrationFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: versionFiveEntries }));
  for (const entry of versionFiveEntries) copyFileSync(join(sourceMigrations, entry.tag + ".sql"), join(migrationFolder, entry.tag + ".sql"));

  mkdirSync(dirname(file), { recursive: true });
  const legacy = new SQLite(file);
  legacy.pragma("foreign_keys = ON");
  migrate(drizzle(legacy), { migrationsFolder: migrationFolder });
  legacy.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000101", "Campaign from v5", "2026-02-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO sessions (id, campaign_id, name, status, join_token, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000102", "00000000-0000-4000-8000-000000000101", "Session history", "ended", "J".repeat(43), "2026-02-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO players (id, session_id, display_name, token_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000103", "00000000-0000-4000-8000-000000000102", "Player", "old-player-token-hash", "approved", "2026-02-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO characters (id, campaign_id, name, created_at) VALUES (?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000104", "00000000-0000-4000-8000-000000000101", "Mira", "2026-02-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO session_character_assignments (player_id, session_id, character_id, created_at) VALUES (?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000103", "00000000-0000-4000-8000-000000000102", "00000000-0000-4000-8000-000000000104", "2026-02-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO knowledge_entries (id, campaign_id, category, title, description, visibility, visible_to_player_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("00000000-0000-4000-8000-000000000105", "00000000-0000-4000-8000-000000000101", "note", "Old private clue", "Keep this through restore.", "player", "00000000-0000-4000-8000-000000000103", "2026-02-01T00:00:00.000Z");
  legacy.exec(`CREATE TABLE \`knowledge_migration_issues\` (
    \`knowledge_entry_id\` text NOT NULL,
    \`legacy_player_id\` text NOT NULL,
    \`reason\` text NOT NULL,
    \`created_at\` text NOT NULL,
    FOREIGN KEY (\`knowledge_entry_id\`) REFERENCES \`knowledge_entries\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    CONSTRAINT "knowledge_migration_issue_reason_valid" CHECK(\`reason\` in ('missing_assignment', 'campaign_mismatch'))
  )`);
  await legacy.backup(join(backups, backupName));
  legacy.close();
  const legacyBackup = new SQLite(join(backups, backupName), { readonly: true });
  const legacyTableNames = legacyBackup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  legacyBackup.close();

  const database = openDatabase({ file, backupsDirectory: backups, uploadsDirectory: uploads });
  try {
    const rawAfterStartup = new SQLite(file);
    assert.equal(rawAfterStartup.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, journal.entries.length);
    rawAfterStartup.close();
    assert.equal(database.getCampaign("00000000-0000-4000-8000-000000000101").name, "Campaign from v5");
    database.createCampaign("Change after migration");

    const currentRaw = new SQLite(file, { readonly: true });
    const currentTableNames = currentRaw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
    currentRaw.close();
    assert.deepEqual(legacyTableNames, currentTableNames.filter((name) => !["campaign_activity", "character_personal_notes", "character_read_state", "campaign_profile_field_definitions", "character_profile_field_values", "knowledge_facts", "knowledge_fact_reveals"].includes(name)), "migrations after 0005 add the later activity, profile, read-state and fact tables");

    await database.restoreBackup(backupName);

    assert.deepEqual(database.listCampaigns().map(({ name }) => name), ["Campaign from v5"]);
    assert.equal(database.getSession("00000000-0000-4000-8000-000000000102").status, "ended");
    assert.equal(database.listPlayersByCampaign("00000000-0000-4000-8000-000000000101")[0].characterId, "00000000-0000-4000-8000-000000000104");
    const restoredKnowledge = database.listKnowledgeByCampaign("00000000-0000-4000-8000-000000000101")[0];
    assert.equal(restoredKnowledge.title, "Old private clue");
    assert.equal(restoredKnowledge.description, "Keep this through restore.");
    assert.equal(restoredKnowledge.visibility, "character");
    assert.equal(restoredKnowledge.visibleToCharacterId, "00000000-0000-4000-8000-000000000104");
    assert.equal(database.listCharactersByCampaign("00000000-0000-4000-8000-000000000101")[0].archivedAt, null);
    assert.deepEqual(database.listCampaignActivity("00000000-0000-4000-8000-000000000101").map((event) => event.type), ["backup_restored"]);

    const restoredRaw = new SQLite(file);
    try {
      assert.equal(restoredRaw.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, journal.entries.length);
      assert.equal(restoredRaw.prepare("SELECT count(*) AS count FROM knowledge_migration_issues").get().count, 0);
      assert.deepEqual(restoredRaw.pragma("foreign_key_check"), []);
    } finally { restoredRaw.close(); }

    const originalBackup = new SQLite(join(backups, backupName), { readonly: true });
    assert.equal(originalBackup.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, versionFiveEntries.length);
    assert.equal(originalBackup.prepare("SELECT visibility FROM knowledge_entries").get().visibility, "player");
    originalBackup.close();
  } finally { database.close(); }
});

test("restoring a schema 0008 backup migrates personal note metadata defaults and leaves source untouched", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const backups = join(root, "backups");
  const uploads = join(root, "uploads");
  const oldMigrationFolder = mkdtempSync(join(tmpdir(), "progdm-migrations-v8-"));
  const backupName = "progdm-backup-00000000-0000-4000-8000-000000000222.db";
  mkdirSync(backups, { recursive: true });
  for (const category of ["monsters", "characters", "items"]) {
    mkdirSync(join(backups, "progdm-backup-00000000-0000-4000-8000-000000000222-uploads", category), { recursive: true });
  }
  mkdirSync(dirname(file), { recursive: true });
  t.after(() => {
    assert.equal(dirname(oldMigrationFolder), resolve(tmpdir()));
    rmSync(oldMigrationFolder, { recursive: true, force: true });
  });

  const sourceMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(sourceMigrations, "meta", "_journal.json"), "utf8"));
  const versionEightEntries = journal.entries.filter((entry) => entry.idx <= 8);
  mkdirSync(join(oldMigrationFolder, "meta"));
  writeFileSync(join(oldMigrationFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: versionEightEntries }));
  for (const entry of versionEightEntries) copyFileSync(join(sourceMigrations, entry.tag + ".sql"), join(oldMigrationFolder, entry.tag + ".sql"));

  const legacy = new SQLite(join(root, "legacy-v8.db"));
  try {
    migrate(drizzle(legacy), { migrationsFolder: oldMigrationFolder });
    legacy.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000201", "Old notes", "2026-04-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO characters (id, campaign_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000202", "00000000-0000-4000-8000-000000000201", "Mira", "2026-04-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO character_personal_notes (id, character_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000203", "00000000-0000-4000-8000-000000000202", "The old bridge is unsafe.", "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
    await legacy.backup(join(backups, backupName));
  } finally { legacy.close(); }
  const originalBackupHash = createHash("sha256").update(readFileSync(join(backups, backupName))).digest("hex");

  const database = openDatabase({ file, backupsDirectory: backups, uploadsDirectory: uploads });
  try {
    await database.restoreBackup(backupName);
    const notes = database.listPersonalNotesByCharacter("00000000-0000-4000-8000-000000000202");
    assert.equal(notes.length, 1);
    assert.deepEqual({ title: notes[0].title, body: notes[0].body, marker: notes[0].marker, pinned: notes[0].pinned }, {
      title: "", body: "The old bridge is unsafe.", marker: "normal", pinned: false
    });
    assert.equal(database.checkDataHealth().ok, true, JSON.stringify(database.checkDataHealth()));
    assert.equal(createHash("sha256").update(readFileSync(join(backups, backupName))).digest("hex"), originalBackupHash);
    const original = new SQLite(join(backups, backupName), { readonly: true });
    try {
      assert.equal(original.prepare("PRAGMA table_info(character_personal_notes)").all().some((column) => column.name === "title"), false);
      assert.equal(original.prepare("SELECT body FROM character_personal_notes WHERE id = ?").get("00000000-0000-4000-8000-000000000203").body, "The old bridge is unsafe.");
    } finally { original.close(); }
  } finally { database.close(); }
});

test("character profile validates traits, appearance and quote without losing canonical fields", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Profile rules");
  const character = db.createCharacter(campaign.id, "Mira");
  const updated = db.updateCharacterProfile(character.id, {
    name: "Mira", shortDescription: "Description", archetype: "Scout", origin: "North",
    personalGoal: "Find the pass", dmNotes: "DM only", traits: [" Alert ", "Careful", "Alert"],
    appearance: "A green scarf", quote: "Keep your eyes open."
  });
  assert.deepEqual(updated.traits, ["Alert", "Careful"]);
  assert.equal(updated.appearance, "A green scarf");
  assert.equal(updated.quote, "Keep your eyes open.");
  for (const traits of [[" "], ["x".repeat(41)], Array.from({ length: 9 }, (_, index) => `Trait ${index}`)]) {
    assert.throws(() => db.updateCharacterProfile(character.id, {
      name: "Mira", shortDescription: "", archetype: "", origin: "", personalGoal: "", dmNotes: "", traits
    }), /traits/);
  }
  assert.throws(() => db.updateCharacterProfile(character.id, {
    name: "Mira", shortDescription: "", archetype: "", origin: "", personalGoal: "", dmNotes: "", appearance: "x".repeat(1001)
  }), /too long/);
  assert.throws(() => db.updateCharacterProfile(character.id, {
    name: "Mira", shortDescription: "", archetype: "", origin: "", personalGoal: "", dmNotes: "", quote: "x".repeat(301)
  }), /too long/);
  const persisted = db.listCharactersByCampaign(campaign.id)[0];
  assert.equal(persisted.shortDescription, "Description");
  assert.equal(persisted.personalGoal, "Find the pass");
  assert.equal(persisted.dmNotes, "DM only");
});

test("data health reports invalid character traits JSON, duplicates and profile text limits", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  const campaign = db.createCampaign("Profile health");
  const character = db.createCharacter(campaign.id, "Mira");
  const session = db.createSession(campaign.id, "Health check");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "profile-health-token");
  db.approvePlayer(player.id, { characterId: character.id });
  const raw = new SQLite(file);
  try {
    raw.pragma("ignore_check_constraints = ON");
    const profileCheck = () => {
      const health = db.checkDataHealth();
      assert.equal(health.ok, false);
      assert.equal(health.checks.find((check) => check.name === "Профили персонажей").status, "error");
    };
    raw.prepare("UPDATE characters SET traits = ? WHERE id = ?").run("not json", character.id);
    profileCheck();
    assert.deepEqual(db.getPlayerState("profile-health-token").profile.traits, []);
    assert.throws(() => db.exportCampaign(campaign.id), /Character traits are invalid/);
    raw.prepare("UPDATE characters SET traits = ? WHERE id = ?").run(JSON.stringify(["Same", "Same"]), character.id);
    profileCheck();
    raw.prepare("UPDATE characters SET traits = ?, appearance = ? WHERE id = ?").run("[]", "x".repeat(1001), character.id);
    profileCheck();
    raw.prepare("UPDATE characters SET appearance = '', quote = ? WHERE id = ?").run("x".repeat(301), character.id);
    profileCheck();
  } finally { raw.close(); db.close(); }
});

test("restoring a schema 0010 backup applies campaign profile field migration and leaves source untouched", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const backups = join(root, "backups");
  const uploads = join(root, "uploads");
  const oldMigrationFolder = mkdtempSync(join(tmpdir(), "progdm-migrations-v10-"));
  const backupUuid = "00000000-0000-4000-8000-000000000333";
  const backupName = `progdm-backup-${backupUuid}.db`;
  mkdirSync(backups, { recursive: true });
  for (const category of ["monsters", "characters", "items"]) mkdirSync(join(backups, `progdm-backup-${backupUuid}-uploads`, category), { recursive: true });
  t.after(() => { assert.equal(dirname(oldMigrationFolder), resolve(tmpdir())); rmSync(oldMigrationFolder, { recursive: true, force: true }); });

  const sourceMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(sourceMigrations, "meta", "_journal.json"), "utf8"));
  const versionTenEntries = journal.entries.filter((entry) => entry.idx <= 10);
  mkdirSync(join(oldMigrationFolder, "meta"));
  writeFileSync(join(oldMigrationFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: versionTenEntries }));
  for (const entry of versionTenEntries) copyFileSync(join(sourceMigrations, entry.tag + ".sql"), join(oldMigrationFolder, entry.tag + ".sql"));

  const legacy = new SQLite(join(root, "legacy-v10.db"));
  try {
    migrate(drizzle(legacy), { migrationsFolder: oldMigrationFolder });
    legacy.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000301", "Before profile fields", "2026-05-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO characters (id, campaign_id, name, created_at, short_description, archetype, origin, personal_goal, dm_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000302", "00000000-0000-4000-8000-000000000301", "Mira", "2026-05-01T00:00:00.000Z", "Old description", "Guide", "West", "Find family", "DM note");
    await legacy.backup(join(backups, backupName));
  } finally { legacy.close(); }
  const backupPath = join(backups, backupName);
  const backupHash = createHash("sha256").update(readFileSync(backupPath)).digest("hex");

  const db = openDatabase({ file, backupsDirectory: backups, uploadsDirectory: uploads });
  try {
    await db.restoreBackup(backupName);
    const restored = db.listCharactersByCampaign("00000000-0000-4000-8000-000000000301")[0];
    assert.deepEqual({ traits: restored.traits, appearance: restored.appearance, quote: restored.quote }, { traits: [], appearance: "", quote: "" });
    assert.deepEqual({ shortDescription: restored.shortDescription, archetype: restored.archetype, origin: restored.origin,
      personalGoal: restored.personalGoal, dmNotes: restored.dmNotes }, {
      shortDescription: "Old description", archetype: "Guide", origin: "West", personalGoal: "Find family", dmNotes: "DM note"
    });
    assert.equal(db.checkDataHealth().ok, true);
    assert.equal(createHash("sha256").update(readFileSync(backupPath)).digest("hex"), backupHash);
    const original = new SQLite(backupPath, { readonly: true });
    try {
      assert.equal(original.prepare("PRAGMA table_info(characters)").all().some((column) => column.name === "traits"), true);
      assert.equal(original.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_profile_field_definitions'").get(), undefined);
    }
    finally { original.close(); }
  } finally { db.close(); }
});

test("campaign profile fields validate, order, retain character values, export and remap", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("North Road");
  const otherCampaign = db.createCampaign("Other world");
  const mira = db.createCharacter(campaign.id, "Mira");
  const other = db.createCharacter(campaign.id, "Other");
  const orderField = db.createCampaignProfileField(campaign.id, "Орден");
  const homeField = db.createCampaignProfileField(campaign.id, "Родина");
  const foreignField = db.createCampaignProfileField(otherCampaign.id, "Организация");
  assert.equal(orderField.position, 0);
  assert.equal(homeField.position, 1);
  assert.throws(() => db.createCampaignProfileField(campaign.id, "  "), /label/);
  assert.throws(() => db.createCampaignProfileField(campaign.id, "x".repeat(61)), /label/);
  assert.throws(() => db.updateCharacterProfileFieldValues(mira.id, [{ fieldId: orderField.id, value: "x".repeat(501) }]), /too long/);
  assert.throws(() => db.updateCharacterProfileFieldValues(mira.id, [{ fieldId: foreignField.id, value: "No" }]), /does not belong/);
  assert.throws(() => db.updateCharacterProfileFieldValues("missing", []), /Character not found/);

  db.updateCharacterProfileFieldValues(mira.id, [
    { fieldId: orderField.id, value: " Орден Серого Пламени " }, { fieldId: homeField.id, value: "Вейр" }
  ]);
  assert.deepEqual(db.getCharacterOverview(mira.id).profileFields.map(({ label, value }) => ({ label, value })), [
    { label: "Орден", value: "Орден Серого Пламени" }, { label: "Родина", value: "Вейр" }
  ]);
  db.renameCampaignProfileField(campaign.id, orderField.id, "Орден хранителей");
  assert.deepEqual(db.getCharacterOverview(mira.id).profileFields[0], { id: orderField.id, label: "Орден хранителей", value: "Орден Серого Пламени" });
  db.reorderCampaignProfileFields(campaign.id, [homeField.id, orderField.id]);
  assert.deepEqual(db.listCampaignProfileFields(campaign.id).map(({ id, position }) => [id, position]), [[homeField.id, 0], [orderField.id, 1]]);
  assert.throws(() => db.reorderCampaignProfileFields(campaign.id, [homeField.id, homeField.id]), /order is invalid/);

  const session = db.createSession(campaign.id, "First");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "profile-field-token");
  db.approvePlayer(player.id, { characterId: mira.id });
  assert.deepEqual(db.getPlayerState("profile-field-token").profile.profileFields.map((field) => field.value), ["Вейр", "Орден Серого Пламени"]);
  assert.equal("dmNotes" in db.getPlayerState("profile-field-token").profile, false);
  const otherPlayer = db.submitPlayerRequest(session.id, "C", "other-profile-field-token");
  db.approvePlayer(otherPlayer.id, { characterId: other.id });
  assert.deepEqual(db.getPlayerState("other-profile-field-token").profile.profileFields, []);
  db.endSession(session.id);
  const secondSession = db.createSession(campaign.id, "Second");
  db.activateSession(secondSession.id);
  const newPlayer = db.submitPlayerRequest(secondSession.id, "B", "new-profile-field-token");
  db.approvePlayer(newPlayer.id, { characterId: mira.id });
  assert.deepEqual(db.getPlayerState("new-profile-field-token").profile.profileFields.map((field) => field.value), ["Вейр", "Орден Серого Пламени"]);

  const archive = db.exportCampaign(campaign.id);
  assert.equal(archive.version, 10);
  assert.deepEqual(archive.profileFields.map(({ label, position }) => [label, position]), [["Родина", 0], ["Орден хранителей", 1]]);
  assert.equal(JSON.stringify(archive).includes("profile-field-token"), false);
  const imported = db.importCampaign(archive);
  const importedCharacter = db.listCharactersByCampaign(imported.id)[0];
  const importedFields = db.listCampaignProfileFields(imported.id);
  const importedOverview = db.getCharacterOverview(importedCharacter.id);
  assert.notEqual(importedFields[0].id, archive.profileFields[0].id);
  assert.notEqual(importedCharacter.id, mira.id);
  assert.deepEqual(importedOverview.profileFields.map(({ label, value }) => [label, value]), [
    ["Родина", "Вейр"], ["Орден хранителей", "Орден Серого Пламени"]
  ]);
  assert.equal(db.listCampaignProfileFields(otherCampaign.id)[0].id, foreignField.id);
  assert.equal(db.checkDataHealth().ok, true);
  assert.equal(other.name, "Other");

  const deleted = db.deleteCampaignProfileField(campaign.id, orderField.id);
  assert.equal(deleted.id, orderField.id);
  assert.equal(db.getCharacterOverview(mira.id).profileFields.length, 1);
  assert.equal(db.listCampaignProfileFields(campaign.id)[0].position, 0);
});

test("campaign profile field limit and health diagnostics reject corrupt data", (t) => {
  const root = mkdtempSync(join(tmpdir(), "progdm-profile-health-"));
  const file = join(root, "game.db");
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  t.after(() => { db.close(); assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const campaign = db.createCampaign("Fields");
  const character = db.createCharacter(campaign.id, "Mira");
  const fields = Array.from({ length: 20 }, (_, index) => db.createCampaignProfileField(campaign.id, `Поле ${index + 1}`));
  assert.equal(fields.length, 20);
  assert.throws(() => db.createCampaignProfileField(campaign.id, "Двадцать первое"), /limit reached/);
  db.updateCharacterProfileFieldValues(character.id, [{ fieldId: fields[0].id, value: "Known" }]);
  const raw = new SQLite(db.file);
  try {
    raw.pragma("ignore_check_constraints = ON");
    raw.prepare("UPDATE campaign_profile_field_definitions SET position=40 WHERE id=? AND campaign_id=?").run(fields[0].id, campaign.id);
    raw.pragma("ignore_check_constraints = OFF");
    const health = db.checkDataHealth();
    assert.equal(health.ok, false);
    assert.match(health.checks.find((entry) => entry.name === "Определения полей профиля").message, /порядок/);
  } finally { raw.close(); }
});

test("backup restore preserves campaign profile definitions, values and order", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Backup profile");
    const foreignCampaign = db.createCampaign("Unrelated campaign");
    const character = db.createCharacter(campaign.id, "Mira");
    const first = db.createCampaignProfileField(campaign.id, "Орден");
    const second = db.createCampaignProfileField(campaign.id, "Родина");
    const foreignField = db.createCampaignProfileField(foreignCampaign.id, "Фракция");
    db.reorderCampaignProfileFields(campaign.id, [second.id, first.id]);
    db.updateCharacterProfileFieldValues(character.id, [{ fieldId: first.id, value: "Серое пламя" }, { fieldId: second.id, value: "Вейр" }]);
    const raw = new SQLite(file);
    try {
      raw.pragma("foreign_keys = ON");
      assert.throws(() => raw.prepare("INSERT INTO character_profile_field_values (campaign_id, field_id, character_id, value, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(campaign.id, foreignField.id, character.id, "Cross campaign", new Date().toISOString()), /FOREIGN KEY/);
    } finally { raw.close(); }
    const backup = await db.createBackup();
    const backupBytes = readFileSync(db.backupFile(backup.id));
    db.updateCharacterProfileFieldValues(character.id, [{ fieldId: first.id, value: "Changed" }]);
    await db.restoreBackup(backup.id);
    assert.deepEqual(db.listCampaignProfileFields(campaign.id).map(({ label, position }) => [label, position]), [["Родина", 0], ["Орден", 1]]);
    assert.deepEqual(db.getCharacterOverview(character.id).profileFields.map(({ value }) => value), ["Вейр", "Серое пламя"]);
    assert.deepEqual(readFileSync(db.backupFile(backup.id)), backupBytes);
    assert.equal(db.checkDataHealth().ok, true);
  } finally { db.close(); }
});

test("restoring an 0011 backup maps knowledge categories and preserves dependent references", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const backups = join(root, "backups");
  const uploads = join(root, "uploads");
  const oldMigrationFolder = mkdtempSync(join(tmpdir(), "progdm-migrations-0011-"));
  const backupName = "progdm-backup-00000000-0000-4000-8000-000000000333.db";
  mkdirSync(backups, { recursive: true });
  mkdirSync(join(backups, "progdm-backup-00000000-0000-4000-8000-000000000333-uploads"), { recursive: true });
  for (const category of ["monsters", "characters", "items"]) {
    mkdirSync(join(backups, "progdm-backup-00000000-0000-4000-8000-000000000333-uploads", category), { recursive: true });
  }
  mkdirSync(dirname(file), { recursive: true });
  t.after(() => {
    assert.equal(dirname(oldMigrationFolder), resolve(tmpdir()));
    rmSync(oldMigrationFolder, { recursive: true, force: true });
  });

  const sourceMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(sourceMigrations, "meta", "_journal.json"), "utf8"));
  const versionElevenEntries = journal.entries.filter((entry) => entry.idx <= 11);
  mkdirSync(join(oldMigrationFolder, "meta"));
  writeFileSync(join(oldMigrationFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: versionElevenEntries }));
  for (const entry of versionElevenEntries) copyFileSync(join(sourceMigrations, entry.tag + ".sql"), join(oldMigrationFolder, entry.tag + ".sql"));

  const rows = [
    ["00000000-0000-4000-8000-000000000311", "npc", "character", "character", "00000000-0000-4000-8000-000000000302"],
    ["00000000-0000-4000-8000-000000000312", "monster", "creature", "party", null],
    ["00000000-0000-4000-8000-000000000313", "note", "fact", "hidden", null],
    ["00000000-0000-4000-8000-000000000314", "quest", "event", "party", null]
  ];
  const legacy = new SQLite(file);
  legacy.pragma("foreign_keys = ON");
  try {
    migrate(drizzle(legacy), { migrationsFolder: oldMigrationFolder });
    legacy.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000301", "Legacy categories", "2026-06-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO characters (id, campaign_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000302", "00000000-0000-4000-8000-000000000301", "Mira", "2026-06-01T00:00:00.000Z");
    const insertKnowledge = legacy.prepare(`INSERT INTO knowledge_entries
      (id, campaign_id, category, title, description, visibility, visible_to_character_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [id, oldCategory, , visibility, target] of rows) {
      insertKnowledge.run(id, "00000000-0000-4000-8000-000000000301", oldCategory, `Title ${oldCategory}`,
        `Description ${oldCategory}`, visibility, target, "2026-06-01T00:00:00.000Z");
    }
    legacy.prepare(`INSERT INTO campaign_activity
      (id, campaign_id, knowledge_entry_id, type, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("00000000-0000-4000-8000-000000000321", "00000000-0000-4000-8000-000000000301", rows[0][0],
        "knowledge_created", "2026-06-01T00:00:00.000Z", "{}");
    legacy.prepare(`INSERT INTO knowledge_migration_issues
      (knowledge_entry_id, legacy_player_id, reason, created_at) VALUES (?, ?, ?, ?)`)
      .run(rows[2][0], "legacy-player", "missing_assignment", "2026-06-01T00:00:00.000Z");
    await legacy.backup(join(backups, backupName));
  } finally { legacy.close(); }
  const backupPath = join(backups, backupName);
  const originalHash = createHash("sha256").update(readFileSync(backupPath)).digest("hex");

  const database = openDatabase({ file, backupsDirectory: backups, uploadsDirectory: uploads });
  try {
    await database.restoreBackup(backupName);
    const raw = new SQLite(file, { readonly: true });
    try {
      assert.deepEqual(raw.prepare("SELECT id, category, title, description, visibility, visible_to_character_id, created_at FROM knowledge_entries ORDER BY id")
        .all().map(({ id, category, title, description, visibility, visible_to_character_id, created_at }) =>
          [id, category, title, description, visibility, visible_to_character_id, created_at]),
      rows.map(([id, oldCategory, category, visibility, target]) => [id, category, `Title ${oldCategory}`, `Description ${oldCategory}`, visibility, target, "2026-06-01T00:00:00.000Z"]));
      assert.equal(raw.prepare("SELECT knowledge_entry_id FROM campaign_activity WHERE id=?").get("00000000-0000-4000-8000-000000000321").knowledge_entry_id, rows[0][0]);
      assert.equal(raw.prepare("SELECT knowledge_entry_id FROM knowledge_migration_issues").get().knowledge_entry_id, rows[2][0]);
      assert.deepEqual(raw.pragma("foreign_key_check"), []);
    } finally { raw.close(); }
    assert.equal(database.checkDataHealth().ok, true, JSON.stringify(database.checkDataHealth()));
    assert.equal(createHash("sha256").update(readFileSync(backupPath)).digest("hex"), originalHash);
    const originalBackup = new SQLite(backupPath, { readonly: true });
    try {
      assert.deepEqual(originalBackup.prepare("SELECT category FROM knowledge_entries ORDER BY id").all().map(({ category }) => category),
        ["npc", "monster", "note", "quest"]);
      assert.equal(originalBackup.prepare("SELECT count(*) AS count FROM campaign_activity").get().count, 1);
      assert.equal(originalBackup.prepare("SELECT count(*) AS count FROM knowledge_migration_issues").get().count, 1);
    } finally { originalBackup.close(); }
  } finally { database.close(); }
});

test("restoring a real schema 0012 backup stages migration 0013 and preserves legacy knowledge references", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "progdm-restore-0012-"));
  const currentFile = join(root, "current", "game.db");
  const backups = join(root, "backups");
  const uploads = join(root, "uploads");
  const oldMigrationFolder = mkdtempSync(join(tmpdir(), "progdm-migrations-0012-"));
  const backupUuid = "00000000-0000-4000-8000-000000000444";
  const backupName = `progdm-backup-${backupUuid}.db`;
  const backupPath = join(backups, backupName);
  mkdirSync(backups, { recursive: true });
  for (const directory of ["monsters", "characters", "items"]) {
    mkdirSync(join(backups, `progdm-backup-${backupUuid}-uploads`, directory), { recursive: true });
  }
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
    assert.equal(dirname(oldMigrationFolder), resolve(tmpdir()));
    rmSync(oldMigrationFolder, { recursive: true, force: true });
  });

  const sourceMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(sourceMigrations, "meta", "_journal.json"), "utf8"));
  const schemaTwelveEntries = journal.entries.filter((entry) => entry.idx <= 12);
  mkdirSync(join(oldMigrationFolder, "meta"));
  writeFileSync(join(oldMigrationFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: schemaTwelveEntries }));
  for (const entry of schemaTwelveEntries) copyFileSync(join(sourceMigrations, entry.tag + ".sql"), join(oldMigrationFolder, entry.tag + ".sql"));

  const legacyPath = join(root, "schema-0012.db");
  const legacy = new SQLite(legacyPath);
  legacy.pragma("foreign_keys = ON");
  try {
    migrate(drizzle(legacy), { migrationsFolder: oldMigrationFolder });
    const campaignId = "00000000-0000-4000-8000-000000000401";
    const sessionId = "00000000-0000-4000-8000-000000000402";
    const characterId = "00000000-0000-4000-8000-000000000403";
    legacy.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)")
      .run(campaignId, "Schema 0012", "2026-08-01T00:00:00.000Z");
    legacy.prepare(`INSERT INTO sessions (id, campaign_id, name, status, join_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, campaignId, "Historical", "ended", "S".repeat(43), "2026-08-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO characters (id, campaign_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run(characterId, campaignId, "Mira", "2026-08-01T00:00:00.000Z");
    const entries = [
      ["00000000-0000-4000-8000-000000000411", "character", "Hidden", "Hidden summary.", "hidden", null],
      ["00000000-0000-4000-8000-000000000412", "place", "Party", "Party summary.", "party", null],
      ["00000000-0000-4000-8000-000000000413", "creature", "Character", "Character summary.", "character", characterId]
    ];
    const insertEntry = legacy.prepare(`INSERT INTO knowledge_entries
      (id, campaign_id, category, title, description, visibility, visible_to_character_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [id, category, title, description, visibility, target] of entries) {
      insertEntry.run(id, campaignId, category, title, description, visibility, target, "2026-08-01T00:00:00.000Z");
    }
    legacy.prepare(`INSERT INTO campaign_activity
      (id, campaign_id, session_id, knowledge_entry_id, type, created_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("00000000-0000-4000-8000-000000000421", campaignId, sessionId, entries[2][0], "knowledge_created", "2026-08-01T00:00:00.000Z", "{}");
    legacy.prepare(`INSERT INTO knowledge_migration_issues
      (knowledge_entry_id, legacy_player_id, reason, created_at) VALUES (?, ?, ?, ?)`)
      .run(entries[0][0], "legacy-player-reference", "missing_assignment", "2026-08-01T00:00:00.000Z");
    await legacy.backup(backupPath);
  } finally { legacy.close(); }
  const originalHash = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
  const oldBackup = new SQLite(backupPath, { readonly: true });
  try {
    assert.equal(oldBackup.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, 13);
    assert.equal(oldBackup.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_facts'").get(), undefined);
  } finally { oldBackup.close(); }

  const database = openDatabase({ file: currentFile, backupsDirectory: backups, uploadsDirectory: uploads });
  try {
    await database.restoreBackup(backupName);
    const raw = new SQLite(currentFile, { readonly: true });
    try {
      assert.deepEqual(raw.prepare(`SELECT id, category, title, description, visibility, visible_to_character_id
        FROM knowledge_entries ORDER BY id`).all().map(({ id, category, title, description, visibility, visible_to_character_id }) =>
        [id, category, title, description, visibility, visible_to_character_id]), entriesFixtureForRestore0012());
      assert.equal(raw.prepare("SELECT knowledge_entry_id FROM campaign_activity WHERE id=?").get("00000000-0000-4000-8000-000000000421").knowledge_entry_id,
        "00000000-0000-4000-8000-000000000413");
      assert.equal(raw.prepare("SELECT knowledge_entry_id FROM knowledge_migration_issues").get().knowledge_entry_id,
        "00000000-0000-4000-8000-000000000411");
      assert.equal(raw.prepare("SELECT count(*) AS count FROM knowledge_facts").get().count, 0);
      assert.equal(raw.prepare("SELECT count(*) AS count FROM knowledge_fact_reveals").get().count, 0);
      assert.equal(raw.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, 16);
      assert.deepEqual(raw.pragma("foreign_key_check"), []);
    } finally { raw.close(); }
    assert.equal(database.checkDataHealth().ok, true, JSON.stringify(database.checkDataHealth()));
    assert.equal(createHash("sha256").update(readFileSync(backupPath)).digest("hex"), originalHash);
    const unchangedBackup = new SQLite(backupPath, { readonly: true });
    try { assert.equal(unchangedBackup.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, 13); }
    finally { unchangedBackup.close(); }
  } finally { database.close(); }
});

function entriesFixtureForRestore0012() {
  return [
    ["00000000-0000-4000-8000-000000000411", "character", "Hidden", "Hidden summary.", "hidden", null],
    ["00000000-0000-4000-8000-000000000412", "place", "Party", "Party summary.", "party", null],
    ["00000000-0000-4000-8000-000000000413", "creature", "Character", "Character summary.", "character", "00000000-0000-4000-8000-000000000403"]
  ];
}

test("Data Health reports a legacy knowledge category without repairing it", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Invalid category");
    const entry = db.createKnowledge(campaign.id, "fact", "Clue", "Description");
    const raw = new SQLite(db.file);
    try {
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare("UPDATE knowledge_entries SET category='note' WHERE id=?").run(entry.id);
      raw.pragma("ignore_check_constraints = OFF");
      const health = db.checkDataHealth();
      assert.equal(health.ok, false);
      assert.match(health.checks.find(({ name }) => name === "Категории знаний").message, /несогласованных записей/);
      assert.equal(raw.prepare("SELECT category FROM knowledge_entries WHERE id=?").get(entry.id).category, "note");
    } finally { raw.close(); }
  } finally { db.close(); }
});

test("knowledge Facts have independent party and Character grants, stable next reveal, and correction semantics", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Facts campaign");
  const otherCampaign = db.createCampaign("Other campaign");
  const mira = db.createCharacter(campaign.id, "Mira");
  const rowan = db.createCharacter(campaign.id, "Rowan");
  const foreignCharacter = db.createCharacter(otherCampaign.id, "Nora");
  const archived = db.createCharacter(campaign.id, "Archived");
  db.archiveCharacter(archived.id);
  const session = db.createSession(campaign.id, "First session");
  db.activateSession(session.id);
  const entry = db.createKnowledge(campaign.id, "character", "Apothecary", "Summary remains hidden.");
  const first = db.createKnowledgeFact(campaign.id, entry.id, "  The apothecary wears a silver ring.  ");
  const second = db.createKnowledgeFact(campaign.id, entry.id, "The ring bears a northern seal.");
  assert.equal(first.body, "The apothecary wears a silver ring.");
  assert.throws(() => db.createKnowledgeFact(campaign.id, entry.id, " \n "), /between 1 and 2000/);
  assert.throws(() => db.createKnowledgeFact(campaign.id, entry.id, "x".repeat(2001)), /between 1 and 2000/);
  assert.throws(() => db.createKnowledgeFact(campaign.id, db.createKnowledge(otherCampaign.id, "fact", "Foreign", "Summary").id, "Cross campaign"), /not in this campaign/);
  assert.deepEqual(db.listKnowledgeFacts(campaign.id, entry.id).map(({ position, body }) => [position, body]), [
    [0, first.body], [1, second.body]
  ]);
  assert.deepEqual(db.reorderKnowledgeFacts(campaign.id, entry.id, [second.id, first.id]).map(({ id, position }) => [id, position]), [
    [second.id, 0], [first.id, 1]
  ]);
  assert.throws(() => db.reorderKnowledgeFacts(campaign.id, entry.id, [first.id, first.id]), /order is invalid/);
  assert.throws(() => db.revealKnowledgeFactToCharacter(campaign.id, entry.id, first.id, foreignCharacter.id), /not in this campaign/);
  assert.throws(() => db.revealKnowledgeFactToCharacter(campaign.id, entry.id, first.id, archived.id), /Archived characters/);

  const party = db.revealKnowledgeFactToParty(campaign.id, entry.id, second.id);
  assert.equal(party.created, true);
  assert.equal(party.reveal.sessionId, session.id);
  assert.equal(db.revealKnowledgeFactToParty(campaign.id, entry.id, second.id).created, false);
  assert.equal(db.revealKnowledgeFactToCharacter(campaign.id, entry.id, second.id, mira.id).created, true);
  assert.equal(db.revealKnowledgeFactToCharacter(campaign.id, entry.id, second.id, rowan.id).created, true);
  const beforeNext = db.listCampaignActivity(campaign.id).length;
  const nextParty = db.revealNextKnowledgeFact(campaign.id, entry.id, "party", undefined, "next-party-once");
  assert.equal(nextParty.fact.id, first.id);
  assert.equal(nextParty.reveal.sessionId, session.id);
  assert.equal(db.revealNextKnowledgeFact(campaign.id, entry.id, "party", undefined, "next-party-once").fact.id, first.id);
  assert.equal(db.listCampaignActivity(campaign.id).length, beforeNext + 1);
  assert.throws(() => db.revealNextKnowledgeFact(campaign.id, entry.id, "character", mira.id, "next-party-once"), /operation ID was already used/);
  const currentReveals = db.listKnowledgeFactReveals(campaign.id, entry.id);
  assert.equal(currentReveals.some((reveal) => reveal.audience === "party" && reveal.knowledgeFactId === first.id), true);
  assert.equal(currentReveals.every((reveal) => !("operationId" in reveal)), true);
  assert.throws(() => db.listKnowledgeFactReveals(otherCampaign.id, entry.id), /not in this campaign/);
  const beforeMiraNext = db.listCampaignActivity(campaign.id).length;
  const nextMira = db.revealNextKnowledgeFact(campaign.id, entry.id, "character", mira.id, "next-mira-once");
  assert.equal(nextMira.fact.id, first.id);
  assert.equal(nextMira.reveal.characterId, mira.id);
  assert.equal(db.revealNextKnowledgeFact(campaign.id, entry.id, "character", mira.id, "next-mira-once").fact.id, first.id);
  assert.equal(db.listCampaignActivity(campaign.id).length, beforeMiraNext + 1);
  assert.equal(db.revealNextKnowledgeFact(campaign.id, entry.id, "party", undefined, "next-party-empty"), null);

  const third = db.createKnowledgeFact(campaign.id, entry.id, "A third fact arrives before reveal-all.");
  const activityBeforeAll = db.listCampaignActivity(campaign.id).length;
  const allParty = db.revealAllKnowledgeFacts(campaign.id, entry.id, "party");
  assert.equal(allParty.createdCount, 1);
  assert.equal(allParty.reveals.some((reveal) => reveal.knowledgeFactId === third.id), true);
  assert.equal(db.revealAllKnowledgeFacts(campaign.id, entry.id, "party").createdCount, 0);
  const allMira = db.revealAllKnowledgeFacts(campaign.id, entry.id, "character", mira.id);
  assert.equal(allMira.createdCount, 1);
  assert.equal(db.revealAllKnowledgeFacts(campaign.id, entry.id, "character", mira.id).createdCount, 0);
  assert.equal(db.listCampaignActivity(campaign.id).length, activityBeforeAll + 2);
  const later = db.createKnowledgeFact(campaign.id, entry.id, "A later fact stays unrevealed.");
  assert.equal(db.exportCampaign(campaign.id).knowledgeFactReveals.some((reveal) => reveal.knowledgeFactId === later.id), false);
  const summary = db.listKnowledgeByCampaign(campaign.id).find(({ id }) => id === entry.id);
  assert.equal(summary.visibility, "hidden");
  assert.equal(summary.visibleToCharacterId, null);

  const eventRows = db.listCampaignActivity(campaign.id).filter(({ type }) =>
    type === "knowledge_fact_revealed" || type === "knowledge_fact_access_revoked");
  assert.equal(eventRows.every(({ details }) => !("body" in details) && !("factIds" in details)), true);
  assert.equal(JSON.stringify(eventRows).includes(first.body), false);
  const historyBeforeRevoke = eventRows.map((event) => event.id);
  assert.equal(db.revokeKnowledgeFactReveal(campaign.id, entry.id, second.id, "party"), true);
  const afterRevoke = db.listCampaignActivity(campaign.id).filter(({ type }) =>
    type === "knowledge_fact_revealed" || type === "knowledge_fact_access_revoked");
  assert.equal(db.revokeKnowledgeFactReveal(campaign.id, entry.id, second.id, "party"), false);
  assert.deepEqual(db.listCampaignActivity(campaign.id).filter(({ id }) => historyBeforeRevoke.includes(id)).map(({ id }) => id), historyBeforeRevoke);
  assert.equal(afterRevoke.filter(({ type }) => type === "knowledge_fact_access_revoked").length, 1);

  db.endSession(session.id);
  const withoutSession = db.createKnowledgeFact(campaign.id, entry.id, "Found between sessions.");
  const noSession = db.revealKnowledgeFactToCharacter(campaign.id, entry.id, withoutSession.id, mira.id);
  assert.equal(noSession.reveal.sessionId, null);
});

test("Player Knowledge projection exposes only permitted summaries and deduplicated revealed facts", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Projection campaign");
  const mira = db.createCharacter(campaign.id, "Mira");
  const rowan = db.createCharacter(campaign.id, "Rowan");
  const future = db.createCharacter(campaign.id, "Future character");
  const firstSession = db.createSession(campaign.id, "Session One");
  db.activateSession(firstSession.id);
  const miraOld = db.submitPlayerRequest(firstSession.id, "Mira old", "mira-old-hash");
  db.approvePlayer(miraOld.id, { characterId: mira.id });
  const rowanOld = db.submitPlayerRequest(firstSession.id, "Rowan old", "rowan-old-hash");
  db.approvePlayer(rowanOld.id, { characterId: rowan.id });
  const pending = db.submitPlayerRequest(firstSession.id, "Pending", "pending-hash");
  const rejected = db.submitPlayerRequest(firstSession.id, "Rejected", "rejected-hash");
  db.rejectPlayer(rejected.id);

  const partySummary = db.createKnowledge(campaign.id, "place", "Known square", "A summary available to the party.");
  db.setKnowledgeVisibility(partySummary.id, "party");
  const miraSummary = db.createKnowledge(campaign.id, "character", "Mira contact", "Mira-only summary.");
  db.setKnowledgeVisibility(miraSummary.id, "character", mira.id);
  const rowanSummary = db.createKnowledge(campaign.id, "character", "Rowan contact", "ROWAN_SUMMARY_SECRET");
  db.setKnowledgeVisibility(rowanSummary.id, "character", rowan.id);
  const hiddenWithoutGrants = db.createKnowledge(campaign.id, "fact", "Unopened record", "HIDDEN_SUMMARY_WITHOUT_GRANTS");
  const partyFactEntry = db.createKnowledge(campaign.id, "event", "Shared discovery", "HIDDEN_PARTY_FACT_SUMMARY");
  const sharedFact = db.createKnowledgeFact(campaign.id, partyFactEntry.id, "PARTY_FACT_VISIBLE");
  const unrevealedPartyFact = db.createKnowledgeFact(campaign.id, partyFactEntry.id, "UNREVEALED_PARTY_FACT_SECRET");
  const characterFactEntry = db.createKnowledge(campaign.id, "creature", "Mira's clue", "HIDDEN_CHARACTER_FACT_SUMMARY");
  const miraFact = db.createKnowledgeFact(campaign.id, characterFactEntry.id, "MIRA_FACT_VISIBLE");
  const rowanFact = db.createKnowledgeFact(campaign.id, characterFactEntry.id, "ROWAN_FACT_SECRET");
  const sharedAndPersonalEntry = db.createKnowledge(campaign.id, "item", "Two paths to one fact", "DOUBLE_GRANT_SUMMARY_SECRET");
  const doubleFact = db.createKnowledgeFact(campaign.id, sharedAndPersonalEntry.id, "DOUBLE_GRANT_FACT");

  db.revealKnowledgeFactToParty(campaign.id, partyFactEntry.id, sharedFact.id);
  db.revealKnowledgeFactToCharacter(campaign.id, characterFactEntry.id, miraFact.id, mira.id);
  db.revealKnowledgeFactToCharacter(campaign.id, characterFactEntry.id, rowanFact.id, rowan.id);
  const firstPartyGrant = db.revealKnowledgeFactToParty(campaign.id, sharedAndPersonalEntry.id, doubleFact.id);
  assert.equal(firstPartyGrant.reveal.sessionId, firstSession.id);

  const miraState = db.getPlayerState("mira-old-hash");
  const miraKnowledge = new Map(miraState.knowledge.map((entry) => [entry.id, entry]));
  assert.equal(miraState.recentActivity.some((event) => event.kind === "knowledge_facts_revealed"), true);
  assert.deepEqual(miraKnowledge.get(partySummary.id), {
    id: partySummary.id, category: "place", title: "Known square", summary: "A summary available to the party.", summaryVisible: true, facts: []
  });
  assert.equal(miraKnowledge.get(miraSummary.id).summary, "Mira-only summary.");
  assert.equal(miraKnowledge.has(rowanSummary.id), false);
  assert.equal(miraKnowledge.has(hiddenWithoutGrants.id), false);
  assert.equal(miraKnowledge.get(partyFactEntry.id).summary, null);
  assert.equal(miraKnowledge.get(partyFactEntry.id).summaryVisible, false);
  assert.deepEqual(miraKnowledge.get(partyFactEntry.id).facts.map((fact) => fact.body), ["PARTY_FACT_VISIBLE"]);
  assert.deepEqual(miraKnowledge.get(characterFactEntry.id).facts.map((fact) => fact.body), ["MIRA_FACT_VISIBLE"]);
  assert.deepEqual(miraKnowledge.get(sharedAndPersonalEntry.id).facts.map((fact) => fact.id), [doubleFact.id]);
  const firstMetadata = miraKnowledge.get(sharedAndPersonalEntry.id).facts[0];
  assert.equal(firstMetadata.sessionId, firstSession.id);
  assert.equal(firstMetadata.sessionName, "Session One");
  assert.equal(firstMetadata.revealedAt, firstPartyGrant.reveal.createdAt);
  assert.equal(miraState.knowledge.some((entry) => entry.facts.some((fact) => fact.id === unrevealedPartyFact.id)), false);
  const serializedMira = JSON.stringify(miraState);
  for (const secret of ["ROWAN_SUMMARY_SECRET", "HIDDEN_SUMMARY_WITHOUT_GRANTS", "HIDDEN_PARTY_FACT_SUMMARY",
    "HIDDEN_CHARACTER_FACT_SUMMARY", "DOUBLE_GRANT_SUMMARY_SECRET", "UNREVEALED_PARTY_FACT_SECRET", "ROWAN_FACT_SECRET"]) {
    assert.equal(serializedMira.includes(secret), false, `PlayerState leaked ${secret}`);
  }
  for (const internal of ["audience", "operationId", "visibleToCharacterId", "visibility"]) {
    assert.equal(JSON.stringify(miraState.knowledge).includes(`\"${internal}\"`), false, `Knowledge projection leaked ${internal}`);
  }
  for (const internal of ["audience", "characterId", "operationId"]) {
    assert.equal(JSON.stringify(miraState.knowledge).includes(`\"${internal}\"`), false, `Knowledge projection leaked ${internal}`);
  }
  assert.equal(JSON.stringify(miraKnowledge.get(partyFactEntry.id)).includes("HIDDEN_PARTY_FACT_SUMMARY"), false);

  const rowanState = db.getPlayerState("rowan-old-hash");
  const rowanKnowledge = new Map(rowanState.knowledge.map((entry) => [entry.id, entry]));
  assert.deepEqual(rowanKnowledge.get(partyFactEntry.id).facts.map((fact) => fact.id), [sharedFact.id]);
  assert.deepEqual(rowanKnowledge.get(characterFactEntry.id).facts.map((fact) => fact.body), ["ROWAN_FACT_SECRET"]);
  assert.equal(rowanKnowledge.get(sharedAndPersonalEntry.id).facts.length, 1);
  assert.deepEqual(db.getPlayerState("pending-hash").knowledge, []);
  assert.deepEqual(db.getPlayerState("rejected-hash").knowledge, []);

  db.endSession(firstSession.id);
  const historical = db.getPlayerState("mira-old-hash");
  assert.equal(historical.canEdit, false);
  assert.equal(historical.knowledge.some((entry) => entry.facts.some((fact) => fact.id === miraFact.id)), true);
  assert.equal(historical.knowledge.some((entry) => entry.facts.some((fact) => fact.id === rowanFact.id)), false);

  const secondSession = db.createSession(campaign.id, "Session Two");
  db.activateSession(secondSession.id);
  const miraNew = db.submitPlayerRequest(secondSession.id, "Mira new", "mira-new-hash");
  db.approvePlayer(miraNew.id, { characterId: mira.id });
  const futurePlayer = db.submitPlayerRequest(secondSession.id, "Future player", "future-player-hash");
  db.approvePlayer(futurePlayer.id, { characterId: future.id });
  const personalDuplicate = db.revealKnowledgeFactToCharacter(campaign.id, sharedAndPersonalEntry.id, doubleFact.id, mira.id);
  assert.equal(personalDuplicate.reveal.sessionId, secondSession.id);
  const miraNewState = db.getPlayerState("mira-new-hash");
  const deduplicatedFact = miraNewState.knowledge.find((entry) => entry.id === sharedAndPersonalEntry.id).facts;
  assert.equal(deduplicatedFact.length, 1);
  const earliestGrant = [firstPartyGrant.reveal, personalDuplicate.reveal]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
  const expectedSessionName = earliestGrant.sessionId === firstSession.id ? "Session One" : "Session Two";
  assert.equal(deduplicatedFact[0].revealedAt, earliestGrant.createdAt);
  assert.equal(deduplicatedFact[0].sessionId, earliestGrant.sessionId);
  assert.equal(deduplicatedFact[0].sessionName, expectedSessionName);
  const futureState = db.getPlayerState("future-player-hash");
  assert.equal(futureState.knowledge.find((entry) => entry.id === partyFactEntry.id).facts[0].body, "PARTY_FACT_VISIBLE");
  assert.equal(futureState.knowledge.some((entry) => entry.facts.some((fact) => fact.id === miraFact.id)), false);
  assert.equal(futureState.knowledge.find((entry) => entry.id === sharedAndPersonalEntry.id).facts[0].id, doubleFact.id);

  assert.equal(db.revokeKnowledgeFactReveal(campaign.id, sharedAndPersonalEntry.id, doubleFact.id, "character", mira.id), true);
  assert.equal(db.getPlayerState("mira-new-hash").knowledge.find((entry) => entry.id === sharedAndPersonalEntry.id).facts.length, 1);
  assert.equal(db.revokeKnowledgeFactReveal(campaign.id, sharedAndPersonalEntry.id, doubleFact.id, "party"), true);
  assert.equal(db.getPlayerState("mira-new-hash").knowledge.some((entry) => entry.id === sharedAndPersonalEntry.id), false);

  db.endSession(secondSession.id);
  const outsideSessionEntry = db.createKnowledge(campaign.id, "fact", "Between sessions", "OUTSIDE_SESSION_SUMMARY_SECRET");
  const outsideSessionFact = db.createKnowledgeFact(campaign.id, outsideSessionEntry.id, "OUTSIDE_SESSION_FACT");
  const outsideReveal = db.revealKnowledgeFactToCharacter(campaign.id, outsideSessionEntry.id, outsideSessionFact.id, mira.id);
  assert.equal(outsideReveal.reveal.sessionId, null);
  const outsideProjection = db.getPlayerState("mira-new-hash").knowledge.find((entry) => entry.id === outsideSessionEntry.id);
  assert.equal(outsideProjection.summary, null);
  assert.equal(outsideProjection.facts[0].sessionId, null);
  assert.equal(outsideProjection.facts[0].sessionName, null);
  assert.equal(outsideProjection.facts[0].body, "OUTSIDE_SESSION_FACT");
});

test("Player activity projection is safe, audience-scoped, and uses the existing read marker", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Activity projection");
  const mira = db.createCharacter(campaign.id, "Mira");
  const rowan = db.createCharacter(campaign.id, "Rowan");
  const session = db.createSession(campaign.id, "Active chapter");
  db.activateSession(session.id);
  const miraPlayer = db.submitPlayerRequest(session.id, "Mira player", "activity-mira-hash");
  db.approvePlayer(miraPlayer.id, { characterId: mira.id });
  const rowanPlayer = db.submitPlayerRequest(session.id, "Rowan player", "activity-rowan-hash");
  db.approvePlayer(rowanPlayer.id, { characterId: rowan.id });
  db.submitPlayerRequest(session.id, "Waiting", "activity-pending-hash");
  const rejected = db.submitPlayerRequest(session.id, "Declined", "activity-rejected-hash");
  db.rejectPlayer(rejected.id);

  const item = db.createCatalogItem(campaign.id, "Old key");
  db.grantInventoryItem(mira.id, item.id, 2);
  const sharedSummary = db.createKnowledge(campaign.id, "place", "Shared place", "Shared short summary.");
  db.setKnowledgeVisibility(sharedSummary.id, "party");
  const miraSummary = db.createKnowledge(campaign.id, "character", "Mira's contact", "Mira-only short summary.");
  db.setKnowledgeVisibility(miraSummary.id, "character", mira.id);
  db.setKnowledgeVisibility(miraSummary.id, "party");
  const rowanSummary = db.createKnowledge(campaign.id, "character", "Rowan's contact", "ROWAN_ONLY_SUMMARY_SECRET");
  db.setKnowledgeVisibility(rowanSummary.id, "character", rowan.id);

  const sharedEntry = db.createKnowledge(campaign.id, "event", "Shared discovery", "SHARED_HIDDEN_SUMMARY");
  const sharedFact = db.createKnowledgeFact(campaign.id, sharedEntry.id, "SHARED_FACT_BODY");
  db.revealKnowledgeFactToParty(campaign.id, sharedEntry.id, sharedFact.id);
  const miraEntry = db.createKnowledge(campaign.id, "fact", "Mira's clue", "MIRA_HIDDEN_SUMMARY");
  const miraFact = db.createKnowledgeFact(campaign.id, miraEntry.id, "MIRA_FACT_BODY_SECRET");
  const miraOtherFact = db.createKnowledgeFact(campaign.id, miraEntry.id, "MIRA_OTHER_FACT_BODY_SECRET");
  db.revealKnowledgeFactToCharacter(campaign.id, miraEntry.id, miraFact.id, mira.id);
  db.revealKnowledgeFactToCharacter(campaign.id, miraEntry.id, miraOtherFact.id, mira.id);
  db.revokeKnowledgeFactReveal(campaign.id, miraEntry.id, miraFact.id, "character", mira.id);
  const rowanEntry = db.createKnowledge(campaign.id, "creature", "Rowan's secret", "ROWAN_FACT_SUMMARY_SECRET");
  const rowanFact = db.createKnowledgeFact(campaign.id, rowanEntry.id, "ROWAN_FACT_BODY_SECRET");
  db.revealKnowledgeFactToCharacter(campaign.id, rowanEntry.id, rowanFact.id, rowan.id);
  const revokedEntry = db.createKnowledge(campaign.id, "fact", "Revoked secret title", "REVOKED_HIDDEN_SUMMARY");
  const revokedFact = db.createKnowledgeFact(campaign.id, revokedEntry.id, "REVOKED_FACT_BODY_SECRET");
  db.revealKnowledgeFactToCharacter(campaign.id, revokedEntry.id, revokedFact.id, mira.id);
  db.revokeKnowledgeFactReveal(campaign.id, revokedEntry.id, revokedFact.id, "character", mira.id);

  const state = db.getPlayerState("activity-mira-hash");
  const hasEvent = (events, kind, entryId) => events.some((event) => event.kind === kind && event.knowledgeEntryId === entryId);
  assert.ok(state.recentActivity.some((event) => event.kind === "item_received" && event.itemName === "Old key" && event.quantity === 2));
  assert.ok(hasEvent(state.recentActivity, "knowledge_summary_opened", sharedSummary.id));
  assert.ok(hasEvent(state.recentActivity, "knowledge_summary_opened", miraSummary.id));
  assert.equal(hasEvent(state.recentActivity, "knowledge_summary_opened", rowanSummary.id), false);
  assert.ok(state.recentActivity.filter((event) => event.kind === "knowledge_summary_opened").every((event) => event.sessionName === "Active chapter"));
  const sharedFactEvent = state.recentActivity.find((event) => event.kind === "knowledge_facts_revealed" && event.knowledgeEntryId === sharedEntry.id);
  assert.ok(sharedFactEvent);
  assert.equal(sharedFactEvent.sessionId, session.id);
  assert.equal(sharedFactEvent.sessionName, "Active chapter");
  assert.ok(hasEvent(state.recentActivity, "knowledge_facts_revealed", miraEntry.id));
  assert.deepEqual(state.knowledge.find((entry) => entry.id === miraEntry.id).facts.map((fact) => fact.id), [miraOtherFact.id],
    "an entry remains safe when another Fact grant survives a revoke");
  assert.equal(hasEvent(state.recentActivity, "knowledge_facts_revealed", rowanEntry.id), false);
  assert.equal(hasEvent(state.recentActivity, "knowledge_facts_revealed", revokedEntry.id), false);
  assert.equal(state.knowledge.some((entry) => entry.id === revokedEntry.id), false);

  const serializedActivity = JSON.stringify({ recentActivity: state.recentActivity, newActivity: state.newActivity });
  for (const secret of ["SHARED_HIDDEN_SUMMARY", "MIRA_HIDDEN_SUMMARY", "MIRA_FACT_BODY_SECRET", "MIRA_OTHER_FACT_BODY_SECRET", "ROWAN_ONLY_SUMMARY_SECRET",
    "ROWAN_FACT_SUMMARY_SECRET", "ROWAN_FACT_BODY_SECRET", "REVOKED_HIDDEN_SUMMARY", "REVOKED_FACT_BODY_SECRET"]) {
    assert.equal(serializedActivity.includes(secret), false, `Player activity leaked ${secret}`);
  }
  for (const key of ["details", "type", "audience", "characterId", "playerId", "catalogItemId", "visibility", "previousVisibility", "operationId", "factCount", "scope"]) {
    assert.equal(serializedActivity.includes(`\"${key}\"`), false, `Player activity leaked ${key}`);
  }
  for (const token of ["activity-pending-hash", "activity-rejected-hash"]) {
    assert.deepEqual(db.getPlayerState(token).recentActivity, []);
    assert.deepEqual(db.getPlayerState(token).newActivity, []);
  }
  const hiddenEventId = db.listCampaignActivity(campaign.id).find((event) => event.type === "knowledge_created" && event.knowledgeEntryId === revokedEntry.id).id;
  assert.throws(() => db.markPlayerActivitySeen("activity-mira-hash", hiddenEventId), /not visible/);

  const rowanState = db.getPlayerState("activity-rowan-hash");
  assert.ok(hasEvent(rowanState.recentActivity, "knowledge_facts_revealed", sharedEntry.id));
  assert.equal(hasEvent(rowanState.recentActivity, "knowledge_facts_revealed", miraEntry.id), false);
  assert.ok(hasEvent(rowanState.recentActivity, "knowledge_summary_opened", miraSummary.id),
    "switching a summary from one Character to party opens it to other Characters");
  const fullMiraJournal = db.listPlayerJournal("activity-mira-hash", 50).events;
  assert.equal(fullMiraJournal.some((event) => event.knowledgeTitle === "Revoked secret title"), false,
    "pagination must not restore a Knowledge title after its last current grant was revoked");
  assert.equal(JSON.stringify(fullMiraJournal).includes("MIRA_FACT_BODY_SECRET"), false);

  const groupedEntry = db.createKnowledge(campaign.id, "fact", "Mira's multi-part clue", "HIDDEN_GROUP_SUMMARY");
  const groupedFacts = ["A", "B", "C"].map((suffix) => db.createKnowledgeFact(campaign.id, groupedEntry.id, `GROUP_FACT_${suffix}_SECRET`));
  db.revealKnowledgeFactToCharacter(campaign.id, groupedEntry.id, groupedFacts[0].id, mira.id);
  db.revealKnowledgeFactToCharacter(campaign.id, groupedEntry.id, groupedFacts[1].id, mira.id);
  const beforeSeen = db.getPlayerState("activity-mira-hash");
  const grouped = beforeSeen.newActivity.filter((event) => event.kind === "knowledge_facts_revealed" && event.knowledgeEntryId === groupedEntry.id);
  assert.equal(grouped.length, 2);
  const representative = beforeSeen.newActivity[0];
  assert.equal(representative.kind, "knowledge_facts_revealed");
  assert.equal(representative.knowledgeEntryId, groupedEntry.id);
  const seenMarker = db.markPlayerActivitySeen("activity-mira-hash", representative.id);
  assert.equal(seenMarker.id, representative.id);
  assert.equal(db.getPlayerState("activity-mira-hash").newActivity.some((event) => event.knowledgeEntryId === groupedEntry.id), false);
  db.revealKnowledgeFactToCharacter(campaign.id, groupedEntry.id, groupedFacts[2].id, mira.id);
  const afterSeen = db.getPlayerState("activity-mira-hash").newActivity.filter((event) => event.kind === "knowledge_facts_revealed" && event.knowledgeEntryId === groupedEntry.id);
  assert.equal(afterSeen.length, 1);
  assert.equal(afterSeen[0].knowledgeTitle, "Mira's multi-part clue");
  assert.equal(db.listCampaignActivity(campaign.id).some((event) => event.type === "knowledge_fact_access_revoked"), true);
  assert.equal(db.getPlayerState("activity-mira-hash").recentActivity.some((event) => "type" in event || "details" in event), false);
});

test("Player Journal cursor uses the event ID tie-breaker and ignores newly inserted newer events", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "progdm-journal-test-"));
  const file = join(directory, "game.db");
  const db = openDatabase({ file });
  const campaign = db.createCampaign("Journal tie-breaker");
  const character = db.createCharacter(campaign.id, "Mira");
  const session = db.createSession(campaign.id, "Chapter");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "Mira", "journal-tie-token");
  db.approvePlayer(player.id, { characterId: character.id });
  const item = db.createCatalogItem(campaign.id, "Key");
  for (let index = 0; index < 4; index++) db.grantInventoryItem(character.id, item.id, 1);

  const raw = new SQLite(file);
  t.after(() => { raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  raw.prepare("UPDATE campaign_activity SET created_at=? WHERE campaign_id=? AND type='item_granted'")
    .run("2020-01-01T00:00:00.000Z", campaign.id);
  const first = db.listPlayerJournal("journal-tie-token", 2);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.events.map((event) => event.id), [...first.events.map((event) => event.id)].sort().reverse());

  db.grantInventoryItem(character.id, item.id, 1);
  const second = db.listPlayerJournal("journal-tie-token", 2, first.nextCursor);
  assert.equal(second.events.some((event) => event.createdAt > first.nextCursor.beforeCreatedAt), false,
    "an event inserted before the cursor must not shift the next page");
  assert.ok(second.events.every((event) => event.createdAt < first.nextCursor.beforeCreatedAt ||
    event.createdAt === first.nextCursor.beforeCreatedAt && event.id < first.nextCursor.beforeId));
  assert.equal(new Set([...first.events, ...second.events].map((event) => event.id)).size, 4);
});

test("Player Journal paginates the full safe activity projection with a strict stable cursor", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Full Journal");
  const character = db.createCharacter(campaign.id, "Mira");
  const session = db.createSession(campaign.id, "Current session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "Mira player", "journal-current-token");
  db.approvePlayer(player.id, { characterId: character.id });
  const catalogItem = db.createCatalogItem(campaign.id, "Journal token");
  for (let index = 0; index < 27; index++) db.grantInventoryItem(character.id, catalogItem.id, 1);

  const state = db.getPlayerState("journal-current-token");
  assert.equal(state.recentActivity.length, 20, "Home remains limited to its existing 20-event window");
  const first = db.listPlayerJournal("journal-current-token", 8);
  assert.equal(first.events.length, 8);
  assert.ok(first.nextCursor);
  assert.ok(first.events.every((event) => event.kind === "item_received"));
  assert.deepEqual(first.events, [...first.events].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)));

  const second = db.listPlayerJournal("journal-current-token", 8, first.nextCursor);
  assert.equal(second.events.length, 8);
  assert.ok(second.events.every((event) => event.createdAt < first.nextCursor.beforeCreatedAt ||
    event.createdAt === first.nextCursor.beforeCreatedAt && event.id < first.nextCursor.beforeId));
  assert.equal(new Set([...first.events, ...second.events].map((event) => event.id)).size, 16);

  const all = [...first.events, ...second.events];
  let cursor = second.nextCursor;
  while (cursor) {
    const page = db.listPlayerJournal("journal-current-token", 8, cursor);
    all.push(...page.events);
    cursor = page.nextCursor;
  }
  assert.equal(all.length, 27, "Journal includes older events outside Home's recent window");
  assert.equal(new Set(all.map((event) => event.id)).size, 27);
  assert.equal(db.listPlayerJournal("journal-current-token", 50).nextCursor, null);
  assert.throws(() => db.listPlayerJournal("journal-current-token", 0), /page size is invalid/);
  assert.throws(() => db.listPlayerJournal("journal-current-token", 51), /page size is invalid/);
  assert.throws(() => db.listPlayerJournal("unknown-journal-token"), /Active character access required/);

  const serialized = JSON.stringify(all);
  for (const forbidden of ["campaignId", "playerId", "characterId", "catalogItemId", "sourceInventoryItemId", "details", "payload", "type"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, `Journal projection leaked ${forbidden}`);
  }
});

test("Knowledge Fact export v10 remaps references, omits secrets, and imports invalid references atomically", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Export Facts");
  const character = db.createCharacter(campaign.id, "Mira");
  const session = db.createSession(campaign.id, "History");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "Player", "facts-secret-token-hash");
  db.approvePlayer(player.id, { characterId: character.id });
  const entry = db.createKnowledge(campaign.id, "fact", "Clue", "The summary stays hidden.");
  const fact = db.createKnowledgeFact(campaign.id, entry.id, "A sealed letter mentions Mira.");
  db.revealKnowledgeFactToCharacter(campaign.id, entry.id, fact.id, character.id);
  db.revealKnowledgeFactToParty(campaign.id, entry.id, fact.id);
  const archive = db.exportCampaign(campaign.id);
  assert.equal(archive.version, 10);
  assert.equal(JSON.stringify(archive).includes("facts-secret-token-hash"), false);
  assert.equal(archive.knowledgeFacts.length, 1);
  assert.equal(archive.knowledgeFactReveals.length, 2);
  const imported = db.importCampaign(archive);
  const roundTrip = db.exportCampaign(imported.id);
  const importedCharacter = roundTrip.characters[0];
  const importedEntry = roundTrip.knowledge[0];
  const importedFact = roundTrip.knowledgeFacts[0];
  assert.notEqual(importedFact.id, fact.id);
  assert.notEqual(importedFact.knowledgeEntryId, entry.id);
  assert.equal(importedFact.knowledgeEntryId, importedEntry.id);
  assert.notEqual(importedCharacter.id, character.id);
  assert.deepEqual(roundTrip.knowledgeFactReveals.map(({ audience, characterId, sessionId }) => [audience, characterId, sessionId]).sort(), [
    ["character", importedCharacter.id, roundTrip.sessions[0].id], ["party", null, roundTrip.sessions[0].id]
  ].sort());
  const before = db.listCampaigns().length;
  const invalid = structuredClone(archive);
  const characterReveal = invalid.knowledgeFactReveals.find((reveal) => reveal.audience === "character");
  assert.ok(characterReveal);
  characterReveal.characterId = "missing-character";
  assert.throws(() => db.importCampaign(invalid), /invalid reference/);
  assert.equal(db.listCampaigns().length, before);
});

test("concurrent reveal-next retries with one operation ID create one grant and one event", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const setup = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  const campaign = setup.createCampaign("Concurrent reveals");
  const entry = setup.createKnowledge(campaign.id, "fact", "Clue", "Hidden summary.");
  const first = setup.createKnowledgeFact(campaign.id, entry.id, "First fact.");
  setup.createKnowledgeFact(campaign.id, entry.id, "Second fact.");
  setup.close();

  const workerModule = new URL("../dist/index.js", import.meta.url).href;
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    let database;
    import(workerData.moduleUrl).then((api) => {
      database = api.openDatabase({ file: workerData.file });
      parentPort.postMessage({ ready: true });
      parentPort.on("message", (message) => {
        if (message !== "reveal") return;
        try {
          const result = database.revealNextKnowledgeFact(workerData.campaignId, workerData.entryId, "party", undefined, "same-concurrent-operation");
          parentPort.postMessage({ factId: result?.fact.id ?? null, created: result?.created ?? false });
        } finally { database.close(); }
      });
    }).catch((error) => parentPort.postMessage({ error: error.message }));
  `;
  const workerData = { moduleUrl: workerModule, file, campaignId: campaign.id, entryId: entry.id };
  const workers = [new Worker(workerSource, { eval: true, workerData }), new Worker(workerSource, { eval: true, workerData })];
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const waitForReady = (worker) => new Promise((resolveReady, reject) => {
    const onMessage = (message) => {
      if (message.error) { worker.off("message", onMessage); reject(new Error(message.error)); }
      if (message.ready) { worker.off("message", onMessage); resolveReady(); }
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
  });
  await Promise.all(workers.map(waitForReady));
  const revealFrom = (worker) => new Promise((resolveReveal, reject) => {
    const onMessage = (message) => {
      if (message.error) { worker.off("message", onMessage); reject(new Error(message.error)); }
      if ("factId" in message) { worker.off("message", onMessage); resolveReveal(message); }
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
    worker.postMessage("reveal");
  });
  const outcomes = await Promise.all(workers.map(revealFrom));
  assert.deepEqual(outcomes.map(({ factId }) => factId), [first.id, first.id]);
  assert.equal(outcomes.filter(({ created }) => created).length, 1);

  const check = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const archive = check.exportCampaign(campaign.id);
    assert.equal(archive.knowledgeFactReveals.length, 1);
    const revealEvents = archive.activity.filter(({ type }) => type === "knowledge_fact_revealed");
    assert.equal(revealEvents.length, 1);
    assert.equal(revealEvents[0].details.scope, "next");
  } finally { check.close(); }
});

test("Knowledge Fact tables survive current backup restore and are explicitly backed up", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Backup Facts");
    const character = db.createCharacter(campaign.id, "Mira");
    const entry = db.createKnowledge(campaign.id, "event", "Signal", "Hidden summary.");
    const fact = db.createKnowledgeFact(campaign.id, entry.id, "A green light flashes.");
    db.revealKnowledgeFactToCharacter(campaign.id, entry.id, fact.id, character.id);
    db.revealKnowledgeFactToParty(campaign.id, entry.id, fact.id);
    const backup = await db.createBackup();
    const bytes = readFileSync(db.backupFile(backup.id));
    const backupDb = new SQLite(db.backupFile(backup.id), { readonly: true });
    try {
      assert.equal(backupDb.prepare("SELECT count(*) AS count FROM knowledge_facts").get().count, 1);
      assert.equal(backupDb.prepare("SELECT count(*) AS count FROM knowledge_fact_reveals").get().count, 2);
    } finally { backupDb.close(); }
    db.deleteKnowledgeFact(campaign.id, entry.id, fact.id);
    assert.equal(db.listKnowledgeFacts(campaign.id, entry.id).length, 0);
    assert.equal(db.exportCampaign(campaign.id).knowledgeFactReveals.length, 0);
    assert.equal(db.listCampaignActivity(campaign.id).some(({ type }) => type === "knowledge_fact_revealed"), true);
    await db.restoreBackup(backup.id);
    assert.equal(db.listKnowledgeFacts(campaign.id, entry.id)[0].body, "A green light flashes.");
    assert.equal(readFileSync(db.backupFile(backup.id)).equals(bytes), true);
    const raw = new SQLite(file, { readonly: true });
    try { assert.deepEqual(raw.pragma("foreign_key_check"), []); } finally { raw.close(); }
    assert.equal(db.checkDataHealth().ok, true);
  } finally { db.close(); }
});

test("Data Health reports malformed Knowledge Facts and reveal grants without repairing them", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Facts health");
    const character = db.createCharacter(campaign.id, "Mira");
    const entry = db.createKnowledge(campaign.id, "fact", "Test", "Summary.");
    const fact = db.createKnowledgeFact(campaign.id, entry.id, "One fact.");
    db.revealKnowledgeFactToCharacter(campaign.id, entry.id, fact.id, character.id);
    const raw = new SQLite(file);
    try {
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare("UPDATE knowledge_facts SET body='   ', position=-1 WHERE id=?").run(fact.id);
      raw.prepare("UPDATE knowledge_fact_reveals SET audience='invalid', character_id=NULL WHERE knowledge_fact_id=?").run(fact.id);
      raw.pragma("ignore_check_constraints = OFF");
      const health = db.checkDataHealth();
      assert.equal(health.ok, false);
      assert.equal(health.checks.find(({ name }) => name === "Факты знаний").status, "error");
      assert.equal(health.checks.find(({ name }) => name === "Раскрытие фактов").status, "error");
      assert.equal(raw.prepare("SELECT body, position FROM knowledge_facts WHERE id=?").get(fact.id).body, "   ");
    } finally { raw.close(); }
  } finally { db.close(); }
});

test("inventory capacity, metadata defaults, bag stack identity and grant limits follow slot semantics", (t) => {
  let db;
  t.after(() => db?.close());
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  const campaign = db.createCampaign("Inventory foundation");
  const character = db.createCharacter(campaign.id, "Mira");
  assert.equal(character.inventoryCapacity, 12);
  const potion = db.createCatalogItem(campaign.id, "Potion");
  assert.deepEqual({ description: potion.description, category: potion.category, rarity: potion.rarity,
    equipmentSlot: potion.equipmentSlot, transferAllowed: potion.transferAllowed, discardAllowed: potion.discardAllowed },
  { description: "", category: "special", rarity: null, equipmentSlot: null, transferAllowed: true, discardAllowed: true });
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "inventory-domain-token");
  db.approvePlayer(player.id, { characterId: character.id });

  const legacy = new SQLite(db.file);
  try {
    legacy.prepare("INSERT INTO inventory_items (id, character_id, catalog_item_id, name, quantity, equipped_slot, created_at) VALUES (?, ?, NULL, ?, 1, NULL, ?)")
      .run("legacy-null-row", character.id, "Potion", "2026-01-01T00:00:00.000Z");
  } finally { legacy.close(); }
  db.updateCharacterInventoryCapacity(character.id, 2);
  const first = db.grantInventoryItem(character.id, potion.id, 2);
  assert.equal(first.quantity, 2);
  const map = db.createCatalogItem(campaign.id, "Map");
  const grantEventsBefore = db.listCampaignActivity(campaign.id).filter(({ type }) => type === "item_granted").length;
  assert.throws(() => db.grantInventoryItem(character.id, map.id, 1), /capacity is full/);
  assert.equal(db.listCampaignActivity(campaign.id).filter(({ type }) => type === "item_granted").length, grantEventsBefore,
    "rejected full-bag grant creates no partial inventory activity");
  assert.equal(db.listCharacterInventory(character.id).length, 2, "legacy same-name row remains separate and the failed grant adds nothing");
  const merged = db.grantInventoryItem(character.id, potion.id, 3);
  assert.equal(merged.id, first.id);
  assert.equal(merged.quantity, 5, "existing bag stacks merge at capacity");
  assert.equal(db.checkDataHealth().ok, true);
});

test("equipment operations preserve slot compatibility, stack, and capacity invariants", (t) => {
  let db;
  t.after(() => db?.close());
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  const campaign = db.createCampaign("Equipment foundation");
  const character = db.createCharacter(campaign.id, "Mira");
  const primary = db.createCatalogItem(campaign.id, "Knife");
  const secondary = db.createCatalogItem(campaign.id, "Lantern");
  const nonEquippable = db.createCatalogItem(campaign.id, "Letter");
  db.updateCatalogItemMetadata(primary.id, { category: "equipment", equipmentSlot: "primary" });
  db.updateCatalogItemMetadata(secondary.id, { category: "tool", equipmentSlot: "primary" });
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "equipment-domain-token");
  db.approvePlayer(player.id, { characterId: character.id });

  const equipped = db.grantInventoryItem(character.id, primary.id, 1);
  assert.equal(db.equipInventoryItem(character.id, equipped.id).equippedSlot, "primary");
  assert.equal(db.listCharactersByCampaign(campaign.id)[0].inventoryCapacity, 12);
  const stack = db.grantInventoryItem(character.id, primary.id, 2);
  assert.notEqual(stack.id, equipped.id, "a bag stack may coexist with its equipped catalog item");
  assert.equal(stack.equippedSlot, null);
  assert.equal(db.grantInventoryItem(character.id, primary.id, 1).quantity, 3);
  assert.throws(() => db.equipInventoryItem(character.id, stack.id), /single item/);

  const collision = db.grantInventoryItem(character.id, secondary.id, 1);
  assert.throws(() => db.equipInventoryItem(character.id, collision.id), /already occupied/);
  const letter = db.grantInventoryItem(character.id, nonEquippable.id, 1);
  assert.throws(() => db.equipInventoryItem(character.id, letter.id), /cannot be equipped/);
  assert.throws(() => db.updateCatalogItemMetadata(primary.id, { equipmentSlot: "accessory" }), /conflicts/);
  assert.equal(db.listCampaignActivity(campaign.id).some(({ type }) => type === "item_equipped" || type === "item_unequipped"), false);
  assert.equal(ACTIVITY_TYPES.includes("item_transferred"), true);
  assert.equal(ACTIVITY_TYPES.includes("item_discarded"), true);

  db.updateCharacterInventoryCapacity(character.id, 3);
  const equipableStack = db.listCharacterInventory(character.id).find((item) => item.id === collision.id);
  db.unequipInventoryItem(character.id, equipped.id);
  assert.equal(db.listCharacterInventory(character.id).find((item) => item.id === stack.id).quantity, 4,
    "unequipping merges into an existing bag stack without creating a duplicate");
  assert.equal(db.listCharacterInventory(character.id).some((item) => item.id === equipped.id), false);
  assert.equal(db.listCharacterInventory(character.id).find((item) => item.id === collision.id).equippedSlot, null);
  assert.throws(() => db.unequipInventoryItem(character.id, collision.id), /not equipped/);
  assert.ok(equipableStack);
  db.equipInventoryItem(character.id, collision.id);
  db.updateCharacterInventoryCapacity(character.id, 2);
  assert.throws(() => db.unequipInventoryItem(character.id, collision.id), /capacity is full/);
  db.updateCharacterInventoryCapacity(character.id, 3);
  db.unequipInventoryItem(character.id, collision.id);

  const capacityDb = new SQLite(db.file);
  try {
    capacityDb.prepare("INSERT INTO inventory_items (id, character_id, catalog_item_id, name, quantity, equipped_slot, created_at) VALUES (?, ?, NULL, ?, 1, NULL, ?)")
      .run("legacy-equipped-attempt", character.id, "Loose", "2026-01-01T00:00:00.000Z");
  } finally { capacityDb.close(); }
  const legacy = db.listCharacterInventory(character.id).find((item) => item.id === "legacy-equipped-attempt");
  assert.throws(() => db.equipInventoryItem(character.id, legacy.id), /Legacy/);
  assert.throws(() => db.updateCharacterInventoryCapacity(character.id, -1), /non-negative integer/);
  db.updateCharacterInventoryCapacity(character.id, 4);
  assert.equal(db.checkDataHealth().ok, true);
});

test("equipment requires free bag space when no merge target exists and catalog metadata is strictly validated", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Equipment capacity");
  const character = db.createCharacter(campaign.id, "Mira");
  const item = db.createCatalogItem(campaign.id, "Compass");
  db.updateCatalogItemMetadata(item.id, { equipmentSlot: "accessory" });
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "equipment-capacity-token");
  db.approvePlayer(player.id, { characterId: character.id });
  const row = db.grantInventoryItem(character.id, item.id, 1);
  db.equipInventoryItem(character.id, row.id);
  db.updateCharacterInventoryCapacity(character.id, 0);
  assert.throws(() => db.unequipInventoryItem(character.id, row.id), /capacity is full/);
  db.updateCharacterInventoryCapacity(character.id, 1);
  assert.equal(db.unequipInventoryItem(character.id, row.id).equippedSlot, null);

  assert.throws(() => db.updateCatalogItemMetadata(item.id, { category: "weapon" }), /category is invalid/);
  assert.throws(() => db.updateCatalogItemMetadata(item.id, { rarity: "legendary" }), /rarity is invalid/);
  assert.throws(() => db.updateCatalogItemMetadata(item.id, { description: "x".repeat(2001) }), /description is invalid/);
  assert.throws(() => db.updateCatalogItemMetadata(item.id, { transferAllowed: 1 }), /flag is invalid/);
  assert.equal(db.updateCatalogItemMetadata(item.id, { description: "Plain text", category: "tool", rarity: "rare",
    transferAllowed: false, discardAllowed: true }).description, "Plain text");
  assert.throws(() => db.grantInventoryItem(character.id, db.createCatalogItem(campaign.id, "Another").id, 1), /capacity is full/);
  assert.equal(db.checkDataHealth().ok, true);
});

test("campaign export v10 round-trips inventory metadata, capacity and equipment; invalid imports are atomic", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Inventory archive");
  const character = db.createCharacter(campaign.id, "Mira");
  const equippedCatalog = db.createCatalogItem(campaign.id, "Knife");
  const bagCatalog = db.createCatalogItem(campaign.id, "Map");
  db.updateCatalogItemMetadata(equippedCatalog.id, { description: "A small blade.", category: "equipment", rarity: "uncommon",
    equipmentSlot: "primary", transferAllowed: false, discardAllowed: true });
  db.updateCatalogItemMetadata(bagCatalog.id, { description: "Old chart", category: "document", rarity: "rare" });
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "inventory-export-token");
  db.approvePlayer(player.id, { characterId: character.id });
  const equippedRow = db.grantInventoryItem(character.id, equippedCatalog.id, 1);
  db.equipInventoryItem(character.id, equippedRow.id);
  db.grantInventoryItem(character.id, bagCatalog.id, 2);
  db.updateCharacterInventoryCapacity(character.id, 3);

  const archive = db.exportCampaign(campaign.id);
  assert.equal(archive.version, 10);
  const imported = db.importCampaign(archive);
  const importedArchive = db.exportCampaign(imported.id);
  assert.equal(importedArchive.characters[0].inventoryCapacity, 3);
  const importedEquipped = importedArchive.inventoryItems.find((row) => row.equippedSlot !== null);
  assert.ok(importedEquipped);
  assert.equal(importedEquipped.equippedSlot, "primary");
  assert.notEqual(importedEquipped.catalogItemId, equippedCatalog.id);
  assert.deepEqual(importedArchive.catalogItems.map(({ description, category, rarity, equipmentSlot, transferAllowed, discardAllowed }) =>
    ({ description, category, rarity, equipmentSlot, transferAllowed, discardAllowed })).sort((a, b) => a.category.localeCompare(b.category)), [
    { description: "A small blade.", category: "equipment", rarity: "uncommon", equipmentSlot: "primary", transferAllowed: false, discardAllowed: true },
    { description: "Old chart", category: "document", rarity: "rare", equipmentSlot: null, transferAllowed: true, discardAllowed: true }
  ].sort((a, b) => a.category.localeCompare(b.category)));
  assert.equal(db.checkDataHealth().ok, true);

  const beforeCount = db.listCampaigns().length;
  const overCapacity = structuredClone(archive);
  overCapacity.characters[0].inventoryCapacity = 0;
  assert.throws(() => db.importCampaign(overCapacity), /over-capacity/);
  const wrongEquipment = structuredClone(archive);
  wrongEquipment.inventoryItems.find((row) => row.equippedSlot !== null).equippedSlot = "armor";
  assert.throws(() => db.importCampaign(wrongEquipment), /invalid equipment state/);
  const wrongCatalog = structuredClone(archive);
  wrongCatalog.catalogItems[0].category = "invalid";
  assert.throws(() => db.importCampaign(wrongCatalog), /category is invalid/);
  assert.equal(db.listCampaigns().length, beforeCount, "invalid v10 imports do not leave partially imported campaigns");
});

test("legacy campaign import derives capacity from bag rows above the default", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Large legacy bag");
  const character = db.createCharacter(campaign.id, "Mira");
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "large-legacy-bag-token");
  db.approvePlayer(player.id, { characterId: character.id });
  db.updateCharacterInventoryCapacity(character.id, 14);
  for (let index = 0; index < 14; index++) {
    const item = db.createCatalogItem(campaign.id, `Item ${index}`);
    db.grantInventoryItem(character.id, item.id, index === 0 ? 5 : 1);
  }
  const legacy = db.exportCampaign(campaign.id);
  legacy.version = 8;
  for (const row of legacy.characters) delete row.inventoryCapacity;
  for (const row of legacy.catalogItems) {
    delete row.description;
    delete row.category;
    delete row.rarity;
    delete row.equipmentSlot;
    delete row.transferAllowed;
    delete row.discardAllowed;
  }
  for (const row of legacy.inventoryItems) delete row.equippedSlot;

  const imported = db.importCampaign(legacy);
  const importedCharacter = db.listCharactersByCampaign(imported.id)[0];
  assert.equal(importedCharacter.inventoryCapacity, 14, "legacy capacity counts stack rows, not item quantities");
  assert.equal(db.listCharacterInventory(importedCharacter.id).length, 14);
  assert.equal(db.listCharacterInventory(importedCharacter.id).find(({ quantity }) => quantity > 1).quantity, 5);
  assert.equal(db.checkDataHealth().ok, true);
});

test("Data Health reports capacity, equipment, catalog and cross-campaign inventory corruption without repair", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Inventory health");
    const other = db.createCampaign("Other inventory");
    const character = db.createCharacter(campaign.id, "Mira");
    const item = db.createCatalogItem(campaign.id, "Token");
    const bagItem = db.createCatalogItem(campaign.id, "Map");
    db.updateCatalogItemMetadata(item.id, { equipmentSlot: "tool" });
    const session = db.createSession(campaign.id, "Session");
    db.activateSession(session.id);
    const player = db.submitPlayerRequest(session.id, "A", "inventory-health-token");
    db.approvePlayer(player.id, { characterId: character.id });
    const inventory = db.grantInventoryItem(character.id, item.id, 1);
    db.equipInventoryItem(character.id, inventory.id);
    db.grantInventoryItem(character.id, bagItem.id, 1);
    const otherCatalogItem = db.createCatalogItem(other.id, "Foreign");
    const raw = new SQLite(file);
    try {
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare("UPDATE characters SET inventory_capacity=0 WHERE id=?").run(character.id);
      assert.equal(db.checkDataHealth().checks.find(({ name }) => name === "Вместимость сумок").status, "error");
      raw.prepare("UPDATE characters SET inventory_capacity=-1 WHERE id=?").run(character.id);
      raw.prepare("UPDATE catalog_items SET category='invalid' WHERE id=?").run(item.id);
      raw.prepare("UPDATE catalog_items SET equipment_slot='special' WHERE id=?").run(item.id);
      raw.prepare("UPDATE inventory_items SET catalog_item_id=? WHERE id=?").run(otherCatalogItem.id, inventory.id);
      raw.pragma("ignore_check_constraints = OFF");
      const health = db.checkDataHealth();
      assert.equal(health.ok, false);
      assert.equal(health.checks.find(({ name }) => name === "Вместимость сумок").status, "error");
      assert.equal(health.checks.find(({ name }) => name === "Каталог предметов").status, "error");
      assert.equal(health.checks.find(({ name }) => name === "Инвентарь и экипировка").status, "error");
      assert.equal(raw.prepare("SELECT inventory_capacity FROM characters WHERE id=?").get(character.id).inventory_capacity, -1,
        "health checks do not auto-repair data");
    } finally { raw.close(); }
  } finally { db.close(); }
});

test("restore migrates a real pre-0014 backup, derives safe capacity, preserves inventory and leaves source bytes unchanged", async (t) => {
  const liveFile = temporaryFile(t);
  const root = dirname(dirname(liveFile));
  const backups = join(root, "backups");
  const uploads = join(root, "uploads");
  const migrationFolder = mkdtempSync(join(tmpdir(), "progdm-migrations-pre-0014-"));
  const backupUuid = "00000000-0000-4000-8000-000000000314";
  const backupName = `progdm-backup-${backupUuid}.db`;
  mkdirSync(backups, { recursive: true });
  const backupUploads = join(backups, `progdm-backup-${backupUuid}-uploads`);
  mkdirSync(backupUploads, { recursive: true });
  for (const folder of ["monsters", "characters", "items"]) {
    mkdirSync(join(uploads, folder), { recursive: true });
    mkdirSync(join(backupUploads, folder), { recursive: true });
  }
  t.after(() => {
    assert.equal(dirname(migrationFolder), resolve(tmpdir()));
    rmSync(migrationFolder, { recursive: true, force: true });
  });
  const sourceMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(sourceMigrations, "meta", "_journal.json"), "utf8"));
  const preInventoryEntries = journal.entries.filter((entry) => entry.idx <= 13);
  mkdirSync(join(migrationFolder, "meta"));
  writeFileSync(join(migrationFolder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: preInventoryEntries }));
  for (const entry of preInventoryEntries) copyFileSync(join(sourceMigrations, entry.tag + ".sql"), join(migrationFolder, entry.tag + ".sql"));

  const legacy = new SQLite(join(root, "legacy-pre-0014.db"));
  legacy.pragma("foreign_keys = ON");
  migrate(drizzle(legacy), { migrationsFolder: migrationFolder });
  legacy.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)")
    .run("legacy-campaign", "Legacy inventory", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO sessions (id, campaign_id, name, status, join_token, created_at) VALUES (?, ?, ?, 'ended', ?, ?)")
    .run("legacy-session", "legacy-campaign", "Old session", "legacy-join-token", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO characters (id, campaign_id, name, created_at) VALUES (?, ?, ?, ?)")
    .run("legacy-character", "legacy-campaign", "Mira", "2026-01-01T00:00:00.000Z");
  const insertCatalog = legacy.prepare("INSERT INTO catalog_items (id, campaign_id, name, created_at) VALUES (?, 'legacy-campaign', ?, ?)");
  const insertInventory = legacy.prepare("INSERT INTO inventory_items (id, character_id, catalog_item_id, name, quantity, created_at) VALUES (?, 'legacy-character', ?, ?, ?, ?)");
  for (let index = 0; index < 13; index++) {
    const catalogId = `legacy-catalog-${index}`;
    const name = `Old item ${index}`;
    insertCatalog.run(catalogId, name, "2026-01-01T00:00:00.000Z");
    insertInventory.run(`legacy-inventory-${index}`, catalogId, name, index === 0 ? 7 : 1, "2026-01-01T00:00:00.000Z");
  }
  insertInventory.run("legacy-inventory-null", null, "Uncatalogued item", 4, "2026-01-01T00:00:00.000Z");
  legacy.prepare(`INSERT INTO campaign_activity (id, campaign_id, session_id, character_id, catalog_item_id, type, created_at, payload)
    VALUES (?, 'legacy-campaign', 'legacy-session', 'legacy-character', 'legacy-catalog-0', 'item_granted', ?, ?)`)
    .run("legacy-activity", "2026-01-01T00:00:00.000Z", JSON.stringify({ itemName: "Old item 0", quantity: 7, totalQuantity: 7 }));
  const sourceBackup = join(backups, backupName);
  await legacy.backup(sourceBackup);
  legacy.close();
  const originalBytes = readFileSync(sourceBackup);

  const db = openDatabase({ file: liveFile, backupsDirectory: backups, uploadsDirectory: uploads });
  try {
    await db.restoreBackup(backupName);
    const migratedCharacter = db.listCharactersByCampaign("legacy-campaign")[0];
    assert.equal(migratedCharacter.inventoryCapacity, 14);
    const items = db.listCharacterInventory("legacy-character");
    assert.equal(items.length, 14);
    assert.equal(items.find(({ id }) => id === "legacy-inventory-0").quantity, 7);
    assert.equal(items.find(({ id }) => id === "legacy-inventory-null").catalogItemId, null);
    assert.ok(items.every(({ equippedSlot }) => equippedSlot === null));
    const migratedCatalog = db.listCatalogItemsByCampaign("legacy-campaign");
    assert.ok(migratedCatalog.every(({ description, category, rarity, equipmentSlot, transferAllowed, discardAllowed }) =>
      description === "" && category === "special" && rarity === null && equipmentSlot === null && transferAllowed && discardAllowed));
    assert.equal(db.listCampaignActivity("legacy-campaign").some(({ id, type }) => id === "legacy-activity" && type === "item_granted"), true);
    assert.equal(db.checkDataHealth().ok, true, JSON.stringify(db.checkDataHealth()));
    const raw = new SQLite(liveFile);
    try { assert.deepEqual(raw.pragma("foreign_key_check"), []); } finally { raw.close(); }
    assert.deepEqual(readFileSync(sourceBackup), originalBytes, "restore does not modify the legacy backup");
    const original = new SQLite(sourceBackup, { readonly: true });
    try {
      assert.equal(original.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, preInventoryEntries.length);
      assert.equal(original.prepare("SELECT count(*) AS count FROM inventory_items").get().count, 14);
      assert.equal(original.prepare("SELECT count(*) AS count FROM pragma_table_info('characters') WHERE name='inventory_capacity'").get().count, 0);
    } finally { original.close(); }
  } finally { db.close(); }
});

test("DM inventory grant belongs to persistent Character and records an optional active Session", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Prepared campaign");
  const character = db.createCharacter(campaign.id, "Mira");
  const item = db.createCatalogItem(campaign.id, "Key");
  const otherCampaign = db.createCampaign("Other campaign");
  const foreignItem = db.createCatalogItem(otherCampaign.id, "Foreign key");

  db.updateCharacterInventoryCapacity(character.id, 1);
  const prepGrant = db.grantInventoryItem(character.id, item.id, 1);
  assert.equal(prepGrant.quantity, 1, "grant succeeds before any Session or Player exists");
  assert.equal(db.listCampaignActivity(campaign.id).find((event) => event.type === "item_granted").sessionId, null);
  assert.throws(() => db.grantInventoryItem(character.id, foreignItem.id, 1), /unavailable for this campaign/);
  assert.equal(db.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted").length, 1);

  const map = db.createCatalogItem(campaign.id, "Map");
  assert.throws(() => db.grantInventoryItem(character.id, map.id, 1), /capacity is full/);
  assert.equal(db.listCharacterInventory(character.id).length, 1);
  assert.equal(db.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted").length, 1,
    "capacity failure rolls back inventory and activity together");
  assert.equal(db.grantInventoryItem(character.id, item.id, 2).quantity, 3,
    "merge of the existing catalog stack succeeds when its bag slot is occupied");

  const archived = db.createCharacter(campaign.id, "Old character");
  db.archiveCharacter(archived.id);
  const activityBeforeArchivedGrant = db.listCampaignActivity(campaign.id).length;
  assert.throws(() => db.grantInventoryItem(archived.id, item.id, 1), /Archived character/);
  assert.equal(db.listCampaignActivity(campaign.id).length, activityBeforeArchivedGrant);

  const session = db.createSession(campaign.id, "Current session");
  db.activateSession(session.id);
  const liveGrant = db.grantInventoryItem(character.id, item.id, 1);
  assert.equal(liveGrant.quantity, 4);
  const events = db.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted");
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).sessionId, session.id);
});

test("catalog transfers merge atomically, project to both characters, and replay without duplicate effects", (t) => {
  const db = memoryDatabase(t);
  const { campaign, sender, recipient, session, senderToken, recipientToken } = activeInventoryPair(db);
  const item = db.createCatalogItem(campaign.id, "Компас");
  const source = db.grantInventoryItem(sender.id, item.id, 8);
  const targetStack = db.grantInventoryItem(recipient.id, item.id, 4);
  db.updateCharacterInventoryCapacity(recipient.id, 1);
  const targets = db.listPlayerInventoryTransferTargets(senderToken, source.id);
  assert.deepEqual(targets, [{ characterId: recipient.id, characterName: "Rowan", bagSlotsUsed: 1,
    inventoryCapacity: 1, willMerge: true, maxQuantity: 9995 }]);

  const operationId = randomUUID();
  assert.deepEqual(db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 3, operationId), { replayed: false });
  assert.equal(db.listCharacterInventory(sender.id).find((row) => row.id === source.id).quantity, 5);
  assert.equal(db.listCharacterInventory(recipient.id).find((row) => row.id === targetStack.id).quantity, 7);
  const event = db.listCampaignActivity(campaign.id).find((row) => row.operationId === undefined && row.type === "item_transferred");
  assert.ok(event);
  assert.deepEqual({ campaignId: event.campaignId, sessionId: event.sessionId, playerId: event.playerId,
    characterId: event.characterId, relatedCharacterId: event.relatedCharacterId, catalogItemId: event.catalogItemId,
    itemName: event.details.itemName, quantity: event.details.quantity, source: event.details.sourceInventoryItemId }, {
    campaignId: campaign.id, sessionId: session.id, playerId: db.listPlayersByCampaign(campaign.id).find((player) => player.displayName === "Mira player").id,
    characterId: sender.id, relatedCharacterId: recipient.id, catalogItemId: item.id,
    itemName: "Компас", quantity: 3, source: source.id
  });
  assert.equal(db.listCampaignActivity(campaign.id).filter((row) => row.type === "item_transferred").length, 1);
  assert.deepEqual(db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 3, operationId), { replayed: true });
  assert.throws(() => db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 2, operationId), /operation ID conflict/);
  assert.equal(db.listCharacterInventory(recipient.id).find((row) => row.id === targetStack.id).quantity, 7);

  const sent = db.getPlayerState(senderToken).recentActivity.find((entry) => entry.id === event.id);
  const received = db.getPlayerState(recipientToken).recentActivity.find((entry) => entry.id === event.id);
  assert.equal(sent.kind, "item_transferred");
  assert.equal(sent.direction, "sent");
  assert.equal(sent.otherCharacterName, "Rowan");
  assert.equal(received.kind, "item_transferred");
  assert.equal(received.direction, "received");
  assert.equal(received.otherCharacterName, "Mira");
  const unrelated = db.createCharacter(campaign.id, "Victor");
  const unrelatedPlayer = db.submitPlayerRequest(session.id, "Victor player", "transfer-unrelated-token");
  db.approvePlayer(unrelatedPlayer.id, { characterId: unrelated.id });
  assert.equal(db.listPlayerJournal(senderToken, 50).events.some((entry) => entry.id === event.id && entry.kind === "item_transferred" && entry.direction === "sent"), true);
  assert.equal(db.listPlayerJournal(recipientToken, 50).events.some((entry) => entry.id === event.id && entry.kind === "item_transferred" && entry.direction === "received"), true);
  assert.equal(db.listPlayerJournal("transfer-unrelated-token", 50).events.some((entry) => entry.id === event.id), false);
  const discard = db.discardPlayerInventoryItem(senderToken, source.id, 1, randomUUID());
  const discardEvent = db.listCampaignActivity(campaign.id).find((row) => row.type === "item_discarded");
  assert.ok(discardEvent);
  assert.equal(db.listPlayerJournal(senderToken, 50).events.some((entry) => entry.id === discardEvent.id && entry.kind === "item_discarded"), true);
  assert.equal(db.listPlayerJournal(recipientToken, 50).events.some((entry) => entry.id === discardEvent.id), false);
  assert.equal(discard.replayed, false);
  for (const projection of [sent, received]) {
    for (const forbidden of ["relatedCharacterId", "characterId", "playerId", "sourceInventoryItemId", "operationId", "payload"]) {
      assert.equal(forbidden in projection, false);
    }
  }
});

test("transfers enforce eligible target, stack limits, bag capacity, equipment and permissions atomically", (t) => {
  const db = memoryDatabase(t);
  const { campaign, sender, recipient, senderToken } = activeInventoryPair(db, "Transfer rules");
  const item = db.createCatalogItem(campaign.id, "Key");
  const source = db.grantInventoryItem(sender.id, item.id, 2);
  db.updateCharacterInventoryCapacity(recipient.id, 0);
  assert.deepEqual(db.listPlayerInventoryTransferTargets(senderToken, source.id)[0], {
    characterId: recipient.id, characterName: "Rowan", bagSlotsUsed: 0, inventoryCapacity: 0, willMerge: false, maxQuantity: 0
  });
  const beforeEvents = db.listCampaignActivity(campaign.id).length;
  assert.throws(() => db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 1, randomUUID()), /capacity is full/);
  assert.equal(db.listCharacterInventory(sender.id)[0].quantity, 2);
  assert.equal(db.listCampaignActivity(campaign.id).length, beforeEvents);

  db.updateCharacterInventoryCapacity(recipient.id, 1);
  db.updateCatalogItemMetadata(item.id, { transferAllowed: false });
  assert.throws(() => db.listPlayerInventoryTransferTargets(senderToken, source.id), /cannot be transferred/);
  assert.throws(() => db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 1, randomUUID()), /cannot be transferred/);
  db.updateCatalogItemMetadata(item.id, { transferAllowed: true, discardAllowed: false });
  assert.throws(() => db.discardPlayerInventoryItem(senderToken, source.id, 1, randomUUID()), /cannot be discarded/);

  db.updateCatalogItemMetadata(item.id, { discardAllowed: true });
  const equipCatalog = db.createCatalogItem(campaign.id, "Tool item");
  db.updateCatalogItemMetadata(equipCatalog.id, { equipmentSlot: "tool" });
  const equipped = db.grantInventoryItem(sender.id, equipCatalog.id, 1);
  db.equipInventoryItem(sender.id, equipped.id);
  assert.throws(() => db.transferPlayerInventoryItem(senderToken, equipped.id, recipient.id, 1, randomUUID()), /equipped/);
  assert.throws(() => db.discardPlayerInventoryItem(senderToken, equipped.id, 1, randomUUID()), /equipped/);

  const otherCampaign = db.createCampaign("Foreign");
  const foreignCharacter = db.createCharacter(otherCampaign.id, "Foreign character");
  assert.throws(() => db.transferPlayerInventoryItem(senderToken, source.id, foreignCharacter.id, 1, randomUUID()), /unavailable/);
  assert.throws(() => db.transferPlayerInventoryItem(senderToken, source.id, sender.id, 1, randomUUID()), /same character/);
  assert.throws(() => db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 0, randomUUID()), /quantity is invalid/);
  assert.throws(() => db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 3, randomUUID()), /exceeds owned/);
});

test("failed transfer or discard activity append rolls back inventory changes", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const { campaign, sender, recipient, senderToken } = activeInventoryPair(db, "Atomic item events");
    const item = db.createCatalogItem(campaign.id, "Rope");
    const source = db.grantInventoryItem(sender.id, item.id, 3);
    const raw = new SQLite(file);
    raw.exec(`CREATE TRIGGER reject_item_events BEFORE INSERT ON campaign_activity
      WHEN NEW.type IN ('item_transferred', 'item_discarded')
      BEGIN SELECT RAISE(ABORT, 'test item activity failure'); END`);
    raw.close();

    const historyBefore = db.listCampaignActivity(campaign.id);
    assert.throws(() => db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 2, randomUUID()), /test item activity failure/);
    assert.equal(db.listCharacterInventory(sender.id).find((row) => row.id === source.id).quantity, 3);
    assert.deepEqual(db.listCharacterInventory(recipient.id), []);
    assert.deepEqual(db.listCampaignActivity(campaign.id), historyBefore);

    assert.throws(() => db.discardPlayerInventoryItem(senderToken, source.id, 2, randomUUID()), /test item activity failure/);
    assert.equal(db.listCharacterInventory(sender.id).find((row) => row.id === source.id).quantity, 3);
    assert.deepEqual(db.listCampaignActivity(campaign.id), historyBefore);
  } finally { db.close(); }
});

test("legacy inventory transfer creates separate rows and discard supports partial/full idempotent retries", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "progdm-db-test-"));
  const file = join(directory, "nested", "game.db");
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  t.after(() => db.close());
  t.after(() => { assert.equal(dirname(directory), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const { campaign, sender, recipient, senderToken } = activeInventoryPair(db, "Legacy actions");
  const legacyA = "10000000-0000-4000-8000-000000000001";
  const legacyB = "10000000-0000-4000-8000-000000000002";
  const raw = new SQLite(db.file);
  try {
    raw.prepare(`INSERT INTO inventory_items (id, character_id, catalog_item_id, name, quantity, equipped_slot, created_at)
      VALUES (?, ?, NULL, ?, 5, NULL, ?), (?, ?, NULL, ?, 4, NULL, ?)`)
      .run(legacyA, sender.id, "Old tonic", "2026-01-01T00:00:00.000Z", legacyB, recipient.id, "Old tonic", "2026-01-01T00:00:00.000Z");
  } finally { raw.close(); }
  assert.equal(db.listPlayerInventoryTransferTargets(senderToken, legacyA)[0].willMerge, false);
  const partialTransfer = randomUUID();
  db.transferPlayerInventoryItem(senderToken, legacyA, recipient.id, 2, partialTransfer);
  assert.equal(db.listCharacterInventory(sender.id).find((row) => row.id === legacyA).quantity, 3);
  assert.equal(db.listCharacterInventory(recipient.id).length, 2, "legacy rows with matching names never merge");
  assert.equal(db.listCharacterInventory(recipient.id).find((row) => row.id !== legacyB).quantity, 2);

  const partialDiscard = randomUUID();
  db.discardPlayerInventoryItem(senderToken, legacyA, 1, partialDiscard);
  assert.equal(db.listCharacterInventory(sender.id).find((row) => row.id === legacyA).quantity, 2);
  assert.deepEqual(db.discardPlayerInventoryItem(senderToken, legacyA, 1, partialDiscard), { replayed: true });
  assert.equal(db.listCampaignActivity(campaign.id).filter((row) => row.type === "item_discarded").length, 1);
  assert.throws(() => db.discardPlayerInventoryItem(senderToken, legacyA, 2, partialDiscard), /operation ID conflict/);

  const fullDiscard = randomUUID();
  db.discardPlayerInventoryItem(senderToken, legacyA, 2, fullDiscard);
  assert.equal(db.listCharacterInventory(sender.id).some((row) => row.id === legacyA), false);
  assert.deepEqual(db.discardPlayerInventoryItem(senderToken, legacyA, 2, fullDiscard), { replayed: true }, "full deletion remains replayable by its audit row");
  assert.equal(db.checkDataHealth().ok, true, JSON.stringify(db.checkDataHealth()));
});

test("corrupt catalog references fail closed for projection and destructive inventory actions", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const pair = activeInventoryPair(db, "Corrupt inventory");
    const otherCampaign = db.createCampaign("Foreign catalog");
    const foreignItem = db.createCatalogItem(otherCampaign.id, "Foreign item");
    const raw = new SQLite(file);
    try {
      raw.pragma("foreign_keys = OFF");
      raw.prepare(`INSERT INTO inventory_items (id, character_id, catalog_item_id, name, quantity, equipped_slot, created_at)
        VALUES (?, ?, ?, ?, 1, NULL, ?)`)
        .run("10000000-0000-4000-8000-000000000003", pair.sender.id, foreignItem.id, "Borrowed", "2026-01-01T00:00:00.000Z");
    } finally { raw.close(); }
    const corrupt = db.getPlayerState(pair.senderToken).inventory.find((row) => row.name === "Borrowed");
    assert.equal(corrupt.catalogItemId, null);
    assert.equal(corrupt.transferAllowed, false);
    assert.equal(corrupt.discardAllowed, false);
    assert.throws(() => db.transferPlayerInventoryItem(pair.senderToken, corrupt.id, pair.recipient.id, 1, randomUUID()), /catalog relation is invalid/);
    assert.throws(() => db.discardPlayerInventoryItem(pair.senderToken, corrupt.id, 1, randomUUID()), /catalog relation is invalid/);
  } finally { db.close(); }
});

test("Data Health reports malformed transfer activity without repairing it", (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const { campaign, sender, recipient, session, senderPlayer } = activeInventoryPair(db, "Activity health");
    const raw = new SQLite(file);
    try {
      raw.prepare(`INSERT INTO campaign_activity (id, campaign_id, session_id, player_id, character_id, related_character_id,
        catalog_item_id, knowledge_entry_id, operation_id, type, created_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'item_transferred', ?, '{}')`)
        .run(randomUUID(), campaign.id, session.id, senderPlayer.id, sender.id, recipient.id, new Date().toISOString());
    } finally { raw.close(); }
    const health = db.checkDataHealth();
    assert.equal(health.ok, false);
    assert.equal(health.checks.find((check) => check.name === "Передачи и выбрасывание").status, "error");
    assert.equal(db.listCampaignActivity(campaign.id).some((event) => event.type === "item_transferred"), true,
      "health checks report corrupt history without changing it");
  } finally { db.close(); }
});

test("campaign archive v10 remaps transfer targets, preserves discard history, and rejects these events in v9 atomically", (t) => {
  const db = memoryDatabase(t);
  const { campaign, sender, recipient, session, senderToken } = activeInventoryPair(db, "Archive transfers");
  const item = db.createCatalogItem(campaign.id, "Compass");
  const source = db.grantInventoryItem(sender.id, item.id, 4);
  db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 1, randomUUID());
  const remaining = db.listCharacterInventory(sender.id).find((row) => row.catalogItemId === item.id);
  db.discardPlayerInventoryItem(senderToken, remaining.id, 1, randomUUID());
  const archive = db.exportCampaign(campaign.id);
  assert.equal(archive.version, 10);
  assert.equal("operationId" in archive.activity.find((event) => event.type === "item_transferred"), false);
  assert.equal(JSON.stringify(archive).includes("Archive transfers-sender-token"), false);
  const transfer = archive.activity.find((event) => event.type === "item_transferred");
  assert.equal(transfer.relatedCharacterId, recipient.id);
  assert.equal(transfer.details.sourceInventoryItemId, source.id);
  assert.equal(transfer.sessionId, session.id);
  assert.equal(archive.activity.find((event) => event.type === "item_discarded").relatedCharacterId, null);

  const imported = db.importCampaign(archive);
  const importedArchive = db.exportCampaign(imported.id);
  const mappedSender = importedArchive.characters.find((character) => character.name === "Mira").id;
  const mappedRecipient = importedArchive.characters.find((character) => character.name === "Rowan").id;
  const mappedTransfer = importedArchive.activity.find((event) => event.type === "item_transferred");
  assert.notEqual(mappedSender, sender.id);
  assert.notEqual(mappedRecipient, recipient.id);
  assert.equal(mappedTransfer.characterId, mappedSender);
  assert.equal(mappedTransfer.relatedCharacterId, mappedRecipient);
  assert.equal(mappedTransfer.sessionId, importedArchive.sessions[0].id);
  assert.equal(mappedTransfer.details.sourceInventoryItemId, source.id, "opaque source inventory ID is historical and is not remapped");
  assert.equal(db.checkDataHealth().ok, true, JSON.stringify(db.checkDataHealth()));

  const before = db.listCampaigns().length;
  const legacyV9 = structuredClone(archive);
  legacyV9.version = 9;
  assert.throws(() => db.importCampaign(legacyV9), /invalid event type/);
  const invalidTarget = structuredClone(archive);
  invalidTarget.activity.find((event) => event.type === "item_transferred").relatedCharacterId = "missing-character";
  assert.throws(() => db.importCampaign(invalidTarget), /invalid reference/);
  assert.equal(db.listCampaigns().length, before, "invalid v10 transfer archive is rejected atomically");
});

test("current backup preserves transfer/discard; staged pre-0015 restore preserves old events and source bytes", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const { campaign, sender, recipient, senderToken } = activeInventoryPair(db, "Backup transfers");
    const item = db.createCatalogItem(campaign.id, "Map");
    const source = db.grantInventoryItem(sender.id, item.id, 3);
    db.transferPlayerInventoryItem(senderToken, source.id, recipient.id, 1, randomUUID());
    const remainder = db.listCharacterInventory(sender.id).find((row) => row.catalogItemId === item.id);
    db.discardPlayerInventoryItem(senderToken, remainder.id, 1, randomUUID());
    const currentBackup = await db.createBackup();
    db.grantInventoryItem(sender.id, item.id, 1);
    await db.restoreBackup(currentBackup.id);
    const restoredEvents = db.listCampaignActivity(campaign.id).filter((event) => ["item_transferred", "item_discarded"].includes(event.type));
    assert.equal(restoredEvents.length, 2);
    assert.equal(restoredEvents.find((event) => event.type === "item_transferred").relatedCharacterId, recipient.id);
    assert.equal(db.listCharacterInventory(sender.id).find((row) => row.catalogItemId === item.id).quantity, 1);
    assert.deepEqual(db.checkDataHealth().checks.find((check) => check.name === "Внешние ключи").status, "ok");

    const oldBackup = await db.createBackup();
    const oldPath = db.backupFile(oldBackup.id);
    const migration = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../migrations/", import.meta.url)) }).at(-1);
    let preMigrationEventIds;
    const old = new SQLite(oldPath);
    try {
      old.pragma("foreign_keys = OFF");
      old.exec("DELETE FROM campaign_activity WHERE type IN ('item_transferred','item_discarded')");
      preMigrationEventIds = old.prepare("SELECT id FROM campaign_activity ORDER BY id").all().map((row) => row.id);
      old.exec(`CREATE TABLE campaign_activity_pre0015 (
        id text PRIMARY KEY NOT NULL, campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
        session_id text REFERENCES sessions(id) ON DELETE RESTRICT, player_id text REFERENCES players(id) ON DELETE RESTRICT,
        character_id text REFERENCES characters(id) ON DELETE RESTRICT, catalog_item_id text REFERENCES catalog_items(id) ON DELETE RESTRICT,
        knowledge_entry_id text REFERENCES knowledge_entries(id) ON DELETE RESTRICT, operation_id text, type text NOT NULL,
        created_at text NOT NULL, payload text NOT NULL CHECK(json_valid(payload)))`);
      old.exec(`INSERT INTO campaign_activity_pre0015 SELECT id, campaign_id, session_id, player_id, character_id,
        catalog_item_id, knowledge_entry_id, operation_id, type, created_at, payload FROM campaign_activity`);
      old.exec("DROP TABLE campaign_activity; ALTER TABLE campaign_activity_pre0015 RENAME TO campaign_activity;");
      old.exec("CREATE INDEX campaign_activity_campaign_order_idx ON campaign_activity (campaign_id, created_at, id);");
      old.exec("CREATE INDEX campaign_activity_session_order_idx ON campaign_activity (session_id, created_at, id);");
      old.exec("CREATE UNIQUE INDEX campaign_activity_operation_unique ON campaign_activity (operation_id) WHERE operation_id IS NOT NULL;");
      old.prepare("DELETE FROM __drizzle_migrations WHERE created_at=?").run(migration.folderMillis);
    } finally { old.close(); }
    const sourceHash = createHash("sha256").update(readFileSync(oldPath)).digest("hex");
    await db.restoreBackup(oldBackup.id);
    const restoredOldEvents = db.listCampaignActivity(campaign.id);
    assert.deepEqual(restoredOldEvents.filter((event) => preMigrationEventIds.includes(event.id)).map((event) => event.id).sort(), preMigrationEventIds.sort());
    assert.equal(restoredOldEvents.filter((event) => event.relatedCharacterId !== null).length, 0, "pre-0015 rows gain a null related character");
    assert.equal(restoredOldEvents.some((event) => ["item_transferred", "item_discarded"].includes(event.type)), false);
    assert.deepEqual(db.checkDataHealth().checks.find((check) => check.name === "Внешние ключи").status, "ok");
    assert.equal(createHash("sha256").update(readFileSync(oldPath)).digest("hex"), sourceHash, "restore never changes the original pre-0015 backup");
  } finally { db.close(); }
});
