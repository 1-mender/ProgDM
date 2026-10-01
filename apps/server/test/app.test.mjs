import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "@progdm/database";
import { createApp, requestLogFields } from "../dist/app.js";

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

test("request logs redact invitation secrets and omit authorization headers", () => {
  const token = "Z".repeat(43);
  const fields = requestLogFields({ method: "POST", url: `/api/join/${token}/request`, headers: { authorization: "Bearer private" } });
  assert.equal(JSON.stringify(fields).includes(token), false);
  assert.equal(JSON.stringify(fields).includes("private"), false);
  assert.equal(fields.url, "/api/join/[redacted]/request");
});

test("player write responses never return token hashes", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Campaign");
  const session = database.createSession(campaign.id, "Session");
  database.activateSession(session.id);
  const token = "T".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "A", playerToken: token });
  database.approvePlayer(database.listPlayersByCampaign(campaign.id)[0].id, { characterName: "Mira" });
  const result = await app.inject({ method: "POST", url: "/api/player/settings",
    headers: { authorization: "Bearer " + token }, payload: { displayName: "New name" } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().player.tokenHash, undefined);
});

test("pending, rejected and historical tokens cannot write private character data", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Campaign");
  const session = database.createSession(campaign.id, "Session");
  database.activateSession(session.id);
  const token = "V".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "A", playerToken: token });
  const player = database.listPlayersByCampaign(campaign.id)[0];
  const writes = [
    ["/api/player/profile", { shortDescription: "Invalid", personalGoal: "Invalid" }],
    ["/api/player/settings", { displayName: "Invalid" }],
    ["/api/player/notes", { body: "Invalid" }],
    ["/api/player/activity/seen", { upToActivityId: campaign.id }]
  ];
  const assertDenied = async () => {
    for (const [url, payload] of writes) {
      assert.equal((await app.inject({ method: "POST", url, headers: { authorization: "Bearer " + token }, payload })).statusCode, 403);
    }
  };
  await assertDenied();
  database.rejectPlayer(player.id);
  await assertDenied();
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "A", playerToken: token });
  database.approvePlayer(player.id, { characterName: "Mira" });
  database.endSession(session.id);
  await assertDenied();
  const state = (await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: "Bearer " + token } })).json();
  assert.equal(state.status, "approved");
  assert.equal(state.canEdit, false);
  assert.equal(state.profile, null);
  assert.deepEqual(state.notes, []);
});

test("public and player validation and unexpected errors are sanitized", async (t) => {
  const { app, database } = fixture(t);
  const invalid = await app.inject({ method: "GET", url: "/api/join/invalid" });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().message, "Проверьте введённые данные и допустимые значения.");
  database.getJoinInfo = () => { throw new Error("SQL confidential detail"); };
  const failure = await app.inject({ method: "GET", url: "/api/join/" + "U".repeat(43) });
  assert.equal(failure.statusCode, 500);
  assert.equal(failure.body.includes("confidential"), false);
});

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
    campaigns: [], sessions: [], current: null, players: [], characters: [], itemCatalog: [], knowledge: [], activity: [],
    networkAddresses: dmState.networkAddresses
  });
  assert.equal(Array.isArray(dmState.networkAddresses), true);
});

test("DM can inspect history, archive characters and check local data", async (t) => {
  const { app } = fixture(t);
  const campaign = (await post(app, "/api/dm/campaigns", { name: "Chronicle" })).json().campaign;
  const character = (await post(app, `/api/dm/campaigns/${campaign.id}/characters`, { name: "Mira" })).json().character;
  const archived = await post(app, `/api/dm/characters/${character.id}/archive`);
  assert.equal(archived.statusCode, 200);
  assert.ok(archived.json().character.archivedAt);
  const activity = (await get(app, `/api/dm/campaigns/${campaign.id}/activity`)).json().activity;
  assert.deepEqual(activity.map((event) => event.type), ["campaign_created", "character_created", "character_archived"]);
  const restored = await post(app, `/api/dm/characters/${character.id}/restore`);
  assert.equal(restored.json().character.archivedAt, null);
  const health = await post(app, "/api/dm/data/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);
});

test("player profile and notes enforce active assignment and field permissions", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Campaign");
  const mira = database.createCharacter(campaign.id, "Mira");
  const nora = database.createCharacter(campaign.id, "Nora");
  const session = database.createSession(campaign.id, "Session");
  database.activateSession(session.id);
  const aToken = "A".repeat(43);
  const bToken = "B".repeat(43);
  for (const [name, token] of [["A", aToken], ["B", bToken]]) {
    assert.equal((await post(app, `/api/join/${session.joinToken}/request`, { displayName: name, playerToken: token })).statusCode, 200);
  }
  const players = database.listPlayersByCampaign(campaign.id);
  database.approvePlayer(players.find((player) => player.displayName === "A").id, { characterId: mira.id });
  database.approvePlayer(players.find((player) => player.displayName === "B").id, { characterId: nora.id });
  const playerPost = (token, path, payload) => app.inject({ method: "POST", url: path,
    headers: { authorization: "Bearer " + token }, payload });
  const playerGet = (token) => app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: "Bearer " + token } });
  assert.equal((await post(app, `/api/dm/characters/${mira.id}/profile`, {
    name: "Mira", shortDescription: "DM text", archetype: "Scout", origin: "North", personalGoal: "Explore", dmNotes: "Hidden from players"
  })).statusCode, 200);
  assert.equal((await playerPost(aToken, "/api/player/profile", { shortDescription: "Player text", personalGoal: "Find clues", dmNotes: "Injected" })).statusCode, 400);
  const updatedProfile = await playerPost(aToken, "/api/player/profile", { shortDescription: "Player text", personalGoal: "Find clues" });
  assert.equal(updatedProfile.statusCode, 200);
  assert.equal(updatedProfile.json().character.dmNotes, undefined);
  assert.equal(updatedProfile.body.includes("Hidden from players"), false);
  assert.equal((await playerGet(aToken)).json().profile.dmNotes, undefined);
  assert.equal((await playerGet(aToken)).json().profile.archetype, "Scout");
  assert.equal(database.listCharactersByCampaign(campaign.id).find((row) => row.id === mira.id).dmNotes, "Hidden from players");
  const note = (await playerPost(aToken, "/api/player/notes", { body: "My theory" })).json().note;
  assert.equal((await playerGet(aToken)).json().notes[0].id, note.id);
  assert.deepEqual((await playerGet(bToken)).json().notes, []);
  assert.equal((await playerPost(bToken, `/api/player/notes/${note.id}`, { body: "Stolen" })).statusCode, 404);
  assert.equal((await get(app, `/api/dm/characters/${mira.id}/overview`)).json().notes[0].body, "My theory");
  const updatedSettings = await playerPost(aToken, "/api/player/settings", { displayName: "New A" });
  assert.equal(updatedSettings.statusCode, 200);
  assert.equal(updatedSettings.json().player.tokenHash, undefined);
  assert.equal((await playerGet(aToken)).json().displayName, "New A");
  database.endSession(session.id);
  assert.equal((await playerPost(aToken, "/api/player/notes", { body: "Too late" })).statusCode, 403);
  assert.equal((await playerGet(aToken)).json().notes.length, 0);
});

test("player settings cannot bypass Cyrillic case-insensitive name uniqueness", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Campaign");
  const session = database.createSession(campaign.id, "Session");
  database.activateSession(session.id);
  const token = "R".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Первый", playerToken: token });
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Аня", playerToken: "S".repeat(43) });
  const player = database.listPlayersByCampaign(campaign.id).find((row) => row.displayName === "Первый");
  database.approvePlayer(player.id, { characterName: "Mira" });
  const renamed = await app.inject({ method: "POST", url: "/api/player/settings",
    headers: { authorization: "Bearer " + token }, payload: { displayName: "  АНЯ  " } });
  assert.equal(renamed.statusCode, 409);
  assert.equal(database.listPlayersByCampaign(campaign.id).find((row) => row.id === player.id).displayName, "Первый");
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
    ["POST", "/api/dm/sessions/" + session.id + "/end"],
    ["POST", "/api/dm/data/health"], ["GET", "/api/dm/campaigns/" + campaign.id + "/activity"],
    ["GET", "/api/dm/sessions/" + session.id + "/activity"],
    ["GET", "/api/dm/characters/00000000-0000-4000-8000-000000000001/overview"],
    ["POST", "/api/dm/characters/00000000-0000-4000-8000-000000000001/profile"]
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

test("character knowledge follows its character across sessions without leaking to others", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Knowledge campaign");
  const mira = database.createCharacter(campaign.id, "Mira");
  const secondCharacter = database.createCharacter(campaign.id, "Rowan");
  const personal = database.createKnowledge(campaign.id, "note", "Mira's clue", "Only Mira knows this.");
  const party = database.createKnowledge(campaign.id, "quest", "Shared lead", "Everyone knows this.");
  const hidden = database.createKnowledge(campaign.id, "monster", "Unrevealed", "Keep this from players.");

  const firstSession = database.createSession(campaign.id, "Session 1");
  database.activateSession(firstSession.id);
  const requestPlayer = async (session, name, token) => {
    const response = await post(app, "/api/join/" + session.joinToken + "/request", { displayName: name, playerToken: token });
    assert.equal(response.statusCode, 200);
    return database.listPlayersByCampaign(campaign.id).find((player) => player.sessionId === session.id && player.displayName === name);
  };
  const miraA = await requestPlayer(firstSession, "Player A", "D".repeat(43));
  const miraAssignment = await post(app, "/api/dm/players/" + miraA.id + "/approve", { characterId: mira.id });
  assert.equal(miraAssignment.statusCode, 200);
  assert.equal((await post(app, "/api/dm/knowledge/" + personal.id + "/visibility", { visibility: "character", characterId: mira.id })).statusCode, 200);
  assert.equal((await post(app, "/api/dm/knowledge/" + party.id + "/visibility", { visibility: "party" })).statusCode, 200);

  const readPlayer = (token) => app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: "Bearer " + token } });
  const firstState = (await readPlayer("D".repeat(43))).json();
  assert.deepEqual(firstState.knowledge.map((entry) => entry.id).sort(), [personal.id, party.id].sort());
  assert.equal(firstState.knowledge.some((entry) => entry.id === hidden.id), false);
  await post(app, "/api/dm/sessions/" + firstSession.id + "/end");

  const secondSession = database.createSession(campaign.id, "Session 2");
  database.activateSession(secondSession.id);
  const miraB = await requestPlayer(secondSession, "Player B", "E".repeat(43));
  const rowanPlayer = await requestPlayer(secondSession, "Player C", "F".repeat(43));
  assert.equal((await post(app, "/api/dm/players/" + miraB.id + "/approve", { characterId: mira.id })).statusCode, 200);
  assert.equal((await post(app, "/api/dm/players/" + rowanPlayer.id + "/approve", { characterId: secondCharacter.id })).statusCode, 200);

  const miraState = (await readPlayer("E".repeat(43))).json();
  assert.deepEqual(miraState.knowledge.map((entry) => entry.id).sort(), [personal.id, party.id].sort());
  const rowanState = (await readPlayer("F".repeat(43))).json();
  assert.deepEqual(rowanState.knowledge.map((entry) => entry.id), [party.id]);
  assert.equal(rowanState.knowledge.some((entry) => entry.id === hidden.id), false);

  const history = database.listPlayersByCampaign(campaign.id);
  assert.equal(history.find((player) => player.id === miraA.id).characterId, mira.id);
  assert.equal(history.find((player) => player.id === miraB.id).characterId, mira.id);
  assert.equal(database.getSession(firstSession.id).status, "ended");
  assert.equal(database.getSession(secondSession.id).status, "active");
  assert.equal(database.listKnowledgeByCampaign(campaign.id).find((entry) => entry.id === personal.id).visibleToCharacterId, mira.id);
  const historicalPlayerState = (await readPlayer("D".repeat(43))).json();
  assert.equal(historicalPlayerState.sessionName, "Session 1");
  assert.deepEqual(historicalPlayerState.knowledge.map((entry) => entry.id).sort(), [personal.id, party.id].sort());
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
  const personalKnowledge = database.createKnowledge(campaign.id, "note", "Personal clue", "Known to Mira.");
  database.setKnowledgeVisibility(personalKnowledge.id, "character", character.id);

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
  assert.equal(importedData.knowledge[0].visibility, "character");
  assert.equal(importedData.knowledge[0].visibleToCharacterId, importedData.characters[0].id);
  assert.notEqual(importedData.knowledge[0].visibleToCharacterId, character.id);
  const invalid = await post(app, "/api/dm/campaigns/import", { ...archive, inventoryItems: [{ ...archive.inventoryItems[0], characterId: "missing" }] });
  assert.equal(invalid.statusCode, 400);
  assert.equal(database.listCampaigns().length, 2);
});

test("players reconnect by the same name in a new session after importing campaign history", async (t) => {
  const source = fixture(t);
  const campaign = source.database.createCampaign("Long campaign");
  const character = source.database.createCharacter(campaign.id, "Mira");
  const session1 = source.database.createSession(campaign.id, "Session 1");
  source.database.activateSession(session1.id);
  const oldToken = "E".repeat(43);
  assert.equal((await post(source.app, "/api/join/" + session1.joinToken + "/request", {
    displayName: "Player A", playerToken: oldToken
  })).statusCode, 200);
  const playerA = source.database.listPlayersByCampaign(campaign.id).find((player) => player.sessionId === session1.id);
  assert.equal((await post(source.app, "/api/dm/players/" + playerA.id + "/approve", { characterId: character.id })).statusCode, 200);
  const exported = await get(source.app, "/api/dm/campaigns/" + campaign.id + "/export");

  const destination = fixture(t);
  const imported = await post(destination.app, "/api/dm/campaigns/import", exported.json());
  assert.equal(imported.statusCode, 201);
  const importedCampaign = imported.json().campaign;
  const importedSession1 = destination.database.listSessions(importedCampaign.id)[0];
  const importedCharacter = destination.database.listCharactersByCampaign(importedCampaign.id)[0];
  assert.equal(importedSession1.name, "Session 1");
  assert.equal(importedSession1.status, "ended");
  const historicalPlayer = destination.database.listPlayersByCampaign(importedCampaign.id)
    .find((player) => player.sessionId === importedSession1.id);
  assert.equal(historicalPlayer.displayName, "Player A");
  assert.equal(historicalPlayer.characterId, importedCharacter.id);
  assert.equal((await post(destination.app, "/api/dm/sessions/" + importedSession1.id + "/start", {
    expectedActiveSessionId: null
  })).statusCode, 409);

  const session2 = (await post(destination.app, "/api/dm/campaigns/" + importedCampaign.id + "/sessions", {
    name: "Session 2"
  })).json().session;
  assert.equal((await post(destination.app, "/api/dm/sessions/" + session2.id + "/start", {
    expectedActiveSessionId: null
  })).statusCode, 200);
  const newToken = "F".repeat(43);
  const reconnect = await post(destination.app, "/api/join/" + session2.joinToken + "/request", {
    displayName: "Player A", playerToken: newToken
  });
  assert.equal(reconnect.statusCode, 200);
  const newPlayer = destination.database.listPlayersByCampaign(importedCampaign.id)
    .find((player) => player.sessionId === session2.id);
  assert.equal(newPlayer.displayName, historicalPlayer.displayName);
  assert.equal(newPlayer.status, "pending");
  assert.equal(newPlayer.characterId, null);
  assert.equal((await post(destination.app, "/api/dm/players/" + newPlayer.id + "/approve", {
    characterId: importedCharacter.id
  })).statusCode, 200);

  const history = destination.database.listPlayersByCampaign(importedCampaign.id);
  assert.equal(history.find((player) => player.sessionId === importedSession1.id).characterId, importedCharacter.id);
  assert.equal(history.find((player) => player.sessionId === session2.id).characterId, importedCharacter.id);
  assert.equal(destination.database.getSession(importedSession1.id).status, "ended");
  assert.equal(destination.database.getSession(session2.id).status, "active");
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
