import assert from "node:assert/strict";
import test from "node:test";
import { componentRuntime, elements, loadTs, memoryStorage, setGlobal } from "./helpers/runtime.mjs";

const api = loadTs(new URL("../src/player/api.ts", import.meta.url));
const { InventoryIntents } = loadTs(new URL("../src/player/inventory-intents.ts", import.meta.url), { "./api": api });
const state = (overrides = {}) => ({ displayName: "A", status: "approved", campaignName: "Campaign", sessionName: "S1",
  characterId: "mira", characterName: "Mira", canEdit: true, profile: null, inventoryCapacity: 12,
  inventory: [], knowledge: [], notes: [], recentActivity: [], newActivity: [], ...overrides });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const unreadable = (status, error) => ({ ok: status >= 200 && status < 300, status, json: async () => { throw error; } });

test("successful Player body read failure rejects safely and the next request recovers", async (t) => {
  let fail = true;
  t.mock.method(globalThis, "fetch", async () => fail
    ? unreadable(200, new TypeError("terminated with internal details")) : json(state()));
  await assert.rejects(api.playerRequest("/api/player/me", {}, 50), (error) => {
    assert.ok(error instanceof api.PlayerNetworkError);
    assert.equal(error.message, "Нет связи с сервером. Попробуйте ещё раз."); return true;
  });
  fail = false;
  assert.deepEqual(await api.playerGet("credential", "/api/player/me"), state());
});

test("successful malformed JSON and invalid critical response shapes never become empty success", async (t) => {
  let response;
  t.mock.method(globalThis, "fetch", async () => response);
  response = new Response("{");
  await assert.rejects(api.playerRequest("/api/player/me"), api.PlayerResponseError);
  for (const path of ["/api/player/me", "/api/player/journal?limit=30", "/api/player/inventory/item/transfer-targets"]) {
    for (const body of [{}, null, [], 1]) {
      response = json(body);
      await assert.rejects(api.playerRequest(path), api.PlayerResponseError);
    }
  }
  response = json({ targets: [null] });
  await assert.rejects(api.playerRequest("/api/player/inventory/item/transfer-targets"), api.PlayerResponseError);
  response = json({ events: [], nextCursor: {} });
  await assert.rejects(api.playerRequest("/api/player/journal"), api.PlayerResponseError);
});

test("unreadable non-2xx bodies preserve HTTP status including abort while reading an error", async (t) => {
  let response;
  t.mock.method(globalThis, "fetch", async () => response);
  for (const status of [400, 401, 403, 409, 500]) {
    for (const failure of [new TypeError("terminated"), new SyntaxError("bad JSON"), new DOMException("abort", "AbortError")]) {
      response = unreadable(status, failure);
      await assert.rejects(api.playerRequest("/api/player/me"), (error) => {
        assert.ok(error instanceof api.PlayerApiError); assert.equal(error.status, status);
        assert.equal(error.message, "Не удалось выполнить запрос."); return true;
      });
    }
  }
});

test("normal Player state, Journal, transfer targets and mutation JSON remain unchanged", async (t) => {
  let response;
  t.mock.method(globalThis, "fetch", async () => response);
  const target = { characterId: "rowan", characterName: "Rowan", bagSlotsUsed: 1, inventoryCapacity: 12, willMerge: false, maxQuantity: 1 };
  for (const [path, body] of [["/api/player/me", state()], ["/api/player/journal", { events: [], nextCursor: null }],
    ["/api/player/inventory/item/transfer-targets", { targets: [target] }], ["/api/player/profile", { saved: true }]]) {
    response = json(body); assert.deepEqual(await api.playerRequest(path), body);
  }
});

test("a 2xx mutation body failure preserves the inventory operation ID for retry", async (t) => {
  let response = unreadable(200, new TypeError("terminated"));
  t.mock.method(globalThis, "fetch", async () => response);
  const registry = new InventoryIntents("credential", memoryStorage());
  const intent = { type: "discard", inventoryItemId: "item", quantity: 1 }, id = registry.getOrCreate(intent);
  const send = (operationId) => api.playerPost("credential", "/api/player/inventory/item/discard", { quantity: 1, operationId });
  await assert.rejects(registry.execute(intent, send, async () => {}), api.PlayerNetworkError);
  assert.equal(registry.pending()[0].operationId, id);
  response = json({ replayed: true }); await registry.execute(intent, send, async () => {});
  assert.deepEqual(registry.pending(), []);
});

test("actual transfer sheet handles unreadable targets without rendering undefined or crashing", async (t) => {
  setGlobal(t, "localStorage", memoryStorage());
  setGlobal(t, "window", { scrollTo() {}, addEventListener() {}, removeEventListener() {} });
  t.mock.method(globalThis, "fetch", async () => unreadable(200, new TypeError("terminated")));
  const item = { id: "item", catalogItemId: "catalog", name: "Torch", category: "tool", description: "Torch",
    rarity: null, quantity: 1, equippedSlot: null, equipmentSlot: "tool", transferAllowed: true, discardAllowed: true };
  const workspace = componentRuntime();
  const { PlayerWorkspace } = loadTs(new URL("../src/player/PlayerWorkspace.tsx", import.meta.url), { react: workspace.react, "./api": api });
  workspace.mount(PlayerWorkspace, { player: state({ inventory: [item] }), credential: "credential", refresh: async () => {} });
  workspace.tree.props.onNavigate("inventory"); workspace.render();
  const inventory = elements(workspace.tree, (node) => node.type?.name === "InventoryPage")[0];
  const runtime = componentRuntime();
  const { InventoryPage } = loadTs(new URL("../src/player/InventoryPage.tsx", import.meta.url), { react: runtime.react });
  runtime.mount(InventoryPage, inventory.props);
  elements(runtime.tree, (node) => node.type?.name === "InventoryCell")[0].props.onSelect(); runtime.render();
  await elements(runtime.tree, (node) => node.type?.name === "ItemDetails")[0].props.onTransfer(); runtime.render();
  const transfer = elements(runtime.tree, (node) => node.type?.name === "TransferDetails")[0];
  assert.deepEqual(transfer.props.targets, []); assert.equal(transfer.props.loading, false);
  assert.match(transfer.props.error, /Нет связи/);
  assert.doesNotThrow(() => transfer.type(transfer.props));
  runtime.unmount(); workspace.unmount();
});

async function dmRuntime(t) {
  let runtime;
  const allRequests = [];
  t.after(() => {
    runtime?.unmount();
    for (const request of allRequests) request.resolve(json({}));
  });
  const storage = memoryStorage(); storage.setItem("progdm.dmToken", "original-key");
  setGlobal(t, "localStorage", storage);
  const intervals = new Map(); let intervalId = 0;
  setGlobal(t, "window", { location: { pathname: "/", search: "", hash: "", hostname: "localhost" }, setTimeout,
    setInterval(callback, delay) { assert.equal(delay, 3000); intervals.set(++intervalId, callback); return intervalId; }, clearInterval(id) { intervals.delete(id); } });
  const requests = [];
  t.mock.method(globalThis, "fetch", (path, init) => new Promise((resolve) => {
    const request = { path, init, resolve }; requests.push(request); allRequests.push(request);
  }));
  runtime = componentRuntime();
  const { App } = loadTs(new URL("../src/App.tsx", import.meta.url), { react: runtime.react });
  runtime.mount(App().type, {});
  const tick = () => { for (const callback of intervals.values()) callback(); runtime.render(); };
  const take = () => requests.splice(0);
  const dmState = (name) => ({ campaigns: [{ id: "campaign", name }], sessions: [], current: null, players: [], characters: [],
    profileFields: [], itemCatalog: [], knowledge: [], activity: [], networkAddresses: [] });
  const complete = async (batch, name, status = 200) => {
    for (const call of batch) call.resolve(json(status !== 200 ? { message: "Нужен ключ ведущего." }
      : call.path === "/api/dm/backups" ? { backups: [] } : dmState(name), status));
    await runtime.settle();
  };
  return { runtime, tick, take, complete, storage };
}

test("DM global slow success applies after a 3s tick, serializes batches and permits later polling", async (t) => {
  const dm = await dmRuntime(t);
  const initial = dm.take(); assert.equal(initial.length, 2);
  // Tick at t=3s; complete at t=4s. Deferred promises avoid wall-clock-dependent sleeps.
  dm.tick(); assert.equal(dm.take().length, 0);
  await dm.complete(initial, "Initial slow response");
  assert.match(JSON.stringify(dm.runtime.tree), /Initial slow response/);
  dm.tick(); const next = dm.take(); assert.equal(next.length, 2);
  dm.tick(); dm.tick(); assert.equal(dm.take().length, 0);
  await dm.complete(next, "Next slow response");
  assert.match(JSON.stringify(dm.runtime.tree), /Next slow response/);
  dm.tick(); assert.equal(dm.take().length, 2);
});

test("DM token change invalidates old responses without letting their finally release a new batch", async (t) => {
  const dm = await dmRuntime(t), old = dm.take();
  await dm.complete(old, "Initial");
  dm.tick(); const stale = dm.take();
  elements(dm.runtime.tree, (node) => node.type === "button" && node.props["aria-label"] === "Выйти")[0].props.onClick(); dm.runtime.render();
  const input = elements(dm.runtime.tree, (node) => node.type === "input")[0];
  input.props.onChange({ target: { value: "new-key" } }); dm.runtime.render();
  elements(dm.runtime.tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} }); dm.runtime.render();
  const current = dm.take(); assert.equal(current.length, 2);
  assert.ok(current.every(({ init }) => init.headers.Authorization === "Bearer new-key"));
  await dm.complete(stale, "Must not apply");
  dm.tick(); assert.equal(dm.take().length, 0);
  assert.doesNotMatch(JSON.stringify(dm.runtime.tree), /Must not apply/);
  await dm.complete(current, "New key state");
  assert.match(JSON.stringify(dm.runtime.tree), /New key state/);
});

for (const completion of ["during mutation", "after refresh"]) test(`DM mutation ignores stale background completion ${completion}`, async (t) => {
  const dm = await dmRuntime(t); await dm.complete(dm.take(), "Initial");
  dm.tick(); const stale = dm.take();
  elements(dm.runtime.tree, (node) => node.type === "button" && node.props["aria-label"] === "Новая кампания")[0].props.onClick(); dm.runtime.render();
  const name = elements(dm.runtime.tree, (node) => node.type === "input" && node.props.id === "campaign-name")[0];
  name.props.onChange({ target: { value: "Created" } }); dm.runtime.render();
  const form = elements(dm.runtime.tree, (node) => node.type === "form" && node.props.children)[0];
  form.props.onSubmit({ preventDefault() {} }); dm.runtime.render();
  const mutation = dm.take(); assert.equal(mutation.length, 1); assert.equal(mutation[0].init.method, "POST");
  if (completion === "during mutation") {
    await dm.complete(stale, "Stale background");
    assert.doesNotMatch(JSON.stringify(dm.runtime.tree), /Stale background/);
  }
  mutation[0].resolve(json({ campaign: { id: "campaign", name: "Created" } })); await dm.runtime.settle();
  const after = dm.take(); assert.equal(after.length, 2);
  dm.tick(); assert.equal(dm.take().length, 0);
  await dm.complete(after, "Post mutation");
  if (completion === "after refresh") await dm.complete(stale, "Stale background");
  assert.doesNotMatch(JSON.stringify(dm.runtime.tree), /Stale background/);
  assert.match(JSON.stringify(dm.runtime.tree), /Post mutation/);
});

test("DM current 401 clears the key", async (t) => {
  const dm = await dmRuntime(t); await dm.complete(dm.take(), "", 401);
  assert.equal(dm.storage.getItem("progdm.dmToken"), null);
  assert.match(JSON.stringify(dm.runtime.tree), /Доступ ведущего/);
  assert.equal(elements(dm.runtime.tree, (node) => node.props?.id === "dm-key").length, 1);
});

test("DM responses after unmount are invalidated", async (t) => {
  const other = await dmRuntime(t), pending = other.take(), before = JSON.stringify(other.runtime.tree);
  other.runtime.unmount();
  for (const call of pending) call.resolve(json(call.path === "/api/dm/backups" ? { backups: [] } : { campaigns: [] }));
  await new Promise((done) => setImmediate(done));
  other.runtime.render();
  assert.equal(JSON.stringify(other.runtime.tree), before);
  assert.deepEqual(other.take(), []);
});

test("DM fast polling applies each response and resumes on every subsequent interval", async (t) => {
  const dm = await dmRuntime(t); await dm.complete(dm.take(), "Initial");
  for (let index = 0; index < 3; index++) {
    dm.tick(); const batch = dm.take(); assert.equal(batch.length, 2);
    await dm.complete(batch, `Fast response ${index}`);
    assert.match(JSON.stringify(dm.runtime.tree), new RegExp(`Fast response ${index}`));
  }
});
