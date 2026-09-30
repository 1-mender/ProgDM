import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "@progdm/database";
import { createApp } from "../dist/app.js";

const dmToken = "test-dm-token";
const headers = { authorization: "Bearer " + dmToken };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "progdm-api-test-"));
  const database = openDatabase({
    file: ":memory:", backupsDirectory: join(directory, "backups"), uploadsDirectory: join(directory, "uploads")
  });
  const app = createApp({ database, dmToken });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { database, app };
}
function get(app, url) { return app.inject({ method: "GET", url, headers }); }
function post(app, url, payload = {}) { return app.inject({ method: "POST", url, headers, payload }); }

test("empty database has no session and health is public", async (t) => {
  const { app } = fixture(t);
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true, service: "progdm-server" });
  const response = await get(app, "/api/session/current");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { snapshot: null });
  const dmState = (await get(app, "/api/dm/state")).json();
  assert.deepEqual(dmState, {
    campaigns: [], sessions: [], current: null, players: [], characters: [], itemCatalog: [], knowledge: [],
    networkAddresses: dmState.networkAddresses
  });
  assert.equal(Array.isArray(dmState.networkAddresses), true);
});

test("all DM reads and writes require the key, including through a proxy", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Campaign");
  const session = database.createSession(campaign.id, "Session");
  const routes = [
    ["GET", "/api/dm/state"], ["GET", "/api/session/current"],
    ["POST", "/api/dm/campaigns"],
    ["POST", "/api/dm/campaigns/" + campaign.id + "/sessions"],
    ["POST", "/api/dm/sessions/" + session.id + "/start"],
    ["POST", "/api/dm/sessions/" + session.id + "/end"]
  ];
  for (const [method, url] of routes) {
    for (const authorization of ["", "Bearer wrong-key", "Bearer " + dmToken + "x"]) {
      const response = await app.inject({
        method, url, headers: { authorization, "x-forwarded-for": "127.0.0.1", origin: "http://localhost:5173" },
        ...(method === "POST" ? { payload: { name: "Unwanted" } } : {})
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.body.includes(session.joinToken), false);
    }
  }
  assert.equal(database.listCampaigns().length, 1);
  assert.equal(database.getCurrentSession(), null);
});

test("DM can create, select, start, switch and finish sessions", async (t) => {
  const { app, database } = fixture(t);
  const created = await post(app, "/api/dm/campaigns", { name: "  First campaign  " });
  assert.equal(created.statusCode, 201);
  const campaign = created.json().campaign;
  assert.equal(campaign.name, "First campaign");
  const second = (await post(app, "/api/dm/campaigns", { name: "Second" })).json().campaign;
  const aResponse = await post(app, "/api/dm/campaigns/" + campaign.id + "/sessions", { name: "First session" });
  assert.equal(aResponse.statusCode, 201);
  const a = aResponse.json().session;
  const b = (await post(app, "/api/dm/campaigns/" + second.id + "/sessions", { name: "Second session" })).json().session;
  assert.equal((await post(app, "/api/dm/sessions/" + a.id + "/start", { expectedActiveSessionId: null })).statusCode, 200);
  assert.equal((await get(app, "/api/session/current")).json().snapshot.session.id, a.id);
  const stale = await post(app, "/api/dm/sessions/" + b.id + "/start", { expectedActiveSessionId: null });
  assert.equal(stale.statusCode, 409);
  assert.equal(database.getCurrentSession().session.id, a.id);
  assert.equal((await post(app, "/api/dm/sessions/" + b.id + "/start", { expectedActiveSessionId: a.id })).statusCode, 200);
  assert.equal(database.getSession(a.id).status, "ended");
  const state = (await get(app, "/api/dm/state")).json();
  assert.equal(state.campaigns.length, 2);
  assert.equal(state.sessions.length, 2);
  assert.equal(state.current.campaign.id, second.id);
  assert.equal((await post(app, "/api/dm/sessions/" + b.id + "/end")).statusCode, 200);
  assert.equal((await post(app, "/api/dm/sessions/" + b.id + "/end")).statusCode, 200);
  assert.equal((await get(app, "/api/dm/state")).json().current, null);
  assert.equal((await post(app, "/api/dm/sessions/" + b.id + "/start", { expectedActiveSessionId: null })).statusCode, 409);
  await app.close();
  assert.throws(() => database.listCampaigns());
});

test("campaign character can be reassigned next session with inventory and old session history preserved", async (t) => {
  const { app, database } = fixture(t);
  const campaign = (await post(app, "/api/dm/campaigns", { name: "Persistent campaign" })).json().campaign;
  const character = (await post(app, "/api/dm/campaigns/" + campaign.id + "/characters", { name: "Mira" })).json().character;
  const item = (await post(app, "/api/dm/campaigns/" + campaign.id + "/items", { name: "Old compass" })).json().item;
  const firstSession = (await post(app, "/api/dm/campaigns/" + campaign.id + "/sessions", { name: "First night" })).json().session;
  const start = (session, expectedActiveSessionId = null) =>
    post(app, "/api/dm/sessions/" + session.id + "/start", { expectedActiveSessionId });
  assert.equal((await start(firstSession)).statusCode, 200);

  const firstPlayerToken = "A".repeat(43);
  const firstRequest = await post(app, "/api/join/" + firstSession.joinToken + "/request", {
    displayName: "Mira's player", playerToken: firstPlayerToken
  });
  assert.equal(firstRequest.statusCode, 200);
  const firstPlayer = database.listPlayersByCampaign(campaign.id).find((player) => player.sessionId === firstSession.id);
  assert.equal((await post(app, "/api/dm/players/" + firstPlayer.id + "/approve", { characterId: character.id })).statusCode, 200);
  const grant = await post(app, "/api/dm/characters/" + character.id + "/items", { catalogItemId: item.id, quantity: 2 });
  assert.equal(grant.statusCode, 201);

  const readPlayer = (token) => app.inject({
    method: "GET", url: "/api/player/me", headers: { authorization: "Bearer " + token }
  });
  const firstViewBeforeEnd = await readPlayer(firstPlayerToken);
  assert.equal(firstViewBeforeEnd.statusCode, 200);
  assert.equal(firstViewBeforeEnd.json().inventory[0].quantity, 2);
  assert.equal((await post(app, "/api/dm/sessions/" + firstSession.id + "/end")).statusCode, 200);
  assert.equal((await post(app, "/api/dm/characters/" + character.id + "/items", {
    catalogItemId: item.id, quantity: 1
  })).statusCode, 409);

  const secondSession = (await post(app, "/api/dm/campaigns/" + campaign.id + "/sessions", { name: "Second night" })).json().session;
  assert.equal((await start(secondSession)).statusCode, 200);
  const secondPlayerToken = "B".repeat(43);
  const secondRequest = await post(app, "/api/join/" + secondSession.joinToken + "/request", {
    displayName: "Mira's player", playerToken: secondPlayerToken
  });
  assert.equal(secondRequest.statusCode, 200);
  const secondPlayer = database.listPlayersByCampaign(campaign.id).find((player) => player.sessionId === secondSession.id);
  const reassigned = await post(app, "/api/dm/players/" + secondPlayer.id + "/approve", { characterId: character.id });
  assert.equal(reassigned.statusCode, 200);
  assert.equal(reassigned.json().player.characterId, character.id);

  const secondView = await readPlayer(secondPlayerToken);
  assert.equal(secondView.statusCode, 200);
  assert.equal(secondView.json().characterName, "Mira");
  assert.deepEqual(secondView.json().inventory.map(({ name, quantity }) => ({ name, quantity })), [
    { name: "Old compass", quantity: 2 }
  ]);
  const secondGrant = await post(app, "/api/dm/characters/" + character.id + "/items", {
    catalogItemId: item.id, quantity: 1
  });
  assert.equal(secondGrant.statusCode, 201);
  assert.equal(secondGrant.json().item.quantity, 3);
  assert.deepEqual((await readPlayer(secondPlayerToken)).json().inventory.map(({ name, quantity }) => ({ name, quantity })), [
    { name: "Old compass", quantity: 3 }
  ]);

  const thirdPlayerToken = "C".repeat(43);
  const thirdRequest = await post(app, "/api/join/" + secondSession.joinToken + "/request", {
    displayName: "Another player", playerToken: thirdPlayerToken
  });
  assert.equal(thirdRequest.statusCode, 200);
  const thirdPlayer = database.listPlayersByCampaign(campaign.id).find((player) => player.sessionId === secondSession.id && player.displayName === "Another player");
  const conflict = await post(app, "/api/dm/players/" + thirdPlayer.id + "/approve", { characterId: character.id });
  assert.equal(conflict.statusCode, 409);

  const history = database.listPlayersByCampaign(campaign.id);
  assert.equal(history.find((player) => player.sessionId === firstSession.id).characterId, character.id);
  assert.equal(history.find((player) => player.sessionId === secondSession.id && player.id === secondPlayer.id).characterId, character.id);
  assert.equal(database.getSession(firstSession.id).status, "ended");
  assert.equal(database.getSession(secondSession.id).status, "active");
  const firstViewAfterEnd = await readPlayer(firstPlayerToken);
  assert.equal(firstViewAfterEnd.statusCode, 200);
  assert.equal(firstViewAfterEnd.json().sessionName, "First night");
  assert.equal(firstViewAfterEnd.json().characterName, "Mira");
  assert.equal(firstViewAfterEnd.json().inventory[0].quantity, 3);
  const oldTokenWrite = await app.inject({
    method: "POST", url: "/api/dm/characters/" + character.id + "/items",
    headers: { authorization: "Bearer " + firstPlayerToken },
    payload: { catalogItemId: item.id, quantity: 1 }
  });
  assert.equal(oldTokenWrite.statusCode, 401);
});

test("invalid names, malformed JSON, unknown records and transitions are rejected", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Campaign");
  for (const payload of [{}, { name: "" }, { name: " \n\t" }, { name: 123 }, { name: "x".repeat(121) }, { name: "Valid", unexpected: true }]) {
    assert.equal((await post(app, "/api/dm/campaigns", payload)).statusCode, 400);
    assert.equal((await post(app, "/api/dm/campaigns/" + campaign.id + "/sessions", payload)).statusCode, 400);
  }
  const malformed = await app.inject({ method: "POST", url: "/api/dm/campaigns", headers: { ...headers, "content-type": "application/json" }, payload: "{" });
  assert.equal(malformed.statusCode, 400);
  const missing = "00000000-0000-4000-8000-000000000000";
  assert.equal((await post(app, "/api/dm/campaigns/" + missing + "/sessions", { name: "Session" })).statusCode, 404);
  assert.equal((await post(app, "/api/dm/sessions/" + missing + "/start", { expectedActiveSessionId: null })).statusCode, 404);
  assert.equal((await post(app, "/api/dm/sessions/not-an-id/end")).statusCode, 400);
  const planned = database.createSession(campaign.id, "Planned");
  assert.equal((await post(app, "/api/dm/sessions/" + planned.id + "/end")).statusCode, 409);
  assert.equal((await post(app, "/api/dm/sessions/" + planned.id + "/start")).statusCode, 400);
  assert.equal(database.listCampaigns().length, 1);
  assert.equal(database.listSessions(campaign.id).length, 1);
});

test("campaign export and import are authenticated and omit player and invitation credentials", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Transfer campaign");
  const character = database.createCharacter(campaign.id, "Mira");
  const catalogItem = database.createCatalogItem(campaign.id, "Key");
  const session = database.createSession(campaign.id, "Night one");
  database.activateSession(session.id);
  const player = database.submitPlayerRequest(session.id, "Player", "b".repeat(64));
  database.approvePlayer(player.id, { characterId: character.id });
  database.grantInventoryItem(character.id, catalogItem.id, 1);

  const exported = await get(app, "/api/dm/campaigns/" + campaign.id + "/export");
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers["content-disposition"], /attachment/);
  assert.equal(exported.body.includes(session.joinToken), false);
  assert.equal(exported.body.includes("b".repeat(64)), false);
  const archive = exported.json();
  assert.equal((await app.inject({ method: "GET", url: "/api/dm/backups" })).statusCode, 401);

  const imported = await post(app, "/api/dm/campaigns/import", archive);
  assert.equal(imported.statusCode, 201);
  assert.notEqual(imported.json().campaign.id, campaign.id);
  const importedData = database.exportCampaign(imported.json().campaign.id);
  assert.equal(importedData.characters[0].name, "Mira");
  assert.equal(importedData.inventoryItems[0].quantity, 1);
  const invalid = await post(app, "/api/dm/campaigns/import", { ...archive, inventoryItems: [{ ...archive.inventoryItems[0], characterId: "missing" }] });
  assert.equal(invalid.statusCode, 400);
  assert.equal(database.listCampaigns().length, 2);
});

test("DM can download a database backup and restore it without losing the pre-restore state", async (t) => {
  const { app, database } = fixture(t);
  const original = database.createCampaign("Original");
  const created = await post(app, "/api/dm/backups", {});
  assert.equal(created.statusCode, 201);
  const backup = created.json().backup;
  const download = await app.inject({ method: "GET", url: "/api/dm/backups/" + backup.id + "/download", headers });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"].startsWith("application/vnd.sqlite3"), true);
  database.createCampaign("Temporary");
  const restored = await post(app, "/api/dm/backups/restore", { id: backup.id });
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(database.listCampaigns().map((campaign) => campaign.name), ["Original"]);
  assert.equal(database.listBackups().length, 2);
  assert.equal((await get(app, "/api/dm/backups")).json().backups.length, 2);
  assert.equal(database.getCampaign(original.id).name, "Original");
});
