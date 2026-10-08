import assert from "node:assert/strict";
import test from "node:test";
import { button, componentRuntime, elements, loadTs, memoryStorage, setGlobal } from "./helpers/runtime.mjs";

const api = loadTs(new URL("../src/player/api.ts", import.meta.url));
const { JoinIntent } = loadTs(new URL("../src/player/join-intent.ts", import.meta.url));
const { InventoryIntents } = loadTs(new URL("../src/player/inventory-intents.ts", import.meta.url), { "./api": api });
const downloads = loadTs(new URL("../src/dm-download.ts", import.meta.url));
const discard = { type: "discard", inventoryItemId: "item", quantity: 1 };
const transfer = { ...discard, type: "transfer", recipientCharacterId: "Rowan" };

test("Join intent persists before POST, survives ambiguous retry/reload and retains early 401", () => {
  const storage = memoryStorage();
  const first = new JoinIntent("session", storage);
  const token = first.begin(() => "original-token");
  assert.equal(first.retainUnauthorized(true), true);
  assert.equal(first.retainUnauthorized(false), true);
  const reload = new JoinIntent("session", storage);
  assert.equal(reload.begin(() => { throw new Error("must not regenerate"); }), token);
  assert.equal(new JoinIntent("another-session", storage).read(), "");
  reload.confirm(token);
  assert.equal(reload.retainUnauthorized(false), false);
  assert.equal(reload.read(), token);
  reload.clear("unrelated-token");
  assert.equal(reload.read(), token);
  reload.clear(token);
  assert.equal(reload.read(), "");
});

test("actual JoinPage keeps credential across response loss, polling 401 and remount", async (t) => {
  const storage = memoryStorage();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  setGlobal(t, "localStorage", storage);
  const intervals = [];
  setGlobal(t, "window", { setInterval: (callback) => { intervals.push(callback); return 1; }, clearInterval() {} });
  let postCount = 0;
  const posted = [];
  let playerReadable = false;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const playerRequest = async (path, init) => {
    if (init?.method === "POST") {
      postCount++; posted.push(JSON.parse(init.body).playerToken);
      if (postCount === 1) { await pending; throw new api.PlayerNetworkError(); }
      playerReadable = true;
      return {};
    }
    if (path === "/api/player/me") {
      if (!playerReadable) throw new api.PlayerApiError("not created yet", 401);
      return { status: "pending", displayName: "Mira" };
    }
    return { campaignName: "Campaign", sessionName: "Session" };
  };
  const mount = async () => {
    const runtime = componentRuntime();
    const { JoinPage } = loadTs(new URL("../src/JoinPage.tsx", import.meta.url), {
      react: runtime.react, "./player/api": { ...api, playerRequest }, "./player/PlayerWorkspace": {}
    });
    runtime.mount(JoinPage, { invite: "session" });
    await runtime.settle();
    return runtime;
  };
  let runtime = await mount();
  elements(runtime.tree, (node) => node.type === "input")[0].props.onChange({ target: { value: "Mira" } });
  runtime.render();
  elements(runtime.tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await runtime.settle();
  const token = storage.getItem("progdm.playerToken:session");
  assert.equal(typeof token, "string");
  assert.equal(token.length, 43);
  assert.equal(storage.getItem("progdm.playerJoinPending:session"), "1");
  release();
  await runtime.settle();
  intervals.at(-1)();
  await runtime.settle();
  assert.equal(storage.getItem("progdm.playerToken:session"), token, "ambiguous 401 cannot erase intent");
  runtime = await mount();
  elements(runtime.tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await runtime.settle();
  assert.deepEqual(posted, [token, token]);
  assert.equal(storage.getItem("progdm.playerJoinPending:session"), null);
  assert.match(JSON.stringify(runtime.tree), /Заявка отправлена/);
});

test("actual JoinPage clears a pending credential on a definite invalid invitation response", async (t) => {
  const storage = memoryStorage();
  storage.setItem("progdm.playerName:invalid", "Mira");
  setGlobal(t, "localStorage", storage);
  setGlobal(t, "window", { setInterval() { return 1; }, clearInterval() {} });
  const runtime = componentRuntime();
  const { JoinPage } = loadTs(new URL("../src/JoinPage.tsx", import.meta.url), {
    react: runtime.react, "./player/PlayerWorkspace": {}, "./player/api": { ...api, playerRequest: async (_path, init) => {
      if (init?.method === "POST") throw new api.PlayerApiError("Приглашение закрыто.", 404);
      return { campaignName: "Campaign", sessionName: "Session" };
    } }
  });
  runtime.mount(JoinPage, { invite: "invalid" }); await runtime.settle();
  elements(runtime.tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await runtime.settle();
  assert.equal(storage.getItem("progdm.playerToken:invalid"), null);
  assert.match(JSON.stringify(runtime.tree), /Ссылка недоступна/);
});

for (const intent of [discard, transfer]) {
  test(`ambiguous ${intent.type} survives remount/reload and replays one effect/activity`, async () => {
    const storage = memoryStorage();
    let quantity = 5;
    let activity = 0;
    const applied = new Set();
    let loseResponse = true;
    const send = async (id) => {
      if (!applied.has(id)) { applied.add(id); quantity--; activity++; }
      if (loseResponse) { loseResponse = false; throw new api.PlayerNetworkError(); }
    };
    const first = new InventoryIntents("token", storage);
    await assert.rejects(first.execute(intent, send, async () => {}), api.PlayerNetworkError);
    const id = first.getOrCreate(intent);
    const remount = new InventoryIntents("token", storage);
    assert.equal(remount.getOrCreate(intent), id);
    const reload = new InventoryIntents("token", storage);
    await reload.execute(intent, send, async () => {});
    assert.equal(quantity, 4);
    assert.equal(activity, 1);
    assert.deepEqual(JSON.parse(storage.getItem(reload.key)), []);
  });
}

test("Inventory registry distinguishes changed quantity, recipient, item and credential without evicting ambiguity", () => {
  const storage = memoryStorage();
  const registry = new InventoryIntents("token", storage);
  const ids = [registry.getOrCreate(transfer), registry.getOrCreate({ ...transfer, quantity: 2 }),
    registry.getOrCreate({ ...transfer, recipientCharacterId: "Victor" }), registry.getOrCreate({ ...transfer, inventoryItemId: "other" })];
  assert.equal(new Set(ids).size, 4);
  assert.notEqual(new InventoryIntents("other-token", storage).getOrCreate(transfer), ids[0]);
  for (let i = 4; i < 20; i++) registry.getOrCreate({ ...discard, inventoryItemId: String(i) });
  assert.throws(() => registry.getOrCreate({ ...discard, inventoryItemId: "overflow" }), /20/);
  assert.equal(registry.getOrCreate(transfer), ids[0]);
});

test("Inventory definite 4xx clears only its intent; 5xx/network/failed refresh preserve ID", async () => {
  const storage = memoryStorage();
  const registry = new InventoryIntents("token", storage);
  const other = registry.getOrCreate(transfer);
  const id = registry.getOrCreate(discard);
  for (const error of [new api.PlayerNetworkError(), new api.PlayerApiError("retry", 500), new api.PlayerApiError("timeout", 408)]) {
    await assert.rejects(registry.execute(discard, async () => { throw error; }, async () => {}));
    assert.equal(registry.getOrCreate(discard), id);
  }
  await assert.rejects(registry.execute(discard, async () => {}, async () => { throw new api.PlayerNetworkError(); }));
  assert.equal(registry.getOrCreate(discard), id);
  await assert.rejects(registry.execute(discard, async () => { throw new api.PlayerApiError("invalid", 400); }, async () => {}));
  assert.notEqual(registry.getOrCreate(discard), id);
  assert.equal(registry.getOrCreate(transfer), other);
});

test("Inventory storage failure/corruption fails closed before destructive HTTP request", async () => {
  const storage = memoryStorage();
  const registry = new InventoryIntents("token", storage);
  storage.setItem(registry.key, "broken JSON");
  let sends = 0;
  await assert.rejects(registry.execute(discard, async () => { sends++; }, async () => {}));
  assert.equal(sends, 0);
  const blocked = new InventoryIntents("token", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
  await assert.rejects(blocked.execute(discard, async () => { sends++; }, async () => {}));
  assert.equal(sends, 0);
});

test("actual workspace can replay a pending discard even when the original inventory row is already gone", async (t) => {
  const storage = memoryStorage(); setGlobal(t, "localStorage", storage);
  setGlobal(t, "window", { scrollTo() {} });
  const original = new InventoryIntents("token", storage).getOrCreate(discard);
  const ids = [];
  const runtime = componentRuntime();
  const { PlayerWorkspace } = loadTs(new URL("../src/player/PlayerWorkspace.tsx", import.meta.url), {
    react: runtime.react, "./api": { ...api, playerPost: async (_credential, _path, body) => { ids.push(body.operationId); return {}; } }
  });
  runtime.mount(PlayerWorkspace, { credential: "token", refresh: async () => {}, player: {
    canEdit: true, displayName: "Mira", characterName: "Mira", sessionName: "Session", inventory: [], notes: [], newActivity: []
  } });
  button(runtime.tree, "Проверить результат").props.onClick(); await runtime.settle();
  assert.deepEqual(ids, [original]);
  assert.equal(new InventoryIntents("token", storage).pending().length, 0);
});

for (const type of ["discard", "transfer"]) test(`actual InventoryPage and PlayerWorkspace replay ${type} across tab remount and workspace reload`, async (t) => {
  const storage = memoryStorage();
  setGlobal(t, "localStorage", storage);
  setGlobal(t, "window", { scrollTo() {}, addEventListener() {}, removeEventListener() {} });
  let quantity = 5;
  let loseResponse = true;
  const ids = [];
  const applied = new Set();
  const player = { displayName: "Mira", characterName: "Mira", sessionName: "Session", canEdit: true, notes: [], newActivity: [],
    inventoryCapacity: 12, inventory: [{ id: "item", name: "Аптечка", quantity: 5, equippedSlot: null, category: "consumable", discardAllowed: true }] };
  const workspaceApi = { ...api, playerGet: async () => ({ targets: [{ characterId: "Rowan", characterName: "Rowan", maxQuantity: 5,
    bagSlotsUsed: 1, inventoryCapacity: 12, willMerge: false }] }), playerPost: async (_credential, _path, body) => {
    ids.push(body.operationId);
    if (!applied.has(body.operationId)) { applied.add(body.operationId); quantity--; }
    if (loseResponse) { loseResponse = false; throw new api.PlayerNetworkError(); }
    return {};
  } };
  const workspace = () => {
    const runtime = componentRuntime();
    const { PlayerWorkspace } = loadTs(new URL("../src/player/PlayerWorkspace.tsx", import.meta.url), { react: runtime.react, "./api": workspaceApi });
    runtime.mount(PlayerWorkspace, { player, credential: "token", refresh: async () => {} });
    runtime.tree.props.onNavigate("inventory"); runtime.render();
    return runtime;
  };
  const submitFromPage = async (runtime) => {
    const pageProps = elements(runtime.tree, (node) => node.type?.name === "InventoryPage")[0].props;
    const pageRuntime = componentRuntime();
    const { InventoryPage } = loadTs(new URL("../src/player/InventoryPage.tsx", import.meta.url), { react: pageRuntime.react });
    pageRuntime.mount(InventoryPage, pageProps);
    elements(pageRuntime.tree, (node) => node.type?.name === "InventoryCell")[0].props.onSelect(); pageRuntime.render();
    const detail = elements(pageRuntime.tree, (node) => node.type?.name === "ItemDetails")[0];
    if (type === "discard") {
      detail.props.onDiscard(); pageRuntime.render();
      await elements(pageRuntime.tree, (node) => node.type?.name === "DiscardDetails")[0].props.onSubmit();
    } else {
      await detail.props.onTransfer(); pageRuntime.render();
      elements(pageRuntime.tree, (node) => node.type?.name === "TransferDetails")[0].props.onSelectRecipient("Rowan");
      pageRuntime.render();
      await elements(pageRuntime.tree, (node) => node.type?.name === "TransferDetails")[0].props.onSubmit();
    }
  };
  let runtime = workspace();
  await submitFromPage(runtime);
  runtime.tree.props.onNavigate("journal"); runtime.render();
  runtime.tree.props.onNavigate("inventory"); runtime.render();
  runtime = workspace();
  await submitFromPage(runtime);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(quantity, 4);
});

for (const stage of ["headers", "body"]) {
  test(`DM download aborts hanging ${stage}, releases caller busy and can retry`, async (t) => {
    let signal;
    t.mock.method(globalThis, "fetch", async (_path, init) => {
      signal = init.signal;
      if (stage === "headers") return new Promise(() => {});
      return { ok: true, blob: () => new Promise(() => {}) };
    });
    let busy = false;
    const mutate = async () => {
      busy = true;
      try { await downloads.downloadFile("key", "/backup", "backup.db", 5); }
      finally { busy = false; }
    };
    await assert.rejects(mutate(), downloads.DownloadNetworkError);
    assert.equal(busy, false);
    assert.equal(signal.aborted, true);
    let clicked = 0;
    t.mock.method(globalThis, "fetch", async () => new Response("data"));
    setGlobal(t, "document", { createElement: () => ({ click() { clicked++; } }) });
    await mutate();
    assert.equal(clicked, 1);
    assert.equal(busy, false);
  });
}

test("DM download preserves safe API errors rather than converting them to network errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: "Копия не найдена." }), { status: 404 }));
  await assert.rejects(downloads.downloadFile("key", "/backup", "backup.db", 100), (error) =>
    error instanceof downloads.ApiError && error.status === 404 && error.message === "Копия не найдена.");
});

test("actual DM workspace releases busy after download timeout and retries the created backup without another POST", async (t) => {
  const storage = memoryStorage(); storage.setItem("progdm.dmToken", "dm-key");
  setGlobal(t, "localStorage", storage);
  setGlobal(t, "window", { location: { pathname: "/", hash: "", search: "", hostname: "localhost", port: "5173" },
    setTimeout, setInterval() { return 1; }, clearInterval() {} });
  let clicks = 0;
  setGlobal(t, "document", { createElement: () => ({ click() { clicks++; } }) });
  let backupCreates = 0;
  let loseResponse = true;
  const saved = [];
  const state = { campaigns: [{ id: "campaign", name: "Campaign" }], sessions: [], current: null, players: [], characters: [],
    profileFields: [], itemCatalog: [], knowledge: [], activity: [], networkAddresses: [] };
  t.mock.method(globalThis, "fetch", async (path, init) => {
    if (path.endsWith("/download")) {
      if (loseResponse) { loseResponse = false; return new Promise(() => {}); }
      return new Response("backup");
    }
    if (path === "/api/dm/backups" && init.method === "POST") {
      backupCreates++;
      const backup = { id: "backup", createdAt: "2026-10-08T12:00:00.000Z", size: 1024 }; saved.push(backup);
      return new Response(JSON.stringify({ backup }));
    }
    return new Response(JSON.stringify(path === "/api/dm/state" ? state : { backups: saved }));
  });
  const runtime = componentRuntime();
  const { App } = loadTs(new URL("../src/App.tsx", import.meta.url), {
    react: runtime.react,
    "./dm-download": { ...downloads, downloadFile: (token, path, filename) => downloads.downloadFile(token, path, filename, 5) }
  });
  const dm = App().type;
  runtime.mount(dm, {}); await runtime.settle();
  button(runtime.tree, "Данные").props.onClick(); runtime.render();
  button(runtime.tree, "Создать копию и скачать базу").props.onClick();
  await new Promise((done) => setTimeout(done, 20)); await runtime.settle();
  const retry = elements(runtime.tree, (node) => node.type === "button" && node.props["aria-label"] === "Скачать выбранную копию")[0];
  assert.equal(retry.props.disabled, false, "busy and phase allow retry after timeout");
  assert.equal(backupCreates, 1);
  retry.props.onClick(); await runtime.settle();
  assert.equal(backupCreates, 1);
  assert.equal(clicks, 1);
});
