import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const modelSource = read("../src/player/model.ts");
const modelJs = ts.transpileModule(modelSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const modelModule = { exports: {} };
new Function("require", "module", "exports", modelJs)(createRequire(import.meta.url), modelModule, modelModule.exports);
const model = modelModule.exports;
const page = read("../src/player/InventoryPage.tsx");
const workspace = read("../src/player/PlayerWorkspace.tsx");
const css = read("../src/player/player.css");

const item = (overrides = {}) => ({
  id: "bag-row", catalogItemId: "catalog-1", name: "Нож", quantity: 1, description: "Компактный нож.",
  category: "equipment", rarity: "rare", equipmentSlot: "primary", equippedSlot: null,
  createdAt: "2026-01-01T00:00:00.000Z", ...overrides
});

test("production InventoryPage owns the inventory tab and fixed equipment order", () => {
  assert.match(workspace, /<InventoryPage player=\{player\}/);
  assert.doesNotMatch(workspace, /player\.inventory\.map/);
  assert.deepEqual(model.EQUIPMENT_SLOT_ORDER, ["primary", "secondary", "armor", "accessory", "tool", "special"]);
  assert.deepEqual(model.EQUIPMENT_SLOT_ORDER.map((slot) => model.EQUIPMENT_SLOT_LABELS[slot]),
    ["Основное", "Вторичное", "Защита", "Аксессуар", "Инструмент", "Особое"]);
  assert.match(page, /EQUIPMENT_SLOT_ORDER\.map/);
  assert.match(css, /\.prod-equipment-grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test("bag slot count is rows, not item quantity, and free slot rendering is capped", () => {
  const rows = [item({ quantity: 10 }), item({ id: "equipped", equippedSlot: "primary" }), item({ id: "row-2", quantity: 3 })];
  assert.equal(model.inventoryBagSlotsUsed(rows), 2);
  assert.equal(model.inventoryBagSlotsUsed([]), 0);
  assert.equal(model.bagPlaceholderCount(12), 6);
  assert.equal(model.bagUnrenderedFreeSlots(12), 6);
  assert.equal(model.bagPlaceholderCount(3), 3);
  assert.equal(model.bagUnrenderedFreeSlots(3), 0);
  assert.equal(model.bagPlaceholderCount(0), 0);
  assert.match(page, /bagPlaceholderCount\(freeSlots\)/);
  assert.match(page, /\+ \{hiddenFreeSlots\} свободных слотов/);
  assert.match(page, /bag\.map\(\(item\) => <InventoryCell/);
  assert.match(css, /\.prod-bag-grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
});

test("inventory operation IDs use a UUID v4 source compatible with HTTP LAN contexts", () => {
  const operationId = model.createInventoryOperationId();
  assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(modelSource, /globalThis\.crypto\.getRandomValues/);
  assert.doesNotMatch(modelSource, /crypto\.randomUUID/);
});

test("category and rarity labels are localized and null rarity stays absent", () => {
  assert.deepEqual(Object.values(model.INVENTORY_CATEGORY_LABELS), ["Ключевой предмет", "Документ", "Инструмент", "Расходник", "Снаряжение", "Артефакт", "Особое"]);
  assert.deepEqual(Object.values(model.INVENTORY_RARITY_LABELS), ["Обычный", "Необычный", "Редкий", "Уникальный"]);
  assert.match(page, /INVENTORY_CATEGORY_LABELS\[item\.category\]/);
  assert.match(page, /item\.rarity && <span className=\{`prod-rarity/);
  assert.match(page, /onTransfer=\{beginTransfer\}/);
  assert.match(page, /onDiscard=\{\(\) =>/);
});

test("equip logic rejects stacks, read-only controllers, non-equippable items, and occupied slots", () => {
  const candidate = item();
  assert.equal(model.canEquipInventoryItem([candidate], candidate, true, 12), true);
  assert.equal(model.canEquipInventoryItem([candidate], candidate, false, 12), false, "historical Player is read-only");
  assert.equal(model.canEquipInventoryItem([item({ quantity: 2 })], item({ quantity: 2 }), true, 12), false);
  assert.equal(model.canEquipInventoryItem([item({ equipmentSlot: null })], item({ equipmentSlot: null }), true, 12), false);
  const equippedPrimary = item({ id: "worn", equippedSlot: "primary", equipmentSlot: "primary" });
  assert.equal(model.canEquipInventoryItem([equippedPrimary, candidate], candidate, true, 12), false,
    "occupied slots do not trigger automatic replacement");
  assert.match(page, /Сначала снимите текущий предмет/);
  assert.match(page, /Стопки больше одной единицы пока нельзя экипировать/);
});

test("unequip supports same-catalog merge at full capacity only when a stack can accept it", () => {
  const equipped = item({ id: "worn", equippedSlot: "accessory", equipmentSlot: "accessory" });
  const bagStack = item({ id: "stack", quantity: 4, equippedSlot: null });
  assert.equal(model.canUnequipInventoryItem([equipped, bagStack], 1, equipped), true);
  assert.equal(model.canUnequipInventoryItem([equipped, item({ id: "other", catalogItemId: "other", equippedSlot: null })], 1, equipped), false);
  assert.equal(model.canUnequipInventoryItem([equipped, item({ id: "full-stack", quantity: 9999, equippedSlot: null })], 1, equipped), false);
  assert.match(page, /role="dialog" aria-modal="true" aria-labelledby="item-detail-title"/);
  assert.match(page, /aria-label="Закрыть"/);
  assert.match(page, /event\.key === "Escape"/);
});

test("details gate equip, transfer, and discard by controller and independent permission flags", () => {
  assert.match(page, /item\.equippedSlot === null/);
  assert.match(page, /Экипировать:/);
  assert.match(page, />Снять<\/button>/);
  assert.match(page, /item\.transferAllowed/);
  assert.match(page, /item\.discardAllowed/);
  assert.match(page, /Этот предмет нельзя передавать\./);
  assert.match(page, /Этот предмет нельзя выбросить\./);
  assert.match(page, /Сначала снимите предмет, чтобы передать или выбросить его/);
  assert.match(page, /aria-label=\{`\$\{EQUIPMENT_SLOT_LABELS\[slot\]\}: пусто`\}/);
  assert.match(css, /@media \(max-width: 380px\)/);
  assert.match(css, /max-height: min\(84dvh, 680px\)/);
});

test("transfer sheet presents only narrow character targets with capacity, merge, and quantity guards", () => {
  assert.match(page, /onLoadTransferTargets\(selectedItem\.id\)/);
  assert.match(page, /role="radiogroup" aria-label="Получатель"/);
  assert.match(page, /Сумка \{entry\.bagSlotsUsed\} \/ \{entry\.inventoryCapacity\}/);
  assert.match(page, /entry\.willMerge \? "Уже есть"/);
  assert.match(page, /Сейчас некому передать предмет\./);
  assert.match(page, /target\.maxQuantity < quantity/);
  assert.match(page, /error=\{sheetError \|\| actionError\}/);
  assert.match(page, /disabled=\{!canSubmit\}/);
  assert.match(page, /createInventoryOperationId\(\)/);
  assert.match(page, /outcome !== "ambiguous"/);
  assert.match(workspace, /transfer-targets/);
});

test("discard requires an explicit sheet confirmation and supports partial stacks", () => {
  assert.match(page, /Выбросить предмет\?/);
  assert.match(page, /Сколько выбросить\?/);
  assert.match(page, /Предмет исчезнет из инвентаря персонажа\./);
  assert.match(page, /error && <p className="prod-feedback is-error" role="alert">\{error\}<\/p>/);
  assert.match(page, /onDiscard\(selectedItem\.id, actionQuantity/);
  assert.match(css, /\.prod-discard-warning/);
  assert.match(css, /\.prod-player \.prod-danger/);
});
