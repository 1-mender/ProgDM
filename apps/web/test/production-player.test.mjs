import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const joinPage = read("../src/JoinPage.tsx");
const workspace = read("../src/player/PlayerWorkspace.tsx");
const shell = read("../src/player/PlayerShell.tsx");
const home = read("../src/player/HomePage.tsx");
const profile = read("../src/player/ProfilePage.tsx");
const knowledge = read("../src/player/KnowledgePage.tsx");
const modelSource = read("../src/player/model.ts");
const compiledModel = ts.transpileModule(modelSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const modelModule = { exports: {} };
new Function("require", "module", "exports", compiledModel)(createRequire(import.meta.url), modelModule, modelModule.exports);
const model = modelModule.exports;

test("approved join state uses the production workspace and keeps join states in JoinPage", () => {
  assert.match(joinPage, /import \{ PlayerWorkspace as ProductionPlayerWorkspace \} from "\.\/player\/PlayerWorkspace"/);
  assert.match(joinPage, /player\?\.status === "approved" \? <ProductionPlayerWorkspace/);
  assert.match(joinPage, /player\?\.status === "pending"/);
  assert.match(joinPage, /player\?\.status === "rejected"/);
  assert.match(joinPage, /loadJoinSnapshot/);
  assert.match(joinPage, /setInterval\(\(\) => \{ if \(!submitting\.current\) void refresh\(\); \}, 3000\)/);
});

test("production shell has stable five-section order and exposes settings separately", () => {
  assert.deepEqual(model.PLAYER_NAVIGATION.map(({ label }) => label), ["Главная", "Инвентарь", "Знания", "Журнал", "Профиль"]);
  assert.match(shell, /aria-current=\{view === id \? "page" : undefined\}/);
  assert.match(shell, /onSettings/);
  assert.match(workspace, /onSettings=\{\(\) => navigate\("settings"\)\}/);
});

test("Home digest uses only the server-projected player activity, at most three, and opens Profile", () => {
  const events = Array.from({ length: 5 }, (_, index) => ({ id: String(index) }));
  assert.deepEqual(model.homeActivityDigest(events).map(({ id }) => id), ["0", "1", "2"]);
  assert.match(home, /homeActivityDigest\(player\.newActivity\)/);
  assert.match(home, /onClick=\{onProfile\}/);
  assert.match(home, /onClick=\{\(\) => onMarkSeen\(latest\.id\)\}/);
  assert.match(workspace, /"\/api\/player\/activity\/seen"/);
});

test("Profile uses only existing player-safe fields and guards its existing edit action", () => {
  for (const field of ["characterName", "archetype", "origin", "shortDescription", "personalGoal"]) assert.ok(profile.includes(field));
  assert.equal(profile.includes("dmNotes"), false);
  assert.match(profile, /player\.canEdit/);
  assert.match(profile, /onSave\(\{ shortDescription: description, personalGoal: goal \}\)/);
});

test("Knowledge is filtered from the production-visible snapshot and maps only legacy categories", () => {
  for (const [value, label] of [["npc", "Персонаж мира"], ["monster", "Существо"], ["note", "Заметка"], ["quest", "Событие"]]) {
    assert.equal(model.KNOWLEDGE_CATEGORY_LABELS[value], label);
  }
  assert.match(knowledge, /player\.knowledge\.filter/);
  assert.match(knowledge, /player\.knowledge\.find/);
  assert.equal(knowledge.includes("visual-lab"), false);
  assert.equal(knowledge.includes("hasImage"), false);
});

test("Inventory, Journal, Settings and existing player mutations remain in the production workspace", () => {
  for (const view of ["inventory", "journal"]) assert.ok(workspace.includes(`view === "${view}"`));
  assert.match(workspace, /Настройки/);
  for (const path of ["/api/player/profile", "/api/player/settings", "/api/player/notes", "/api/player/activity/seen"]) assert.ok(workspace.includes(path));
  assert.match(workspace, /player\.inventory\.map/);
  assert.match(workspace, /player\.recentActivity\.map/);
  assert.match(workspace, /player\.notes\.map/);
});

test("neutral initials placeholder derives solely from the live character/player name", () => {
  assert.equal(model.characterInitials("Mira Voss", "Player"), "MV");
  assert.equal(model.characterInitials(null, "Player A"), "PA");
  assert.equal(model.characterInitials("  Mira   Voss  ", "Player"), "MV");
});

test("knowledge count uses correct Russian plural forms", () => {
  assert.equal(model.knowledgeCountLabel(1), "1 запись");
  assert.equal(model.knowledgeCountLabel(2), "2 записи");
  assert.equal(model.knowledgeCountLabel(5), "5 записей");
});
