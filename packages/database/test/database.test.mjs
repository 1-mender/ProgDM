import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import SQLite from "better-sqlite3";
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
    assert.equal(raw.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, 1);
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
