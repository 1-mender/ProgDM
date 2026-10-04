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

test("legacy campaign formats v1 through v5 import with profile defaults and ID remapping", (t) => {
  const db = memoryDatabase(t);
  const campaign = db.createCampaign("Legacy");
  const mira = db.createCharacter(campaign.id, "Mira");
  const session = db.createSession(campaign.id, "Session");
  db.activateSession(session.id);
  const player = db.submitPlayerRequest(session.id, "A", "secret-hash");
  db.approvePlayer(player.id, { characterId: mira.id });
  db.createPersonalNote("secret-hash", "Legacy note body");
  const clue = db.createKnowledge(campaign.id, "note", "Clue", "Personal knowledge");
  db.setKnowledgeVisibility(clue.id, "character", mira.id);
  const current = db.exportCampaign(campaign.id);
  for (const version of [1, 2, 3, 4, 5]) {
    const legacy = structuredClone(current);
    legacy.version = version;
    for (const character of legacy.characters) {
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
    if (version < 3) delete legacy.personalNotes;
    if (version === 1) {
      delete legacy.activity;
      delete legacy.characters[0].archivedAt;
      legacy.knowledge[0].visibility = "player";
      legacy.knowledge[0].visibleToPlayerId = player.id;
      delete legacy.knowledge[0].visibleToCharacterId;
    }
    delete legacy.profileFields;
    delete legacy.profileFieldValues;
    const imported = db.importCampaign(legacy);
    const exported = db.exportCampaign(imported.id);
    assert.equal(exported.sessions[0].status, "ended");
    assert.equal(exported.knowledge[0].visibility, "character");
    assert.equal(exported.knowledge[0].visibleToCharacterId, exported.characters[0].id);
    assert.equal(exported.assignments[0].playerId, exported.players[0].id);
    assert.equal(exported.assignments[0].sessionId, exported.sessions[0].id);
    assert.deepEqual({ traits: exported.characters[0].traits, appearance: exported.characters[0].appearance, quote: exported.characters[0].quote }, {
      traits: [], appearance: "", quote: ""
    });
    if (version === 3) assert.deepEqual({ title: exported.personalNotes[0].title, marker: exported.personalNotes[0].marker, pinned: exported.personalNotes[0].pinned }, {
      title: "", marker: "normal", pinned: false
    });
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
  assert.equal(archive.version, 6);
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
  const clue = db.createKnowledge(campaign.id, "note", "Door", "Behind the library");
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
  assert.deepEqual(db.getPlayerState("token-b-hash").newActivity.map((event) => event.type), ["item_granted"]);

  const exported = db.exportCampaign(campaign.id);
  assert.equal(exported.version, 6);
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
  for (const row of legacyV3.personalNotes) for (const key of ["title", "marker", "pinned"]) delete row[key];
  const v3Import = db.importCampaign(legacyV3);
  const v3Mira = db.listCharactersByCampaign(v3Import.id).find((row) => row.name === "Mira");
  assert.deepEqual({ title: db.listPersonalNotesByCharacter(v3Mira.id)[0].title, marker: db.listPersonalNotesByCharacter(v3Mira.id)[0].marker, pinned: db.listPersonalNotesByCharacter(v3Mira.id)[0].pinned }, {
    title: "", marker: "normal", pinned: false
  });
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
    db.updatePlayerProfile("backup-player-hash", { shortDescription: "Before backup", personalGoal: "Remember",
      traits: ["Patient", "Curious"], appearance: "A blue cloak", quote: "One more question." });
    db.createPersonalNote("backup-player-hash", "Private thought", { title: "Идея", marker: "question", pinned: true });
    db.grantInventoryItem(mira.id, item.id, 1);
    db.markPlayerActivitySeen("backup-player-hash", db.getPlayerState("backup-player-hash").newActivity[0].id);
    const backup = await db.createBackup();
    db.updatePlayerProfile("backup-player-hash", { shortDescription: "After backup", personalGoal: "Changed" });
    db.updateCharacterProfile(mira.id, { name: "Mira", shortDescription: "After backup", archetype: "", origin: "", personalGoal: "Changed", dmNotes: "",
      traits: [], appearance: "", quote: "" });
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
    assert.deepEqual(legacyTableNames, currentTableNames.filter((name) => !["campaign_activity", "character_personal_notes", "character_read_state", "campaign_profile_field_definitions", "character_profile_field_values"].includes(name)), "migrations after 0005 add the later activity, profile and read-state tables");

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
  assert.equal(archive.version, 6);
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
