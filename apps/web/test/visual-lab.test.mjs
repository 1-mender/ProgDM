import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/visual-lab/model.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const model = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

test("visual variants share one fixed mock character, inventory, updates and navigation", () => {
  assert.deepEqual(model.character, { name: "Mira Voss", archetype: "Следопыт", origin: "Северный округ" });
  assert.deepEqual(model.inventory.map(item => item.name), ["Старинный ключ", "Записная книжка", "Амулет"]);
  assert.deepEqual(model.updates.map(update => update.text), ["Получен предмет «Старинный ключ»", "Открыто знание «Аптекарь»", "Получено письмо"]);
  assert.deepEqual(model.navigation, ["Главная", "Инвентарь", "Знания", "Журнал", "Профиль"]);
  assert.equal(new Set(model.updates.map(update => update.id)).size, 3);
  assert.equal(new Set(model.inventory.map(item => item.id)).size, 3);
});

test("three distinct palettes provide complete visual tokens and readable surface text", () => {
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  assert.deepEqual(model.variants.map(variant => variant.id), ["a", "b", "c"]);
  assert.equal(new Set(model.variants.map(variant => variant.surface)).size, 3);
  for (const variant of model.variants) {
    for (const key of ["background", "surface", "text", "accent", "border", "muted"]) assert.match(variant[key], /^#[0-9a-f]{6}$/);
    assert.ok(variant.heading && variant.body);
    for (const foreground of [variant.text, variant.muted, variant.accent]) {
      const levels = [luminance(foreground), luminance(variant.surface)].sort((a, b) => b - a);
      assert.ok((levels[0] + 0.05) / (levels[1] + 0.05) >= 4.5, `${variant.name}: ${foreground} contrast`);
    }
  }
});
