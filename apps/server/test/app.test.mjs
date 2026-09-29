import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "@progdm/database";
import { createApp } from "../dist/app.js";

const dmToken = "test-dm-token";
const headers = { authorization: "Bearer " + dmToken };
function fixture(t) {
  const database = openDatabase({ file: ":memory:" });
  const app = createApp({ database, dmToken });
  t.after(() => app.close());
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
  assert.deepEqual((await get(app, "/api/dm/state")).json(), { campaigns: [], sessions: [], current: null });
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
