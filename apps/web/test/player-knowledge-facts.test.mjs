import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/player/KnowledgePage.tsx", import.meta.url), "utf8");
const model = readFileSync(new URL("../src/player/model.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/player/player.css", import.meta.url), "utf8");

test("Player Knowledge detail separates optional summary from revealed Facts", () => {
  assert.match(page, /selected\.summaryVisible && selected\.summary !== null/);
  assert.match(page, /<h2>Кратко<\/h2>/);
  assert.match(page, /selected\.facts\.length > 0/);
  assert.match(page, /<h2>Что известно<\/h2>/);
  assert.match(page, /\{fact\.body\}/);
  assert.match(page, /fact\.sessionName \? `Открыто: \$\{fact\.sessionName\}`/);
  assert.match(page, /Открыто вне сессии/);
  assert.doesNotMatch(page, /selected\.description|entry\.description|visibleToCharacterId|operationId|audience|ACL/);
});

test("Player Knowledge search can match only projected title, category, visible summary, and Facts", () => {
  assert.match(page, /entry\.title, KNOWLEDGE_CATEGORY_LABELS\[entry\.category\]/);
  assert.match(page, /entry\.summaryVisible && entry\.summary !== null \? \[entry\.summary\]/);
  assert.match(page, /\.\.\.entry\.facts\.map\(\(fact\) => fact\.body\)/);
  assert.doesNotMatch(page, /entry\.description|visibility|visibleToCharacterId/);
  assert.match(page, /const categoryOrder: KnowledgeCategory\[\] = \["character", "place", "creature", "item", "event", "fact"\]/);
  assert.match(model, /character: "Персонажи",[\s\S]*place: "Места",[\s\S]*creature: "Существа",[\s\S]*item: "Предметы",[\s\S]*event: "События",[\s\S]*fact: "Факты"/);
});

test("revealed Fact rows use restrained mobile-readable separators", () => {
  assert.match(styles, /\.prod-knowledge-facts li \{[^}]*padding: 12px 0;[^}]*border-bottom: 1px solid var\(--player-divider\)/);
  assert.match(styles, /\.prod-knowledge-detail section p \{[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /\.prod-knowledge-detail \.prod-knowledge-facts li small \{[^}]*font-size: 12px/);
});
