import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import SQLite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
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
  await legacy.backup(join(backups, backupName));
  legacy.close();

  const database = openDatabase({ file, backupsDirectory: backups, uploadsDirectory: uploads });
  try {
    const rawAfterStartup = new SQLite(file);
    assert.equal(rawAfterStartup.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, journal.entries.length);
    rawAfterStartup.close();
    assert.equal(database.getCampaign("00000000-0000-4000-8000-000000000101").name, "Campaign from v5");
    database.createCampaign("Change after migration");

    await database.restoreBackup(backupName);

    assert.deepEqual(database.listCampaigns().map(({ name }) => name), ["Campaign from v5"]);
    assert.equal(database.getSession("00000000-0000-4000-8000-000000000102").status, "ended");
    assert.equal(database.listPlayersByCampaign("00000000-0000-4000-8000-000000000101")[0].characterId, "00000000-0000-4000-8000-000000000104");
    const restoredKnowledge = database.listKnowledgeByCampaign("00000000-0000-4000-8000-000000000101")[0];
    assert.equal(restoredKnowledge.title, "Old private clue");
    assert.equal(restoredKnowledge.description, "Keep this through restore.");
    assert.equal(restoredKnowledge.visibility, "character");
    assert.equal(restoredKnowledge.visibleToCharacterId, "00000000-0000-4000-8000-000000000104");

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
