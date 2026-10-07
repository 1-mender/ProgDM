import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
function patch(app, url, payload = {}) { return app.inject({ method: "PATCH", url, headers, payload }); }

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

test("full-bag grants return a conflict without changing the inventory", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Capacity");
  const character = database.createCharacter(campaign.id, "Mira");
  const item = database.createCatalogItem(campaign.id, "Key");
  database.updateCharacterInventoryCapacity(character.id, 0);
  const session = database.createSession(campaign.id, "Session");
  database.activateSession(session.id);
  const player = database.submitPlayerRequest(session.id, "A", "capacity-api-token");
  database.approvePlayer(player.id, { characterId: character.id });

  const fullBag = await post(app, `/api/dm/characters/${character.id}/items`, { catalogItemId: item.id, quantity: 1 });
  assert.equal(fullBag.statusCode, 409);
  assert.equal(fullBag.json().message, "В сумке персонажа нет свободных слотов.");
  assert.deepEqual(database.listCharacterInventory(character.id), []);
});

test("Player equip and unequip use the active Character, enforce domain rules, and persist for historical reads", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Player equipment");
  const mira = database.createCharacter(campaign.id, "Mira");
  const rowan = database.createCharacter(campaign.id, "Rowan");
  const session1 = database.createSession(campaign.id, "First");
  database.activateSession(session1.id);
  const tokenA = "G".repeat(43);
  const tokenPending = "H".repeat(43);
  const tokenRejected = "I".repeat(43);
  for (const [name, token] of [["Mira player", tokenA], ["Pending", tokenPending], ["Rejected", tokenRejected]]) {
    await post(app, `/api/join/${session1.joinToken}/request`, { displayName: name, playerToken: token });
  }
  const players = database.listPlayersByCampaign(campaign.id).filter((entry) => entry.sessionId === session1.id);
  database.approvePlayer(players.find((entry) => entry.displayName === "Mira player").id, { characterId: mira.id });
  database.rejectPlayer(players.find((entry) => entry.displayName === "Rejected").id);

  const sword = database.createCatalogItem(campaign.id, "Охотничий нож");
  const duplicateSword = database.createCatalogItem(campaign.id, "Второй нож");
  const ring = database.createCatalogItem(campaign.id, "Амулет");
  const shield = database.createCatalogItem(campaign.id, "Куртка");
  const stackItem = database.createCatalogItem(campaign.id, "Аптечка");
  const book = database.createCatalogItem(campaign.id, "Записная книжка");
  for (const [item, slot, category] of [[sword, "primary", "equipment"], [duplicateSword, "primary", "equipment"],
    [ring, "accessory", "artifact"], [shield, "armor", "equipment"], [stackItem, "secondary", "consumable"], [book, null, "document"]]) {
    database.updateCatalogItemMetadata(item.id, { description: `Описание: ${item.name}`, equipmentSlot: slot, category, rarity: item === ring ? "rare" : null });
  }
  const swordRow = database.grantInventoryItem(mira.id, sword.id, 1);
  const duplicateRow = database.grantInventoryItem(mira.id, duplicateSword.id, 1);
  const ringRow = database.grantInventoryItem(mira.id, ring.id, 1);
  const shieldRow = database.grantInventoryItem(mira.id, shield.id, 1);
  const stackRow = database.grantInventoryItem(mira.id, stackItem.id, 2);
  const bookRow = database.grantInventoryItem(mira.id, book.id, 1);
  const api = (token, itemId, action, payload = {}) => app.inject({ method: "POST", url: `/api/player/inventory/${itemId}/${action}`,
    headers: { authorization: `Bearer ${token}` }, payload });
  const read = (token) => app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${token}` } });

  const initial = (await read(tokenA)).json();
  assert.equal(initial.inventoryCapacity, 12);
  assert.equal(initial.inventory.find((item) => item.id === swordRow.id).description, "Описание: Охотничий нож");
  assert.equal(initial.inventory.find((item) => item.id === ringRow.id).rarity, "rare");
  assert.equal(initial.inventory.find((item) => item.id === stackRow.id).equipmentSlot, "secondary");
  assert.equal(initial.inventory.find((item) => item.id === bookRow.id).rarity, null);
  assert.equal("dmNotes" in initial, false);
  assert.equal("dmNotes" in initial.profile, false);
  assert.deepEqual(Object.keys(initial.inventory[0]).sort(), ["catalogItemId", "category", "createdAt", "description", "discardAllowed", "equipmentSlot", "equippedSlot", "id", "name", "quantity", "rarity", "transferAllowed"].sort());

  assert.equal((await api(tokenA, "not-a-uuid", "equip")).statusCode, 400);
  assert.equal((await api(tokenA, swordRow.id, "equip", { characterId: mira.id })).statusCode, 400);
  const otherCharacterItem = database.grantInventoryItem(rowan.id, book.id, 1);
  const inaccessible = await api(tokenA, otherCharacterItem.id, "equip");
  assert.equal(inaccessible.statusCode, 404);
  assert.equal(inaccessible.json().message, "Предмет недоступен.");
  for (const token of [tokenPending, tokenRejected]) {
    const restricted = (await read(token)).json();
    assert.deepEqual(restricted.inventory, []);
    assert.equal(restricted.inventoryCapacity, null);
    assert.equal(restricted.canEdit, false);
    const denied = await api(token, swordRow.id, "equip");
    assert.equal(denied.statusCode, 403, `${token === tokenPending ? "pending" : "rejected"}: ${denied.body}`);
    assert.equal(denied.json().message.includes("SQLite"), false);
  }
  assert.equal((await api(tokenA, stackRow.id, "equip")).statusCode, 409);
  assert.equal((await api(tokenA, bookRow.id, "equip")).statusCode, 409);

  const activityBefore = database.listCampaignActivity(campaign.id).length;
  const equipped = await api(tokenA, swordRow.id, "equip");
  assert.equal(equipped.statusCode, 200);
  assert.equal(equipped.json().item.equippedSlot, "primary");
  assert.equal((await read(tokenA)).json().inventoryCapacity, 12);
  assert.equal((await read(tokenA)).json().inventory.filter((item) => item.equippedSlot === null).length, 5);
  const occupied = await api(tokenA, duplicateRow.id, "equip");
  assert.equal(occupied.statusCode, 409);
  assert.equal(occupied.json().message, "Слот «Основное» уже занят. Сначала снимите текущий предмет.");
  assert.equal((await api(tokenA, swordRow.id, "equip")).json().message, "Предмет уже экипирован.");
  assert.equal((await api(tokenA, swordRow.id, "unequip")).statusCode, 200);
  assert.equal(database.listCampaignActivity(campaign.id).length, activityBefore, "equipment mutations do not append activity");

  database.equipInventoryItem(mira.id, swordRow.id);
  database.equipInventoryItem(mira.id, ringRow.id);
  database.equipInventoryItem(mira.id, shieldRow.id);
  database.grantInventoryItem(mira.id, ring.id, 2);
  const ringBagStack = database.listCharacterInventory(mira.id).find((item) => item.catalogItemId === ring.id && item.equippedSlot === null);
  const map = database.createCatalogItem(campaign.id, "Карта");
  const torch = database.createCatalogItem(campaign.id, "Фонарь");
  database.grantInventoryItem(mira.id, map.id, 1);
  database.grantInventoryItem(mira.id, torch.id, 1);
  database.grantInventoryItem(mira.id, duplicateSword.id, 1);
  database.updateCharacterInventoryCapacity(mira.id, 6);
  const full = await api(tokenA, shieldRow.id, "unequip");
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().message, "Сумка заполнена. Освободите место перед снятием предмета.");
  const merged = await api(tokenA, ringRow.id, "unequip");
  assert.equal(merged.statusCode, 200);
  assert.equal(merged.json().item.id, ringBagStack.id);
  assert.equal(merged.json().item.quantity, 3);
  assert.equal(database.listCharacterInventory(mira.id).some((item) => item.id === ringRow.id), false);
  assert.equal((await api(tokenA, ringRow.id, "unequip")).statusCode, 404, "stale item ID cannot target a different row");
  assert.equal((await read(tokenA)).json().inventoryCapacity, 6);
  database.updateCharacterInventoryCapacity(mira.id, 7);

  await post(app, `/api/dm/sessions/${session1.id}/end`);
  const session2 = database.createSession(campaign.id, "Second");
  database.activateSession(session2.id);
  const tokenB = "J".repeat(43);
  await post(app, `/api/join/${session2.joinToken}/request`, { displayName: "Mira player B", playerToken: tokenB });
  const playerB = database.listPlayersByCampaign(campaign.id).find((entry) => entry.sessionId === session2.id);
  database.approvePlayer(playerB.id, { characterId: mira.id });
  const historicalState = (await read(tokenA)).json();
  assert.equal(historicalState.canEdit, false);
  assert.equal(historicalState.inventoryCapacity, 7);
  assert.equal(historicalState.inventory.find((item) => item.id === swordRow.id).equippedSlot, "primary");
  assert.equal((await api(tokenA, swordRow.id, "unequip")).statusCode, 403);
  assert.equal((await api(tokenB, swordRow.id, "unequip")).statusCode, 200);
  const afterUnequip = (await read(tokenB)).json();
  assert.equal(afterUnequip.inventory.some((item) => item.id === swordRow.id && item.equippedSlot === null), true);
  assert.equal((await read(tokenA)).json().inventory.some((item) => item.id === swordRow.id && item.equippedSlot === null), true,
    "historical reads reflect persistent Character equipment changes");
  assert.equal(database.listCampaignActivity(campaign.id).filter((event) => ["item_equipped", "item_unequipped"].includes(event.type)).length, 0);
});

test("legacy Player inventory rows remain visible and cannot be equipped", async (t) => {
  const { app, database } = fixture(t);
  const source = database.createCampaign("Legacy source");
  const sourceCharacter = database.createCharacter(source.id, "Old hero");
  const catalog = database.createCatalogItem(source.id, "Imported old item");
  database.grantInventoryItem(sourceCharacter.id, catalog.id, 3);
  const archive = database.exportCampaign(source.id);
  archive.inventoryItems[0].catalogItemId = null;
  const campaign = database.importCampaign(archive);
  const character = database.listCharactersByCampaign(campaign.id)[0];
  const session = database.createSession(campaign.id, "New session");
  database.activateSession(session.id);
  const token = "K".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "New controller", playerToken: token });
  const player = database.listPlayersByCampaign(campaign.id)[0];
  database.approvePlayer(player.id, { characterId: character.id });
  const state = await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(state.statusCode, 200);
  assert.deepEqual({ catalogItemId: state.json().inventory[0].catalogItemId, name: state.json().inventory[0].name,
    quantity: state.json().inventory[0].quantity, description: state.json().inventory[0].description,
    category: state.json().inventory[0].category, rarity: state.json().inventory[0].rarity,
    equipmentSlot: state.json().inventory[0].equipmentSlot }, {
    catalogItemId: null, name: "Imported old item", quantity: 3, description: "", category: "special",
    rarity: null, equipmentSlot: null
  });
  const result = await app.inject({ method: "POST", url: `/api/player/inventory/${state.json().inventory[0].id}/equip`,
    headers: { authorization: `Bearer ${token}` }, payload: {} });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().message, "Этот предмет нельзя экипировать.");
});

test("Player transfer/discard endpoints validate strict bodies, enforce active control, and replay safely", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Inventory actions API");
  const mira = database.createCharacter(campaign.id, "Mira");
  const rowan = database.createCharacter(campaign.id, "Rowan");
  const unassigned = database.createCharacter(campaign.id, "Not assigned");
  const session = database.createSession(campaign.id, "Active");
  database.activateSession(session.id);
  const tokenA = "L".repeat(43);
  const tokenB = "M".repeat(43);
  const pendingToken = "N".repeat(43);
  const hash = (token) => createHash("sha256").update(token).digest("hex");
  const playerA = database.submitPlayerRequest(session.id, "Mira", hash(tokenA));
  const playerB = database.submitPlayerRequest(session.id, "Rowan", hash(tokenB));
  database.approvePlayer(playerA.id, { characterId: mira.id });
  database.approvePlayer(playerB.id, { characterId: rowan.id });
  const pending = database.submitPlayerRequest(session.id, "Pending", hash(pendingToken));
  const catalog = database.createCatalogItem(campaign.id, "Compass");
  const item = database.grantInventoryItem(mira.id, catalog.id, 5);
  const call = (token, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const targetsResponse = await call(tokenA, "GET", `/api/player/inventory/${item.id}/transfer-targets`);
  assert.equal(targetsResponse.statusCode, 200);
  assert.deepEqual(targetsResponse.json().targets.map(({ characterId, characterName, bagSlotsUsed, inventoryCapacity, willMerge, maxQuantity, playerId }) => ({
    characterId, characterName, bagSlotsUsed, inventoryCapacity, willMerge, maxQuantity, playerId
  })), [{ characterId: rowan.id, characterName: "Rowan", bagSlotsUsed: 0, inventoryCapacity: 12, willMerge: false, maxQuantity: 9999, playerId: undefined }]);
  assert.equal(targetsResponse.body.includes(playerA.id), false);
  assert.equal(targetsResponse.body.includes(playerB.id), false);
  assert.equal(targetsResponse.json().targets.some((target) => target.characterId === unassigned.id), false);

  const operationId = randomUUID();
  const transfer = { recipientCharacterId: rowan.id, quantity: 2, operationId };
  assert.equal((await call(tokenA, "POST", `/api/player/inventory/${item.id}/transfer`, { ...transfer, senderCharacterId: mira.id })).statusCode, 400);
  assert.equal((await call(tokenA, "POST", `/api/player/inventory/${item.id}/transfer`, transfer)).statusCode, 200);
  assert.equal((await call(tokenA, "POST", `/api/player/inventory/${item.id}/transfer`, transfer)).statusCode, 200, "same operation replays as success");
  assert.equal(database.listCharacterInventory(mira.id).find((row) => row.id === item.id).quantity, 3);
  assert.equal(database.listCharacterInventory(rowan.id).find((row) => row.catalogItemId === catalog.id).quantity, 2);
  const conflict = await call(tokenA, "POST", `/api/player/inventory/${item.id}/transfer`, { ...transfer, quantity: 1 });
  assert.equal(conflict.statusCode, 409);
  assert.doesNotMatch(conflict.body, /SQLITE|constraint|operation_id/i);

  const discard = { quantity: 1, operationId: randomUUID() };
  assert.equal((await call(pendingToken, "POST", `/api/player/inventory/${item.id}/discard`, discard)).statusCode, 403);
  assert.equal((await call(tokenA, "POST", `/api/player/inventory/${item.id}/discard`, { ...discard, characterId: mira.id })).statusCode, 400);
  assert.equal((await call(tokenA, "POST", `/api/player/inventory/${item.id}/discard`, discard)).statusCode, 200);
  assert.equal((await call(tokenA, "POST", `/api/player/inventory/${item.id}/discard`, discard)).statusCode, 200);
  assert.equal(database.listCharacterInventory(mira.id).find((row) => row.id === item.id).quantity, 2);

  database.updateCatalogItemMetadata(catalog.id, { transferAllowed: false });
  assert.equal((await call(tokenA, "GET", `/api/player/inventory/${item.id}/transfer-targets`)).json().message, "Этот предмет нельзя передавать.");
  const transferDenied = await call(tokenA, "POST", `/api/player/inventory/${item.id}/transfer`, { ...transfer, operationId: randomUUID() });
  assert.equal(transferDenied.statusCode, 409);
  assert.equal(transferDenied.json().message, "Этот предмет нельзя передавать.");

  await post(app, `/api/dm/sessions/${session.id}/end`);
  const historical = await call(tokenA, "POST", `/api/player/inventory/${item.id}/discard`, { quantity: 1, operationId: randomUUID() });
  assert.equal(historical.statusCode, 403);
  assert.equal(database.listCharacterInventory(mira.id).find((row) => row.id === item.id).quantity, 2);
});

test("DM inventory grants target persistent non-archived characters in preparation and live sessions", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Inventory prep");
  const character = database.createCharacter(campaign.id, "Mira");
  const item = database.createCatalogItem(campaign.id, "Key");
  const secondCharacter = database.createCharacter(campaign.id, "Rowan");

  const prepGrant = await post(app, `/api/dm/characters/${character.id}/items`, { catalogItemId: item.id, quantity: 1 });
  assert.equal(prepGrant.statusCode, 201);
  assert.equal(database.getCharacterOverview(character.id).inventory.length, 1);
  assert.equal(database.listCampaignActivity(campaign.id).find((event) => event.type === "item_granted").sessionId, null);
  assert.equal((await post(app, `/api/dm/characters/${secondCharacter.id}/items`, { catalogItemId: item.id, quantity: 1 })).statusCode, 201,
    "a prepared character needs no Player assignment");

  const session = database.createSession(campaign.id, "Live");
  database.activateSession(session.id);
  const liveGrant = await post(app, `/api/dm/characters/${character.id}/items`, { catalogItemId: item.id, quantity: 2 });
  assert.equal(liveGrant.statusCode, 201);
  assert.equal(database.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted").at(-1).sessionId, session.id);

  database.updateCharacterInventoryCapacity(character.id, 1);
  const foreignCampaign = database.createCampaign("Other");
  const foreignItem = database.createCatalogItem(foreignCampaign.id, "Foreign");
  const eventsBeforeFailures = database.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted").length;
  assert.equal((await post(app, `/api/dm/characters/${character.id}/items`, { catalogItemId: item.id, quantity: 1 })).statusCode, 201,
    "same-catalog merge remains allowed when bag slots are full");
  const activityBeforeRejectedCapacity = database.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted").length;
  const newItem = database.createCatalogItem(campaign.id, "Map");
  assert.equal((await post(app, `/api/dm/characters/${character.id}/items`, { catalogItemId: newItem.id, quantity: 1 })).statusCode, 409);
  assert.equal(database.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted").length, activityBeforeRejectedCapacity);
  assert.equal((await post(app, `/api/dm/characters/${character.id}/items`, { catalogItemId: foreignItem.id, quantity: 1 })).statusCode, 409);
  const archived = database.createCharacter(campaign.id, "Archived");
  database.archiveCharacter(archived.id);
  assert.equal((await post(app, `/api/dm/characters/${archived.id}/items`, { catalogItemId: item.id, quantity: 1 })).statusCode, 409);
  assert.equal(database.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted").length, activityBeforeRejectedCapacity);
  assert.ok(eventsBeforeFailures < activityBeforeRejectedCapacity);
});

test("DM inventory foundation endpoints enforce auth, strict metadata and capacity conflicts", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Metadata");
  const character = database.createCharacter(campaign.id, "Mira");
  const catalog = database.createCatalogItem(campaign.id, "Lamp");
  const metadataPath = `/api/dm/catalog-items/${catalog.id}`;
  const capacityPath = `/api/dm/characters/${character.id}/inventory-capacity`;
  for (const [url, payload] of [[metadataPath, { category: "tool" }], [capacityPath, { inventoryCapacity: 8 }]]) {
    const denied = await app.inject({ method: "PATCH", url, payload });
    assert.equal(denied.statusCode, 401);
  }
  const metadata = await patch(app, metadataPath, {
    description: "Small brass lamp", category: "tool", rarity: "uncommon", equipmentSlot: "tool",
    transferAllowed: false, discardAllowed: true
  });
  assert.equal(metadata.statusCode, 200);
  assert.deepEqual({ description: metadata.json().item.description, category: metadata.json().item.category,
    rarity: metadata.json().item.rarity, equipmentSlot: metadata.json().item.equipmentSlot,
    transferAllowed: metadata.json().item.transferAllowed, discardAllowed: metadata.json().item.discardAllowed }, {
    description: "Small brass lamp", category: "tool", rarity: "uncommon", equipmentSlot: "tool",
    transferAllowed: false, discardAllowed: true
  });
  assert.equal((await patch(app, metadataPath, { description: "x", unexpected: true })).statusCode, 400);
  assert.equal((await patch(app, metadataPath, { rarity: "legendary" })).statusCode, 400);
  assert.equal((await patch(app, metadataPath, {})).statusCode, 400);
  assert.equal((await patch(app, "/api/dm/catalog-items/00000000-0000-4000-8000-000000000099", { description: "x" })).statusCode, 404);

  const equipped = database.grantInventoryItem(character.id, catalog.id, 1);
  database.equipInventoryItem(character.id, equipped.id);
  const conflict = await patch(app, metadataPath, { equipmentSlot: "armor" });
  assert.equal(conflict.statusCode, 409);
  assert.equal(database.listCatalogItemsByCampaign(campaign.id)[0].equipmentSlot, "tool");

  assert.equal((await patch(app, capacityPath, { inventoryCapacity: 12 })).statusCode, 200);
  assert.equal((await patch(app, capacityPath, { inventoryCapacity: 1, extra: true })).statusCode, 400);
  assert.equal((await patch(app, capacityPath, { inventoryCapacity: -1 })).statusCode, 400);
  const bagItem = database.createCatalogItem(campaign.id, "Notebook");
  database.grantInventoryItem(character.id, bagItem.id, 1);
  const capacityConflict = await patch(app, capacityPath, { inventoryCapacity: 0 });
  assert.equal(capacityConflict.statusCode, 409);
  assert.equal((await patch(app, "/api/dm/characters/00000000-0000-4000-8000-000000000099/inventory-capacity", { inventoryCapacity: 1 })).statusCode, 404);

  for (const path of [metadataPath, capacityPath]) {
    const playerRoute = await app.inject({ method: "PATCH", url: path.replace("/api/dm/", "/api/player/") });
    assert.equal(playerRoute.statusCode, 404, "foundation configuration has no Player route");
  }
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
    ["/api/player/profile", { shortDescription: "Invalid", personalGoal: "Invalid", traits: ["Invalid"], appearance: "Invalid", quote: "Invalid" }],
    ["/api/player/settings", { displayName: "Invalid" }],
    ["/api/player/notes", { title: "Invalid", body: "Invalid", marker: "check", pinned: true }],
    ["/api/player/notes/00000000-0000-4000-8000-000000000000", { title: "Invalid", marker: "important", pinned: true }],
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
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const note = database.createPersonalNote(tokenHash, "Historical note");
  database.endSession(session.id);
  await assertDenied();
  assert.equal((await app.inject({ method: "POST", url: `/api/player/notes/${note.id}`, headers: { authorization: "Bearer " + token }, payload: { pinned: true } })).statusCode, 403);
  const state = (await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: "Bearer " + token } })).json();
  assert.equal(state.status, "approved");
  assert.equal(state.canEdit, false);
  assert.equal(state.profile, null);
  assert.deepEqual(state.notes, []);
});

test("player Knowledge API serializes only visible summaries and granted Facts", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Player projection");
  const mira = database.createCharacter(campaign.id, "Mira");
  const rowan = database.createCharacter(campaign.id, "Rowan");
  const session = database.createSession(campaign.id, "Session Four");
  database.activateSession(session.id);
  const token = "P".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Mira player", playerToken: token });
  const player = database.listPlayersByCampaign(campaign.id)[0];
  database.approvePlayer(player.id, { characterId: mira.id });
  const partySummary = database.createKnowledge(campaign.id, "place", "Public place", "The public description.");
  database.setKnowledgeVisibility(partySummary.id, "party");
  const hiddenEntry = database.createKnowledge(campaign.id, "fact", "Fact-only entry", "API_HIDDEN_SUMMARY");
  const visibleFact = database.createKnowledgeFact(campaign.id, hiddenEntry.id, "API_VISIBLE_FACT");
  const hiddenFact = database.createKnowledgeFact(campaign.id, hiddenEntry.id, "API_UNREVEALED_FACT");
  database.revealKnowledgeFactToParty(campaign.id, hiddenEntry.id, visibleFact.id);
  const otherCharacterEntry = database.createKnowledge(campaign.id, "fact", "Other character entry", "OTHER_CHARACTER_SUMMARY");
  const otherCharacterFact = database.createKnowledgeFact(campaign.id, otherCharacterEntry.id, "OTHER_CHARACTER_FACT");
  database.revealKnowledgeFactToCharacter(campaign.id, otherCharacterEntry.id, otherCharacterFact.id, rowan.id);

  const response = await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  const serialized = response.body;
  const state = response.json();
  assert.deepEqual(state.knowledge.map(({ id }) => id), [partySummary.id, hiddenEntry.id]);
  assert.equal(state.knowledge[0].summary, "The public description.");
  assert.equal(state.knowledge[1].title, "Fact-only entry");
  assert.equal(state.knowledge[1].category, "fact");
  assert.equal(state.knowledge[1].summary, null);
  assert.equal(state.knowledge[1].summaryVisible, false);
  assert.deepEqual(state.knowledge[1].facts.map(({ body }) => body), ["API_VISIBLE_FACT"]);
  for (const secret of ["API_HIDDEN_SUMMARY", "API_UNREVEALED_FACT", "OTHER_CHARACTER_SUMMARY", "OTHER_CHARACTER_FACT", player.tokenHash]) {
    assert.equal(serialized.includes(secret), false, `Player API leaked ${secret}`);
  }
  for (const key of ["visibility", "visibleToCharacterId", "audience", "characterId", "operationId"]) {
    assert.equal(JSON.stringify(state.knowledge).includes(`\"${key}\"`), false, `Player Knowledge API leaked ${key}`);
  }
  assert.equal(state.knowledge[1].facts[0].sessionId, session.id);
  assert.equal(state.knowledge[1].facts[0].sessionName, "Session Four");
  assert.equal(state.knowledge[1].facts[0].revealedAt.length > 0, true);
  assert.equal((await app.inject({ method: "POST", url: `/api/player/knowledge-facts/${visibleFact.id}/reveal`,
    headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode, 404);

  database.endSession(session.id);
  const historical = await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(historical.statusCode, 200);
  assert.equal(historical.json().canEdit, false);
  assert.equal(historical.json().knowledge.find(({ id }) => id === hiddenEntry.id).facts[0].body, "API_VISIBLE_FACT");
});

test("serialized Player activity is safe and drops a hidden Entry title after its last revoke", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Safe activity");
  const mira = database.createCharacter(campaign.id, "Mira");
  const rowan = database.createCharacter(campaign.id, "Rowan");
  const session = database.createSession(campaign.id, "Chapter 2");
  database.activateSession(session.id);
  const token = "A".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Mira player", playerToken: token });
  const player = database.listPlayersByCampaign(campaign.id)[0];
  database.approvePlayer(player.id, { characterId: mira.id });
  const pendingToken = "B".repeat(43);
  const rejectedToken = "C".repeat(43);
  database.submitPlayerRequest(session.id, "Pending player", createHash("sha256").update(pendingToken).digest("hex"));
  const rejected = database.submitPlayerRequest(session.id, "Rejected player", createHash("sha256").update(rejectedToken).digest("hex"));
  database.rejectPlayer(rejected.id);

  const entry = database.createKnowledge(campaign.id, "fact", "Secret entry title", "SECRET_ENTRY_SUMMARY_BODY");
  const fact = database.createKnowledgeFact(campaign.id, entry.id, "SECRET_FACT_BODY");
  database.revealKnowledgeFactToCharacter(campaign.id, entry.id, fact.id, mira.id);
  const otherEntry = database.createKnowledge(campaign.id, "fact", "Other character title", "OTHER_SUMMARY_SECRET");
  const otherFact = database.createKnowledgeFact(campaign.id, otherEntry.id, "OTHER_FACT_SECRET");
  database.revealKnowledgeFactToCharacter(campaign.id, otherEntry.id, otherFact.id, rowan.id);

  const response = await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  const state = response.json();
  const serializedActivity = JSON.stringify({ recentActivity: state.recentActivity, newActivity: state.newActivity });
  assert.ok(state.recentActivity.some((event) => event.kind === "knowledge_facts_revealed" && event.knowledgeTitle === "Secret entry title"));
  for (const secret of ["SECRET_ENTRY_SUMMARY_BODY", "Other character title", "OTHER_SUMMARY_SECRET", "OTHER_FACT_SECRET"]) {
    assert.equal(response.body.includes(secret), false, `Serialized Player API leaked ${secret}`);
  }
  assert.equal(serializedActivity.includes("SECRET_FACT_BODY"), false, "Player activity duplicated a Knowledge Fact body");
  for (const forbidden of ["details", "type", "audience", "characterId", "playerId", "catalogItemId", "visibility", "operationId", "scope", "factCount"]) {
    assert.equal(serializedActivity.includes(`\"${forbidden}\"`), false, `Serialized activity leaked ${forbidden}`);
  }
  assert.equal((await app.inject({ method: "POST", url: `/api/player/knowledge-facts/${fact.id}/reveal`,
    headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `/api/player/knowledge-facts/${fact.id}/revoke`,
    headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode, 404);

  for (const pendingOrRejectedToken of [pendingToken, rejectedToken]) {
    const responseForUnapproved = await app.inject({ method: "GET", url: "/api/player/me",
      headers: { authorization: `Bearer ${pendingOrRejectedToken}` } });
    assert.equal(responseForUnapproved.statusCode, 200);
    assert.deepEqual(responseForUnapproved.json().knowledge, []);
    assert.deepEqual(responseForUnapproved.json().recentActivity, []);
    assert.deepEqual(responseForUnapproved.json().newActivity, []);
    assert.equal(responseForUnapproved.body.includes("Secret entry title"), false);
  }

  database.revokeKnowledgeFactReveal(campaign.id, entry.id, fact.id, "character", mira.id);
  const afterRevoke = await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(afterRevoke.statusCode, 200);
  assert.equal(afterRevoke.body.includes("Secret entry title"), false);
  assert.equal(afterRevoke.body.includes("SECRET_ENTRY_SUMMARY_BODY"), false);
  assert.equal(afterRevoke.body.includes("SECRET_FACT_BODY"), false);
  assert.equal(afterRevoke.json().recentActivity.some((event) => event.kind === "knowledge_facts_revealed" && event.knowledgeEntryId === entry.id), false);
  assert.equal(database.listCampaignActivity(campaign.id).some((event) => event.type === "knowledge_fact_access_revoked"), true);
});

test("Player Journal endpoint paginates safe activity and requires an active assigned controller", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Journal API");
  const mira = database.createCharacter(campaign.id, "Mira");
  const session = database.createSession(campaign.id, "Chapter");
  database.activateSession(session.id);
  const token = "J".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Mira", playerToken: token });
  const approved = database.listPlayersByCampaign(campaign.id).find((player) => player.displayName === "Mira");
  database.approvePlayer(approved.id, { characterId: mira.id });
  const catalogItem = database.createCatalogItem(campaign.id, "Chronicle item");
  for (let index = 0; index < 32; index++) database.grantInventoryItem(mira.id, catalogItem.id, 1);

  const journal = (authToken, query = "") => app.inject({ method: "GET", url: `/api/player/journal${query}`,
    headers: { authorization: `Bearer ${authToken}` } });
  assert.equal((await app.inject({ method: "GET", url: "/api/player/journal" })).statusCode, 401);
  const defaultPage = await journal(token);
  assert.equal(defaultPage.statusCode, 200);
  assert.equal(defaultPage.json().events.length, 30, "the default page size is 30");
  assert.ok(defaultPage.json().nextCursor);
  assert.ok(defaultPage.json().events.every((event) => event.kind === "item_received"));
  assert.equal(defaultPage.body.includes("Chronicle item"), true);
  const maxPage = await journal(token, "?limit=50");
  assert.equal(maxPage.statusCode, 200);
  assert.equal(maxPage.json().events.length, 32, "the maximum allowed limit accepts up to 50 events");
  for (const forbidden of ["campaignId", "playerId", "characterId", "relatedCharacterId", "catalogItemId", "sourceInventoryItemId", "operationId", "payload", "details", "factCount"]) {
    assert.equal(defaultPage.body.includes(`\"${forbidden}\"`), false, `Journal API leaked ${forbidden}`);
  }

  const cursor = defaultPage.json().nextCursor;
  const next = await journal(token, `?limit=30&beforeCreatedAt=${encodeURIComponent(cursor.beforeCreatedAt)}&beforeId=${cursor.beforeId}`);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().events.length, 2);
  assert.ok(next.json().events.every((event) => event.createdAt < cursor.beforeCreatedAt ||
    event.createdAt === cursor.beforeCreatedAt && event.id < cursor.beforeId));
  assert.equal(next.json().nextCursor, null);

  for (const query of ["?limit=0", "?limit=51", "?beforeId=00000000-0000-4000-8000-000000000000",
    "?beforeCreatedAt=not-a-date&beforeId=00000000-0000-4000-8000-000000000000",
    "?beforeCreatedAt=2026-10-05T10%3A00%3A00.000Z", "?characterId=" + mira.id]) {
    assert.equal((await journal(token, query)).statusCode, 400, query);
  }

  const pendingToken = "P".repeat(43);
  const rejectedToken = "R".repeat(43);
  database.submitPlayerRequest(session.id, "Pending", createHash("sha256").update(pendingToken).digest("hex"));
  const rejected = database.submitPlayerRequest(session.id, "Rejected", createHash("sha256").update(rejectedToken).digest("hex"));
  database.rejectPlayer(rejected.id);
  assert.equal((await journal(pendingToken)).statusCode, 403);
  assert.equal((await journal(rejectedToken)).statusCode, 403);

  database.endSession(session.id);
  const historical = await journal(token);
  assert.equal(historical.statusCode, 403);
  assert.equal(historical.body.includes("Chronicle item"), false);
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
    campaigns: [], sessions: [], current: null, players: [], characters: [], profileFields: [], itemCatalog: [], knowledge: [], activity: [],
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

test("DM manages campaign profile definitions and values; player tokens cannot use the DM API", async (t) => {
  const { app, database } = fixture(t);
  const campaign = (await post(app, "/api/dm/campaigns", { name: "Profile fields" })).json().campaign;
  const character = (await post(app, `/api/dm/campaigns/${campaign.id}/characters`, { name: "Mira" })).json().character;
  const first = (await post(app, `/api/dm/campaigns/${campaign.id}/profile-fields`, { label: "Орден" })).json().field;
  const second = (await post(app, `/api/dm/campaigns/${campaign.id}/profile-fields`, { label: "Родина" })).json().field;
  assert.equal((await post(app, `/api/dm/campaigns/${campaign.id}/profile-fields`, { label: " " })).statusCode, 400);
  assert.equal((await post(app, `/api/dm/campaigns/${campaign.id}/profile-fields`, { label: "Л".repeat(61) })).statusCode, 400);

  const saved = await app.inject({ method: "PUT", url: `/api/dm/characters/${character.id}/profile-fields`, headers, payload: {
    values: [{ fieldId: first.id, value: "Орден Серого Пламени" }, { fieldId: second.id, value: "Вейр" }]
  } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().profileFields.map(({ value }) => value), ["Орден Серого Пламени", "Вейр"]);
  const otherCampaign = (await post(app, "/api/dm/campaigns", { name: "Other profile" })).json().campaign;
  const foreignField = (await post(app, `/api/dm/campaigns/${otherCampaign.id}/profile-fields`, { label: "Фракция" })).json().field;
  assert.equal((await app.inject({ method: "PUT", url: `/api/dm/characters/${character.id}/profile-fields`, headers, payload: {
    values: [{ fieldId: foreignField.id, value: "Cross campaign" }]
  } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: `/api/dm/characters/${character.id}/profile-fields`, headers, payload: {
    values: [{ fieldId: first.id, value: "x".repeat(501) }]
  } })).statusCode, 400);

  const playerToken = "P".repeat(43);
  const session = database.createSession(campaign.id, "Session"); database.activateSession(session.id);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "A", playerToken });
  database.approvePlayer(database.listPlayersByCampaign(campaign.id)[0].id, { characterId: character.id });
  const playerState = (await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${playerToken}` } })).json();
  assert.deepEqual(playerState.profile.profileFields.map(({ label, value }) => [label, value]), [["Орден", "Орден Серого Пламени"], ["Родина", "Вейр"]]);
  assert.equal("campaignId" in playerState.profile.profileFields[0], false);
  assert.equal((await app.inject({ method: "POST", url: "/api/player/profile", headers: { authorization: `Bearer ${playerToken}` }, payload: {
    shortDescription: "No", personalGoal: "No", profileFields: [{ id: first.id, value: "Attempt" }]
  } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: `/api/dm/characters/${character.id}/profile-fields`, headers: { authorization: `Bearer ${playerToken}` }, payload: { values: [] } })).statusCode, 401);

  const renamed = await app.inject({ method: "PATCH", url: `/api/dm/campaigns/${campaign.id}/profile-fields/${first.id}`, headers, payload: { label: "Орден хранителей" } });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(database.getCharacterOverview(character.id).profileFields[0], { id: first.id, label: "Орден хранителей", value: "Орден Серого Пламени" });
  const reordered = await post(app, `/api/dm/campaigns/${campaign.id}/profile-fields/reorder`, { fieldIds: [second.id, first.id] });
  assert.deepEqual(reordered.json().fields.map(({ position }) => position), [0, 1]);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/dm/campaigns/${campaign.id}/profile-fields/${second.id}`, headers })).statusCode, 200);
  assert.deepEqual(database.getCharacterOverview(character.id).profileFields.map(({ label }) => label), ["Орден хранителей"]);
  assert.equal((await post(app, "/api/dm/data/health")).json().ok, true);
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
    name: "Mira", shortDescription: "DM text", archetype: "Scout", origin: "North", personalGoal: "Explore", dmNotes: "Hidden from players",
    traits: ["Observant", "Careful"], appearance: "A weathered coat", quote: "Keep moving."
  })).statusCode, 200);
  assert.equal((await playerPost(aToken, "/api/player/profile", { shortDescription: "Player text", personalGoal: "Find clues", dmNotes: "Injected" })).statusCode, 400);
  for (const forbidden of ["name", "archetype", "origin", "dmNotes", "campaignId", "characterId"]) {
    assert.equal((await playerPost(aToken, "/api/player/profile", {
      shortDescription: "Invalid", personalGoal: "Invalid", [forbidden]: "Injected"
    })).statusCode, 400);
  }
  for (const payload of [
    { traits: [" "] }, { traits: ["x".repeat(41)] }, { traits: Array.from({ length: 9 }, (_, index) => `Trait ${index}`) },
    { appearance: "x".repeat(1001) }, { quote: "x".repeat(301) }
  ]) {
    assert.equal((await playerPost(aToken, "/api/player/profile", { shortDescription: "x", personalGoal: "y", ...payload })).statusCode, 400);
  }
  const updatedProfile = await playerPost(aToken, "/api/player/profile", {
    shortDescription: "Player text", personalGoal: "Find clues", traits: ["Observant", " Careful ", "Observant"],
    appearance: "A weathered coat", quote: "Keep moving."
  });
  assert.equal(updatedProfile.statusCode, 200);
  assert.equal(updatedProfile.json().character.dmNotes, undefined);
  assert.deepEqual(updatedProfile.json().character.traits, ["Observant", "Careful"]);
  assert.equal(updatedProfile.json().character.appearance, "A weathered coat");
  assert.equal(updatedProfile.json().character.quote, "Keep moving.");
  assert.equal(updatedProfile.body.includes("Hidden from players"), false);
  assert.equal((await playerGet(aToken)).json().profile.dmNotes, undefined);
  assert.equal((await playerGet(aToken)).json().profile.archetype, "Scout");
  assert.deepEqual((await playerGet(aToken)).json().profile.traits, ["Observant", "Careful"]);
  assert.equal((await playerGet(aToken)).json().profile.appearance, "A weathered coat");
  assert.equal((await playerGet(aToken)).json().profile.quote, "Keep moving.");
  assert.equal((await playerGet(aToken)).body.includes("Hidden from players"), false);
  const dmOverview = (await get(app, `/api/dm/characters/${mira.id}/overview`)).json();
  assert.deepEqual(dmOverview.character.traits, ["Observant", "Careful"]);
  assert.equal(dmOverview.character.appearance, "A weathered coat");
  assert.equal(dmOverview.character.quote, "Keep moving.");
  assert.equal(dmOverview.character.dmNotes, "Hidden from players");
  assert.equal(database.listCharactersByCampaign(campaign.id).find((row) => row.id === mira.id).dmNotes, "Hidden from players");
  const note = (await playerPost(aToken, "/api/player/notes", {
    title: "Сомнительная дверь", body: "My theory", marker: "check", pinned: true
  })).json().note;
  assert.deepEqual({ title: note.title, body: note.body, marker: note.marker, pinned: note.pinned }, {
    title: "Сомнительная дверь", body: "My theory", marker: "check", pinned: true
  });
  const projectedNote = (await playerGet(aToken)).json().notes.find((entry) => entry.id === note.id);
  assert.deepEqual({ title: projectedNote.title, body: projectedNote.body, marker: projectedNote.marker, pinned: projectedNote.pinned,
    createdAt: projectedNote.createdAt, updatedAt: projectedNote.updatedAt }, {
    title: "Сомнительная дверь", body: "My theory", marker: "check", pinned: true,
    createdAt: note.createdAt, updatedAt: note.updatedAt
  });
  assert.deepEqual((await playerGet(bToken)).json().notes, []);
  assert.equal((await playerPost(aToken, `/api/player/notes/${note.id}`, { title: "Обновлено", marker: "question", pinned: false })).statusCode, 200);
  const updatedNote = (await playerGet(aToken)).json().notes.find((entry) => entry.id === note.id);
  assert.deepEqual({ title: updatedNote.title, body: updatedNote.body, marker: updatedNote.marker, pinned: updatedNote.pinned }, {
    title: "Обновлено", body: "My theory", marker: "question", pinned: false
  });
  assert.equal((await playerPost(bToken, `/api/player/notes/${note.id}`, { title: "Stolen", pinned: true })).statusCode, 404);
  const legacyNote = (await playerPost(aToken, "/api/player/notes", { body: "Old client text" })).json().note;
  assert.deepEqual({ title: legacyNote.title, marker: legacyNote.marker, pinned: legacyNote.pinned }, {
    title: "", marker: "normal", pinned: false
  });
  assert.equal((await playerPost(aToken, "/api/player/notes", { title: "x".repeat(121), body: "Invalid" })).statusCode, 400);
  assert.equal((await playerPost(aToken, `/api/player/notes/${note.id}`, { marker: "other" })).statusCode, 400);
  const dmNote = (await get(app, `/api/dm/characters/${mira.id}/overview`)).json().notes.find((entry) => entry.id === note.id);
  assert.deepEqual({ title: dmNote.title, body: dmNote.body, marker: dmNote.marker, pinned: dmNote.pinned }, {
    title: "Обновлено", body: "My theory", marker: "question", pinned: false
  });
  const recent = (await playerGet(aToken)).json().recentActivity;
  assert.equal(JSON.stringify(recent).includes(note.body), false);
  assert.equal(JSON.stringify(recent).includes(note.title), false);
  assert.equal(recent.every((event) => ["item_received", "knowledge_summary_opened", "knowledge_facts_revealed"].includes(event.kind)), true);
  const updatedSettings = await playerPost(aToken, "/api/player/settings", { displayName: "New A" });
  assert.equal(updatedSettings.statusCode, 200);
  assert.equal(updatedSettings.json().player.tokenHash, undefined);
  assert.equal((await playerGet(aToken)).json().displayName, "New A");
  database.endSession(session.id);
  assert.equal((await playerPost(aToken, "/api/player/notes", { body: "Too late" })).statusCode, 403);
  assert.equal((await playerPost(aToken, `/api/player/notes/${note.id}`, { pinned: true })).statusCode, 403);
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

test("generic database constraints are not reported as duplicate Player names", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Campaign");
  const session = database.createSession(campaign.id, "Session");
  database.activateSession(session.id);
  const token = "G".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Player", playerToken: token });
  const player = database.listPlayersByCampaign(campaign.id)[0];
  database.approvePlayer(player.id, { characterName: "Mira" });
  database.updatePlayerDisplayName = () => { throw new Error("SQLITE_CONSTRAINT_UNIQUE: inventory stack conflict"); };
  const response = await app.inject({ method: "POST", url: "/api/player/settings",
    headers: { authorization: "Bearer " + token }, payload: { displayName: "Changed" } });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().message, "Не удалось выполнить запрос. Повторите позже.");
  assert.notEqual(response.json().message, "Это имя уже занято в сессии.");
  assert.equal(response.body.includes("SQLITE_CONSTRAINT"), false);
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
    ["POST", "/api/dm/characters/00000000-0000-4000-8000-000000000001/profile"],
    ["PATCH", "/api/dm/catalog-items/00000000-0000-4000-8000-000000000001"],
    ["PATCH", "/api/dm/characters/00000000-0000-4000-8000-000000000001/inventory-capacity"]
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
  const writePlayer = (token, path, payload) => app.inject({
    method: "POST", url: path, headers: { authorization: "Bearer " + token }, payload
  });
  const firstViewBeforeEnd = await readPlayer(firstPlayerToken);
  assert.equal(firstViewBeforeEnd.statusCode, 200);
  assert.equal(firstViewBeforeEnd.json().inventory[0].quantity, 2);
  const profileUpdate = await writePlayer(firstPlayerToken, "/api/player/profile", {
    shortDescription: "A mapmaker", personalGoal: "Find the lost road", traits: ["Observant", "Careful"],
    appearance: "A red scarf", quote: "The trail remembers."
  });
  assert.equal(profileUpdate.statusCode, 200);
  assert.equal((await post(app, "/api/dm/sessions/" + firstSession.id + "/end")).statusCode, 200);
  assert.equal((await writePlayer(firstPlayerToken, "/api/player/profile", {
    shortDescription: "Historical edit", personalGoal: "Historical edit", traits: [], appearance: "", quote: ""
  })).statusCode, 403);
  const preparationGrant = await post(app, "/api/dm/characters/" + character.id + "/items", {
    catalogItemId: item.id, quantity: 1
  });
  assert.equal(preparationGrant.statusCode, 201, "DM may update persistent inventory between sessions");
  assert.equal(database.listCampaignActivity(campaign.id).filter((event) => event.type === "item_granted").at(-1).sessionId, null);

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
  assert.deepEqual(secondView.json().profile.traits, ["Observant", "Careful"]);
  assert.equal(secondView.json().profile.appearance, "A red scarf");
  assert.equal(secondView.json().profile.quote, "The trail remembers.");
  assert.deepEqual(secondView.json().inventory.map(({ name, quantity }) => ({ name, quantity })), [
    { name: "Old compass", quantity: 3 }
  ]);
  const secondGrant = await post(app, "/api/dm/characters/" + character.id + "/items", {
    catalogItemId: item.id, quantity: 1
  });
  assert.equal(secondGrant.statusCode, 201);
  assert.equal(secondGrant.json().item.quantity, 4);
  assert.deepEqual((await readPlayer(secondPlayerToken)).json().inventory.map(({ name, quantity }) => ({ name, quantity })), [
    { name: "Old compass", quantity: 4 }
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
  assert.equal(firstViewAfterEnd.json().inventory[0].quantity, 4);
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
  const personal = database.createKnowledge(campaign.id, "fact", "Mira's clue", "Only Mira knows this.");
  const party = database.createKnowledge(campaign.id, "event", "Shared lead", "Everyone knows this.");
  const hidden = database.createKnowledge(campaign.id, "creature", "Unrevealed", "Keep this from players.");

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

test("DM accepts only universal knowledge categories and players cannot create or change knowledge", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Universal categories");
  const character = database.createCharacter(campaign.id, "Mira");
  const otherCampaign = database.createCampaign("Other campaign");
  const foreignCharacter = database.createCharacter(otherCampaign.id, "Nora");
  const categories = ["character", "place", "creature", "item", "event", "fact"];
  const created = [];
  for (const [index, category] of categories.entries()) {
    const response = await post(app, `/api/dm/campaigns/${campaign.id}/knowledge`, {
      category, title: `Запись ${index}`, description: `Описание ${index}`
    });
    assert.equal(response.statusCode, 201);
    created.push(response.json().entry);
  }
  assert.deepEqual(created.map(({ category }) => category), categories);
  assert.equal((await post(app, `/api/dm/knowledge/${created[0].id}/visibility`, {
    visibility: "character", characterId: foreignCharacter.id
  })).statusCode, 409);
  for (const category of ["npc", "monster", "note", "quest"]) {
    const legacy = await post(app, `/api/dm/campaigns/${campaign.id}/knowledge`, {
      category, title: "Старый тип", description: "Не должен приниматься"
    });
    assert.equal(legacy.statusCode, 400);
  }

  const session = database.createSession(campaign.id, "Session");
  database.activateSession(session.id);
  const token = "U".repeat(43);
  const request = await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Игрок", playerToken: token });
  const player = database.listPlayersByCampaign(campaign.id)[0];
  await post(app, `/api/dm/players/${player.id}/approve`, { characterId: character.id });
  const playerCreate = await app.inject({ method: "POST", url: "/api/player/knowledge", headers: { authorization: `Bearer ${token}` }, payload: {
    category: "fact", title: "Подмена", description: "Игрок не может создать знание"
  } });
  const playerVisibility = await app.inject({ method: "POST", url: `/api/player/knowledge/${created[0].id}/visibility`, headers: { authorization: `Bearer ${token}` }, payload: { visibility: "party" } });
  assert.equal(playerCreate.statusCode, 404);
  assert.equal(playerVisibility.statusCode, 404);
  assert.equal(database.listKnowledgeByCampaign(campaign.id).length, 6);
});

test("DM can correct Knowledge Entry content without changing grants, visibility or Player Activity", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Entry editing");
  const otherCampaign = database.createCampaign("Other campaign");
  const mira = database.createCharacter(campaign.id, "Mira");
  const visible = database.createKnowledge(campaign.id, "character", "Old contact", "Old summary.");
  database.setKnowledgeVisibility(visible.id, "party");
  const visibleFact = database.createKnowledgeFact(campaign.id, visible.id, "Known detail.");
  const visibleReveal = database.revealKnowledgeFactToParty(campaign.id, visible.id, visibleFact.id).reveal;
  const hidden = database.createKnowledge(campaign.id, "fact", "Sealed record", "HIDDEN_SUMMARY");
  const hiddenFact = database.createKnowledgeFact(campaign.id, hidden.id, "One separately opened fact.");
  const hiddenReveal = database.revealKnowledgeFactToParty(campaign.id, hidden.id, hiddenFact.id).reveal;
  const foreign = database.createKnowledge(otherCampaign.id, "fact", "Foreign", "Foreign description.");
  const session = database.createSession(campaign.id, "Current");
  database.activateSession(session.id);
  const playerToken = "V".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Mira player", playerToken });
  database.approvePlayer(database.listPlayersByCampaign(campaign.id)[0].id, { characterId: mira.id });

  const path = `/api/dm/campaigns/${campaign.id}/knowledge/${visible.id}`;
  assert.equal((await app.inject({ method: "PATCH", url: path, payload: {
    category: "place", title: "No authorization", description: "Denied."
  } })).statusCode, 401);
  const badBodies = [
    { category: "quest", title: "Valid", description: "Valid." },
    { category: "fact", title: "  \n", description: "Valid." },
    { category: "fact", title: "Valid", description: "\t " },
    { category: "fact", title: "x".repeat(121), description: "Valid." },
    { category: "fact", title: "Valid", description: "x".repeat(2001) },
    { category: "fact", title: "Valid", description: "Valid.", visibility: "party" }
  ];
  for (const payload of badBodies) assert.equal((await patch(app, path, payload)).statusCode, 400);
  assert.equal((await patch(app, `/api/dm/campaigns/not-a-uuid/knowledge/${visible.id}`, {
    category: "fact", title: "Valid", description: "Valid."
  })).statusCode, 400);
  assert.equal((await patch(app, `/api/dm/campaigns/${campaign.id}/knowledge/${foreign.id}`, {
    category: "fact", title: "Cross campaign", description: "Must fail."
  })).statusCode, 404);
  assert.equal((await patch(app, `/api/dm/campaigns/${otherCampaign.id}/knowledge/${visible.id}`, {
    category: "fact", title: "Cross campaign", description: "Must fail."
  })).statusCode, 404);

  const activityBefore = database.listCampaignActivity(campaign.id);
  const update = await patch(app, path, { category: "place", title: "Updated contact", description: "Current visible summary." });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json().entry, { ...visible, category: "place", title: "Updated contact", description: "Current visible summary.", visibility: "party" });
  const hiddenUpdate = await patch(app, `/api/dm/campaigns/${campaign.id}/knowledge/${hidden.id}`, {
    category: "event", title: "Updated sealed record", description: "UPDATED_HIDDEN_SUMMARY"
  });
  assert.equal(hiddenUpdate.statusCode, 200);
  assert.equal((await patch(app, path, { category: "fact", title: "Valid", description: "Valid.", extra: true })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/dm/campaigns/${campaign.id}/knowledge/not-a-uuid`, headers, payload: {
    category: "fact", title: "Valid", description: "Valid."
  } })).statusCode, 400);

  const exported = database.exportCampaign(campaign.id);
  assert.equal(exported.knowledge.find(({ id }) => id === visible.id).visibility, "party");
  assert.equal(exported.knowledge.find(({ id }) => id === visible.id).id, visible.id);
  assert.deepEqual(exported.knowledgeFacts.filter(({ knowledgeEntryId }) => knowledgeEntryId === visible.id).map(({ id }) => id), [visibleFact.id]);
  assert.deepEqual(exported.knowledgeFactReveals.map(({ id }) => id).sort(), [visibleReveal.id, hiddenReveal.id].sort());
  assert.equal(exported.knowledge.find(({ id }) => id === hidden.id).visibility, "hidden");
  assert.equal(exported.knowledge.find(({ id }) => id === hidden.id).visibleToCharacterId, null);
  assert.deepEqual(database.listCampaignActivity(campaign.id), activityBefore, "Entry correction is not a Player Activity event");

  const playerState = await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${playerToken}` } });
  assert.equal(playerState.statusCode, 200);
  const visibleProjection = playerState.json().knowledge.find(({ id }) => id === visible.id);
  assert.equal(visibleProjection.title, "Updated contact");
  assert.equal(visibleProjection.category, "place");
  assert.equal(visibleProjection.summary, "Current visible summary.");
  const hiddenProjection = playerState.json().knowledge.find(({ id }) => id === hidden.id);
  assert.equal(hiddenProjection.title, "Updated sealed record");
  assert.equal(hiddenProjection.summary, null);
  assert.equal(JSON.stringify(playerState.json()).includes("UPDATED_HIDDEN_SUMMARY"), false);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/player/knowledge/${visible.id}/visibility`,
    headers: { authorization: `Bearer ${playerToken}` }, payload: { visibility: "party" } })).statusCode, 404);
});

test("DM prepares Knowledge Facts through campaign-scoped APIs without changing reveal history", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Facts campaign");
  const otherCampaign = database.createCampaign("Other campaign");
  const entry = database.createKnowledge(campaign.id, "character", "Apothecary", "An entry summary stays independent.");
  const otherEntry = database.createKnowledge(otherCampaign.id, "fact", "Other", "Other campaign entry.");
  const foreignFact = database.createKnowledgeFact(otherCampaign.id, otherEntry.id, "A fact owned by another entry.");
  const base = `/api/dm/campaigns/${campaign.id}/knowledge/${entry.id}/facts`;
  const noAuth = await app.inject({ method: "GET", url: base });
  assert.equal(noAuth.statusCode, 401);
  assert.deepEqual((await get(app, base)).json().facts, []);

  for (const payload of [{ body: "   " }, { body: "x".repeat(2001) }, { body: "Valid", extra: true }]) {
    assert.equal((await post(app, base, payload)).statusCode, 400);
  }
  assert.equal((await get(app, `/api/dm/campaigns/${campaign.id}/knowledge/${otherEntry.id}/facts`)).statusCode, 404);
  assert.equal((await get(app, `/api/dm/campaigns/${otherCampaign.id}/knowledge/${entry.id}/facts`)).statusCode, 404);

  const firstResponse = await post(app, base, { body: "  Mira слышит звон из подвала.  " });
  const secondResponse = await post(app, base, { body: "Запах трав выдаёт недавний ритуал." });
  assert.equal(firstResponse.statusCode, 201);
  assert.equal(secondResponse.statusCode, 201);
  const first = firstResponse.json().fact;
  const second = secondResponse.json().fact;
  assert.equal(first.body, "Mira слышит звон из подвала.");

  const invalidUpdate = await app.inject({ method: "PATCH", url: `${base}/${first.id}`, headers, payload: { body: "\t " } });
  assert.equal(invalidUpdate.statusCode, 400);
  const changed = await app.inject({ method: "PATCH", url: `${base}/${first.id}`, headers, payload: { body: "Над дверью виден свежий след." } });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().fact.body, "Над дверью виден свежий след.");
  assert.equal((await app.inject({ method: "PATCH", url: `${base}/${foreignFact.id}`, headers, payload: { body: "Cross-entry edit" } })).statusCode, 404);

  const reveal = database.revealKnowledgeFactToParty(campaign.id, entry.id, first.id);
  assert.equal(reveal.created, true);
  const reordered = await post(app, `${base}/reorder`, { factIds: [second.id, first.id] });
  assert.equal(reordered.statusCode, 200);
  assert.deepEqual(reordered.json().facts.map((fact) => fact.id), [second.id, first.id]);
  assert.equal((await post(app, `${base}/reorder`, { factIds: [first.id] })).statusCode, 409);
  assert.equal((await post(app, `${base}/reorder`, { factIds: [first.id, first.id] })).statusCode, 409);

  const beforeDelete = database.exportCampaign(campaign.id);
  assert.equal(beforeDelete.knowledgeFactReveals.length, 1);
  assert.equal(beforeDelete.knowledgeFactReveals[0].knowledgeFactId, first.id);
  const deleted = await app.inject({ method: "DELETE", url: `${base}/${first.id}`, headers });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual((await get(app, base)).json().facts.map((fact) => fact.id), [second.id]);
  const afterDelete = database.exportCampaign(campaign.id);
  assert.equal(afterDelete.knowledgeFactReveals.length, 0);
  assert.equal(afterDelete.activity.filter((event) => event.type === "knowledge_fact_revealed").length, 1);
  assert.equal(afterDelete.knowledge[0].description, "An entry summary stays independent.");
  assert.equal((await app.inject({ method: "DELETE", url: `${base}/${first.id}`, headers })).statusCode, 404);
  assert.equal((await post(app, `${base}/reveal`, { factId: second.id })).statusCode, 404);
});

test("DM Knowledge Fact reveal APIs preserve independent audiences, retry identity, and correction history", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Progressive facts");
  const foreignCampaign = database.createCampaign("Foreign campaign");
  const mira = database.createCharacter(campaign.id, "Mira");
  const rowan = database.createCharacter(campaign.id, "Rowan");
  const archived = database.createCharacter(campaign.id, "Archived");
  const foreign = database.createCharacter(foreignCampaign.id, "Nora");
  database.archiveCharacter(archived.id);
  const session = database.createSession(campaign.id, "Live session");
  database.activateSession(session.id);
  for (const [name, character, token] of [["Mira player", mira, "M".repeat(43)], ["Rowan player", rowan, "R".repeat(43)]]) {
    await post(app, `/api/join/${session.joinToken}/request`, { displayName: name, playerToken: token });
    const player = database.listPlayersByCampaign(campaign.id).find((entry) => entry.displayName === name);
    database.approvePlayer(player.id, { characterId: character.id });
  }
  const entry = database.createKnowledge(campaign.id, "fact", "The sealed room", "Summary remains hidden.");
  const facts = ["First fragment", "Second fragment", "Third fragment"].map((body) => database.createKnowledgeFact(campaign.id, entry.id, body));
  const base = `/api/dm/campaigns/${campaign.id}/knowledge/${entry.id}/facts`;
  const revealsUrl = `${base}/reveals`;
  const noAuth = await app.inject({ method: "GET", url: revealsUrl });
  assert.equal(noAuth.statusCode, 401);
  assert.deepEqual((await get(app, revealsUrl)).json().reveals, []);
  assert.equal((await get(app, `/api/dm/campaigns/${foreignCampaign.id}/knowledge/${entry.id}/facts/reveals`)).statusCode, 404);

  const selectedWithSession = await post(app, `${base}/${facts[2].id}/reveal`, { audience: "party", sessionId: session.id });
  assert.equal(selectedWithSession.statusCode, 400);
  const selectedParty = await post(app, `${base}/${facts[2].id}/reveal`, { audience: "party" });
  assert.equal(selectedParty.statusCode, 200);
  assert.equal(selectedParty.json().result.created, true);
  assert.equal(selectedParty.json().result.reveal.sessionId, session.id);
  assert.equal("operationId" in selectedParty.json().result.reveal, false);
  assert.equal((await post(app, `${base}/${facts[2].id}/reveal`, { audience: "party" })).json().result.created, false);
  assert.equal((await post(app, `${base}/${facts[1].id}/reveal`, { audience: "character", characterId: rowan.id })).json().result.created, true);
  assert.equal((await post(app, `${base}/${facts[0].id}/reveal`, { audience: "character", characterId: archived.id })).statusCode, 409);
  assert.equal((await post(app, `${base}/${facts[0].id}/reveal`, { audience: "character", characterId: foreign.id })).statusCode, 409);
  assert.equal((await post(app, `${base}/${database.createKnowledgeFact(foreignCampaign.id,
    database.createKnowledge(foreignCampaign.id, "fact", "Foreign entry", "Summary").id, "Foreign fact.").id}/reveal`, { audience: "party" })).statusCode, 404);

  const operationId = randomUUID();
  const nextUrl = `${base}/reveal-next`;
  const invalidNext = await post(app, nextUrl, { audience: "party", operationId, sessionId: session.id });
  assert.equal(invalidNext.statusCode, 400);
  assert.equal((await post(app, nextUrl, { audience: "party", operationId: "not-a-uuid" })).statusCode, 400);
  const activityBeforeNext = database.listCampaignActivity(campaign.id).filter((event) => event.type === "knowledge_fact_revealed").length;
  const nextParty = await post(app, nextUrl, { audience: "party", operationId });
  assert.equal(nextParty.statusCode, 200);
  assert.equal(nextParty.json().result.fact.id, facts[0].id);
  assert.equal(nextParty.json().result.reveal.sessionId, session.id);
  assert.equal("operationId" in nextParty.json().result.reveal, false);
  const retryParty = await post(app, nextUrl, { audience: "party", operationId });
  assert.equal(retryParty.json().result.fact.id, facts[0].id);
  assert.equal(retryParty.json().result.created, false);
  assert.equal((await post(app, nextUrl, { audience: "character", characterId: mira.id, operationId })).statusCode, 409);
  assert.equal(database.listCampaignActivity(campaign.id).filter((event) => event.type === "knowledge_fact_revealed").length, activityBeforeNext + 1);

  const nextMira = await post(app, nextUrl, { audience: "character", characterId: mira.id, operationId: randomUUID() });
  assert.equal(nextMira.json().result.fact.id, facts[0].id);
  const nextMiraAgain = await post(app, nextUrl, { audience: "character", characterId: mira.id, operationId: randomUUID() });
  assert.equal(nextMiraAgain.json().result.fact.id, facts[1].id);
  const beforeAll = database.listCampaignActivity(campaign.id).filter((event) => event.type === "knowledge_fact_revealed").length;
  const allParty = await post(app, `${base}/reveal-all`, { audience: "party" });
  assert.equal(allParty.json().result.createdCount, 1);
  assert.equal((await post(app, `${base}/reveal-all`, { audience: "party" })).json().result.createdCount, 0);
  assert.equal(database.listCampaignActivity(campaign.id).filter((event) => event.type === "knowledge_fact_revealed").length, beforeAll + 1);
  const allMira = await post(app, `${base}/reveal-all`, { audience: "character", characterId: mira.id });
  assert.equal(allMira.json().result.createdCount, 1);
  assert.equal((await post(app, `${base}/reveal-all`, { audience: "character", characterId: mira.id, sessionId: session.id })).statusCode, 400);
  assert.equal(database.listKnowledgeByCampaign(campaign.id).find((item) => item.id === entry.id).visibility, "hidden");

  const current = await get(app, revealsUrl);
  assert.equal(current.statusCode, 200);
  assert.equal(current.body.includes("operationId"), false);
  assert.equal(current.body.includes("M".repeat(43)), false);
  assert.equal(current.json().reveals.every((reveal) => reveal.sessionId === session.id), true);
  const playerRead = await app.inject({ method: "POST", url: "/api/player/knowledge-facts/reveal", headers: { authorization: `Bearer ${"M".repeat(43)}` }, payload: {} });
  assert.equal(playerRead.statusCode, 404);

  const eventsBeforeRevoke = database.listCampaignActivity(campaign.id).filter((event) => event.type === "knowledge_fact_revealed");
  assert.equal(eventsBeforeRevoke.every((event) => !JSON.stringify(event.details).includes("fragment")), true);
  const revokeUrl = `${base}/${facts[2].id}/revoke`;
  assert.equal((await post(app, revokeUrl, { audience: "party" })).json().revoked, true);
  assert.equal((await post(app, revokeUrl, { audience: "party" })).json().revoked, false);
  const afterRevoke = database.listCampaignActivity(campaign.id).filter((event) =>
    event.type === "knowledge_fact_revealed" || event.type === "knowledge_fact_access_revoked");
  assert.equal(afterRevoke.some((event) => eventsBeforeRevoke.some((old) => old.id === event.id)), true);
  assert.equal(afterRevoke.filter((event) => event.type === "knowledge_fact_access_revoked").length, 1);
});

test("DM cleanup endpoints preview disposition, revoke Player tokens, preserve history, and reject stale or cross-campaign requests", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Session cleanup API");
  const character = database.createCharacter(campaign.id, "Mira");
  const session = database.createSession(campaign.id, "First");
  database.activateSession(session.id);
  const token = "R".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Mira player", playerToken: token });
  const player = database.listPlayersByCampaign(campaign.id)[0];
  database.approvePlayer(player.id, { characterId: character.id });

  const playerPath = `/api/dm/campaigns/${campaign.id}/players/${player.id}`;
  const unauthenticated = await app.inject({ method: "GET", url: playerPath + "/cleanup-preview" });
  assert.equal(unauthenticated.statusCode, 401);
  const playerPreview = await get(app, playerPath + "/cleanup-preview");
  assert.equal(playerPreview.statusCode, 200);
  assert.deepEqual(playerPreview.json(), { disposition: "removed", releasedCharacterId: character.id });
  const playerRemoved = await app.inject({ method: "DELETE", url: playerPath, headers, payload: { expectedDisposition: "removed" } });
  assert.equal(playerRemoved.statusCode, 200);
  assert.deepEqual(playerRemoved.json(), { disposition: "removed", releasedCharacterId: character.id });
  const repeatedPlayerDelete = await app.inject({ method: "DELETE", url: playerPath, headers, payload: { expectedDisposition: "removed" } });
  assert.deepEqual(repeatedPlayerDelete.json(), { disposition: "removed", releasedCharacterId: null });
  assert.equal((await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  assert.equal(database.listCampaignActivity(campaign.id).some(({ playerId }) => playerId === player.id), true);

  const replacementToken = "S".repeat(43);
  const replacement = await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Mira player", playerToken: replacementToken });
  assert.equal(replacement.statusCode, 200, "removed display names may be reused with a new token");
  const replacementRow = database.listPlayersByCampaign(campaign.id).find(({ displayName }) => displayName === "Mira player");
  database.approvePlayer(replacementRow.id, { characterId: character.id });

  const sessionPath = `/api/dm/campaigns/${campaign.id}/sessions/${session.id}`;
  assert.equal((await get(app, sessionPath + "/cleanup-preview")).statusCode, 409, "active Sessions cannot be removed");
  assert.equal((await app.inject({ method: "DELETE", url: sessionPath, headers, payload: { expectedDisposition: "removed" } })).statusCode, 409);
  database.endSession(session.id);
  const sessionPreview = await get(app, sessionPath + "/cleanup-preview");
  assert.equal(sessionPreview.json().disposition, "removed");
  const stale = await app.inject({ method: "DELETE", url: sessionPath, headers, payload: { expectedDisposition: "deleted" } });
  assert.equal(stale.statusCode, 409);
  const removed = await app.inject({ method: "DELETE", url: sessionPath, headers, payload: { expectedDisposition: "removed" } });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual((await app.inject({ method: "DELETE", url: sessionPath, headers, payload: { expectedDisposition: "removed" } })).json(), { disposition: "removed" });
  assert.equal((await get(app, `/api/join/${session.joinToken}`)).statusCode, 404, "removed Session invitations are unavailable");
  assert.equal((await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Late", playerToken: "T".repeat(43) })).statusCode, 404);
  assert.throws(() => database.activateSession(session.id), /not found|removed/i);
  assert.equal(database.getSession(session.id).name, "First", "historical lookup retains the original Session name");
  assert.equal(database.listSessions(campaign.id).some(({ id }) => id === session.id), false);
  const replacementHash = createHash("sha256").update(replacementToken).digest("hex");
  assert.equal(database.getPlayerState(replacementHash).characterId, character.id, "removing a Session does not revoke a nonremoved Player token");

  const foreignCampaign = database.createCampaign("Foreign");
  assert.equal((await get(app, `/api/dm/campaigns/${foreignCampaign.id}/players/${player.id}/cleanup-preview`)).statusCode, 404);
  const invalidBody = await app.inject({ method: "DELETE", url: playerPath, headers, payload: { expectedDisposition: "removed", extra: true } });
  assert.equal(invalidBody.statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/dm/campaigns/${campaign.id}/players/${randomUUID()}`, headers, payload: { expectedDisposition: "deleted" } })).statusCode, 404);
});

test("removed Player credentials receive the same generic denial on every Player read and mutation route", async (t) => {
  const { app, database } = fixture(t);
  const campaign = database.createCampaign("Revoked token");
  const character = database.createCharacter(campaign.id, "Mira");
  const recipient = database.createCharacter(campaign.id, "Rowan");
  const session = database.createSession(campaign.id, "Active");
  database.activateSession(session.id);
  const token = "U".repeat(43);
  await post(app, `/api/join/${session.joinToken}/request`, { displayName: "Mira", playerToken: token });
  const player = database.listPlayersByCampaign(campaign.id)[0];
  database.approvePlayer(player.id, { characterId: character.id });
  const recipientRequest = database.submitPlayerRequest(session.id, "Rowan", createHash("sha256").update("recipient-token").digest("hex"));
  database.approvePlayer(recipientRequest.id, { characterId: recipient.id });
  const item = database.createCatalogItem(campaign.id, "Key");
  const owned = database.grantInventoryItem(character.id, item.id, 1);
  const note = database.createPersonalNote(createHash("sha256").update(token).digest("hex"), "A note", { title: "Note" });
  database.removePlayer(campaign.id, player.id, "removed");

  const auth = { authorization: `Bearer ${token}` };
  const requests = [
    app.inject({ method: "GET", url: "/api/player/me", headers: auth }),
    app.inject({ method: "GET", url: "/api/player/journal", headers: auth }),
    app.inject({ method: "GET", url: `/api/player/inventory/${owned.id}/transfer-targets`, headers: auth }),
    app.inject({ method: "POST", url: "/api/player/profile", headers: auth, payload: { shortDescription: "x", personalGoal: "y" } }),
    app.inject({ method: "POST", url: "/api/player/settings", headers: auth, payload: { displayName: "New" } }),
    app.inject({ method: "POST", url: "/api/player/notes", headers: auth, payload: { body: "Another note" } }),
    app.inject({ method: "POST", url: `/api/player/notes/${note.id}`, headers: auth, payload: { body: "Changed" } }),
    app.inject({ method: "POST", url: "/api/player/activity/seen", headers: auth, payload: { upToActivityId: randomUUID() } }),
    app.inject({ method: "POST", url: `/api/player/inventory/${owned.id}/equip`, headers: auth, payload: {} }),
    app.inject({ method: "POST", url: `/api/player/inventory/${owned.id}/unequip`, headers: auth, payload: {} }),
    app.inject({ method: "POST", url: `/api/player/inventory/${owned.id}/transfer`, headers: auth,
      payload: { recipientCharacterId: recipient.id, quantity: 1, operationId: randomUUID() } }),
    app.inject({ method: "POST", url: `/api/player/inventory/${owned.id}/discard`, headers: auth,
      payload: { quantity: 1, operationId: randomUUID() } })
  ];
  const responses = await Promise.all(requests);
  assert.ok(responses.every(({ statusCode }) => statusCode === 401), responses.map(({ statusCode, body }) => `${statusCode}: ${body}`).join("\n"));
  const unknown = await app.inject({ method: "GET", url: "/api/player/me", headers: { authorization: `Bearer ${"V".repeat(43)}` } });
  assert.equal(responses[0].json().message, unknown.json().message, "revocation does not reveal whether a Player record existed");
  assert.equal(database.listCampaignActivity(campaign.id).some(({ playerId }) => playerId === player.id), true);
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
  const personalKnowledge = database.createKnowledge(campaign.id, "fact", "Personal clue", "Known to Mira.");
  database.setKnowledgeVisibility(personalKnowledge.id, "character", character.id);
  const fact = database.createKnowledgeFact(campaign.id, personalKnowledge.id, "A second, separately revealed detail.");
  database.revealKnowledgeFactToCharacter(campaign.id, personalKnowledge.id, fact.id, character.id);

  const exported = await get(app, "/api/dm/campaigns/" + campaign.id + "/export");
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers["content-disposition"], /attachment/);
  assert.equal(exported.body.includes(session.joinToken), false);
  assert.equal(exported.body.includes("b".repeat(64)), false);
  const archive = exported.json();
  assert.equal(archive.version, 11);
  assert.equal((await app.inject({ method: "GET", url: "/api/dm/backups" })).statusCode, 401);

  const imported = await post(app, "/api/dm/campaigns/import", archive);
  assert.equal(imported.statusCode, 201, imported.body);
  assert.notEqual(imported.json().campaign.id, campaign.id);
  const importedData = database.exportCampaign(imported.json().campaign.id);
  assert.equal(importedData.characters[0].name, "Mira");
  assert.deepEqual({ traits: importedData.characters[0].traits, appearance: importedData.characters[0].appearance, quote: importedData.characters[0].quote }, {
    traits: [], appearance: "", quote: ""
  });
  assert.equal(importedData.inventoryItems[0].quantity, 1);
  assert.equal(importedData.knowledge[0].visibility, "character");
  assert.equal(importedData.knowledge[0].visibleToCharacterId, importedData.characters[0].id);
  assert.equal(importedData.knowledgeFacts.length, 1);
  assert.equal(importedData.knowledgeFacts[0].knowledgeEntryId, importedData.knowledge[0].id);
  assert.equal(importedData.knowledgeFactReveals[0].characterId, importedData.characters[0].id);
  const malformedProfileArchive = structuredClone(archive);
  malformedProfileArchive.characters[0].traits = ["x".repeat(41)];
  assert.equal((await post(app, "/api/dm/campaigns/import", malformedProfileArchive)).statusCode, 400);
  const malformedInventoryArchive = structuredClone(archive);
  malformedInventoryArchive.characters[0].inventoryCapacity = 0;
  assert.equal((await post(app, "/api/dm/campaigns/import", malformedInventoryArchive)).statusCode, 400);
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
  assert.equal(imported.statusCode, 201, imported.body);
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
