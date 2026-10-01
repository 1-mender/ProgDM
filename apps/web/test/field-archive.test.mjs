import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/visual-lab/model.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { variants, refinedArchive } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

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
