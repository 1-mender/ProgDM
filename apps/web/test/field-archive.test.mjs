import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/visual-lab/model.ts", import.meta.url), "utf8");
const visualSource = readFileSync(new URL("../src/visual-lab/VisualLab.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { variants, refinedArchive, codexInventory, equipmentSlots, bagCapacity, canFitInBag } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

test("refined archive is a separate B palette; original comparison palettes stay unchanged", () => {
  assert.equal(refinedArchive.id, "b");
  assert.equal(refinedArchive.name, variants[1].name);
  assert.equal(refinedArchive.heading, "Georgia");
  assert.equal(refinedArchive.body, "Arial");
  assert.notEqual(refinedArchive, variants[1]);
  assert.deepEqual(variants.map(({ background, surface, accent }) => ({ background, surface, accent })), [
    { background: "#17191b", surface: "#202326", accent: "#c7ad77" },
    { background: "#292b2b", surface: "#efede5", accent: "#7c3936" },
    { background: "#141a18", surface: "#202824", accent: "#a5cfab" },
  ]);
});

test("refined archive paper retains readable primary, secondary and accent text", () => {
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const foreground of [refinedArchive.text, refinedArchive.muted, refinedArchive.accent]) {
    const levels = [luminance(foreground), luminance(refinedArchive.surface)].sort((a, b) => b - a);
    assert.ok((levels[0] + 0.05) / (levels[1] + 0.05) >= 4.5, `${foreground} contrast on paper`);
  }
});

test("B2 inventory starts with eight one-slot bag stacks and separate universal equipment", () => {
  assert.equal(bagCapacity, 12);
  assert.deepEqual(codexInventory.map(item => item.name), [
    "Старинный ключ", "Записная книжка", "Фляга", "Письмо", "Аптечка", "Компас", "Фонарик", "Верёвка",
  ]);
  assert.equal(codexInventory.reduce((total, item) => total + item.slots, 0), 8);
  assert.ok([...codexInventory, ...equipmentSlots.flatMap(slot => slot.item ? [slot.item] : [])].every(item => item.slots === 1));
  assert.equal(codexInventory.find(item => item.id === "medkit").quantity, 2);
  assert.equal(codexInventory.find(item => item.id === "medkit").slots, 1);
  assert.deepEqual(equipmentSlots.map(slot => slot.name), ["Основное", "Вторичное", "Защита", "Аксессуар", "Инструмент", "Особое"]);
  assert.equal(equipmentSlots.find(slot => slot.id === "accessory").item.name, "Амулет");
  assert.equal(equipmentSlots.find(slot => slot.id === "accessory").item.rarity, "Редкий");
  assert.ok(!codexInventory.some(item => item.id === "amulet"));
  assert.deepEqual(new Set(codexInventory.map(item => item.rarity)), new Set(["Обычный", "Необычный"]));
  assert.equal(codexInventory.find(item => item.id === "key").status, "Ключевой");
  assert.equal(codexInventory.find(item => item.id === "letter").status, "Сюжетный");
});

test("B2 inventory keeps capacity on the bag and moves mock items between bag and equipment", () => {
  assert.match(visualSource, /const bagSlotsUsed = bagItems\.reduce\(\(total, item\) => total \+ item\.slots, 0\)/);
  assert.match(visualSource, /setBagItems\(current => \[\.\.\.current\.filter\(item => item\.id !== selectedItem\.item\.id\), \.\.\.\(replaced \? \[replaced\] : \[\]\)\]\)/);
  assert.match(visualSource, /setBagItems\(current => \[\.\.\.current, selectedItem\.item\]\)/);
  assert.match(visualSource, /inert=\{detailOpen \|\| undefined\}/);
  assert.match(visualSource, /Снять/);
});

test("B2 inventory refuses to return equipped items when the bag has no free slots", () => {
  assert.equal(canFitInBag(11, 1), true);
  assert.equal(canFitInBag(12, 1), false);
  assert.equal(canFitInBag(10, 2), true);
  assert.equal(canFitInBag(11, 2), false);
});
