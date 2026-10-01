import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import SQLite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

test("legacy campaign formats v1 and v2 remain importable with character knowledge remapping", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Legacy");
  const mira = db.createCharacter(campaign.id, "Mira");
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "secret-hash");
  db.approvePlayer(player.id, { characterId: mira.id });
  const clue = db.createKnowledge(campaign.id, "note", "Clue", "Personal knowledge");
  db.setKnowledgeVisibility(clue.id, "character", mira.id);
  const current = db.exportCampaign(campaign.id);
  for (const version of [1, 2]) {
    const legacy = structuredClone(current);
    legacy.version = version;
    delete legacy.personalNotes;
    if (version === 1) {
      delete legacy.activity;
      delete legacy.characters[0].archivedAt;
      legacy.knowledge[0].visibility = "player";
      legacy.knowledge[0].visibleToPlayerId = player.id;
      delete legacy.knowledge[0].visibleToCharacterId;
    }
    const imported = db.importCampaign(legacy);
    const exported = db.exportCampaign(imported.id);
    assert.equal(exported.sessions[0].status, "ended");
    assert.equal(exported.knowledge[0].visibility, "character");
    assert.equal(exported.knowledge[0].visibleToCharacterId, exported.characters[0].id);
    assert.equal(exported.assignments[0].playerId, exported.players[0].id);
    assert.equal(exported.assignments[0].sessionId, exported.sessions[0].id);
    assert.equal(JSON.stringify(exported).includes("secret-hash"), false);
    assert.equal(db.checkDataHealth().ok, true);
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
  const knowledge = db.createKnowledge(campaign.id, "note", "Secret door", "Behind the library");
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
  assert.equal(archive.version, 3);
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
  db.updateCharacterProfile(mira.id, { name: "Mira", shortDescription: "Explorer", archetype: "Scout", origin: "North", personalGoal: "Find home", dmNotes: "Secret" });
  db.updatePlayerProfile("token-a-hash", { shortDescription: "Explorer of ruins", personalGoal: "Find the map" });
  const note = db.createPersonalNote("token-a-hash", "The old door is suspicious.");
  db.grantInventoryItem(mira.id, item.id, 1);
  const clue = db.createKnowledge(campaign.id, "note", "Door", "Behind the library");
  db.setKnowledgeVisibility(clue.id, "character", mira.id);
  const firstView = db.getPlayerState("token-a-hash");
  assert.equal(firstView.profile.personalGoal, "Find the map");
  assert.equal(firstView.profile.dmNotes, undefined);
  assert.equal(firstView.notes[0].id, note.id);
  assert.deepEqual(firstView.newActivity.map((event) => event.type), ["knowledge_visibility_changed", "item_granted"]);
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
  assert.equal(db.getPlayerState("token-b-hash").notes[0].id, note.id);
  assert.deepEqual(db.getPlayerState("token-c-hash").notes, []);
  assert.equal(db.getPlayerState("token-c-hash").knowledge.some((entry) => entry.id === clue.id), false);
  assert.throws(() => db.updatePersonalNote("token-c-hash", note.id, "Changed"), /not found/);
  assert.equal(db.getPlayerState("token-b-hash").newActivity.length, 0);
  db.grantInventoryItem(mira.id, item.id, 1);
  assert.deepEqual(db.getPlayerState("token-b-hash").newActivity.map((event) => event.type), ["item_granted"]);

  const exported = db.exportCampaign(campaign.id);
  assert.equal(exported.version, 3);
  assert.equal(exported.personalNotes.length, 1);
  assert.equal("readState" in exported, false);
  assert.equal(JSON.stringify(exported).includes("token-a-hash"), false);
  const imported = db.importCampaign(exported);
  const importedMira = db.listCharactersByCampaign(imported.id).find((row) => row.name === "Mira");
  assert.equal(importedMira.dmNotes, "Secret");
  assert.equal(importedMira.personalGoal, "Find the map");
  assert.equal(db.listPersonalNotesByCharacter(importedMira.id)[0].body, note.body);
  const legacyExport = structuredClone(exported);
  legacyExport.version = 2;
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

test("backup restores profile, notes and character read marker", async (t) => {
  const file = temporaryFile(t);
  const root = dirname(dirname(file));
  const db = openDatabase({ file, backupsDirectory: join(root, "backups"), uploadsDirectory: join(root, "uploads") });
  try {
    const campaign = db.createCampaign("Backup story");
    const mira = db.createCharacter(campaign.id, "Mira");
    const item = db.createCatalogItem(campaign.id, "Key");
    const session = db.createSession(campaign.id, "Night");
    db.activateSession(session.id);
    const player = db.submitPlayerRequest(session.id, "A", "backup-player-hash");
    db.approvePlayer(player.id, { characterId: mira.id });
    db.updatePlayerProfile("backup-player-hash", { shortDescription: "Before backup", personalGoal: "Remember" });
    db.createPersonalNote("backup-player-hash", "Private thought");
    db.grantInventoryItem(mira.id, item.id, 1);
    db.markPlayerActivitySeen("backup-player-hash", db.getPlayerState("backup-player-hash").newActivity[0].id);
    const backup = await db.createBackup();
    db.updatePlayerProfile("backup-player-hash", { shortDescription: "After backup", personalGoal: "Changed" });
    db.createPersonalNote("backup-player-hash", "Later thought");
    db.grantInventoryItem(mira.id, item.id, 1);
    await db.restoreBackup(backup.id);
    assert.equal(db.getPlayerState("backup-player-hash").profile.shortDescription, "Before backup");
    assert.deepEqual(db.getPlayerState("backup-player-hash").notes.map((note) => note.body), ["Private thought"]);
    assert.equal(db.getPlayerState("backup-player-hash").newActivity.length, 0);
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
  const knowledge = db.createKnowledge(campaign.id, "note", "Clue", "Old letter");
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
  const entry = database.createKnowledge(campaign.id, "npc", "Keeper", "Knows the old road.");
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
    assert.deepEqual(legacyTableNames, currentTableNames.filter((name) => !["campaign_activity", "character_personal_notes", "character_read_state"].includes(name)), "migrations 0007 and 0008 add the activity, notes and read-state tables");

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
