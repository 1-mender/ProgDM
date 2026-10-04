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
const personalNotes = read("../src/player/PersonalNotesPage.tsx");
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

test("Home digest groups only same-entry Fact reveals and keeps the latest event as representative", () => {
  const base = { sessionId: "session", sessionName: "Chapter", createdAt: "2026-10-04T12:00:00.000Z" };
  const events = [
    { ...base, id: "06", kind: "knowledge_facts_revealed", knowledgeEntryId: "entry-a", knowledgeTitle: "Apothecary", createdAt: "2026-10-04T12:06:00.000Z" },
    { ...base, id: "05", kind: "knowledge_facts_revealed", knowledgeEntryId: "entry-a", knowledgeTitle: "Apothecary", createdAt: "2026-10-04T12:05:00.000Z" },
    { ...base, id: "04", kind: "knowledge_facts_revealed", knowledgeEntryId: "entry-b", knowledgeTitle: "Old bridge", createdAt: "2026-10-04T12:04:00.000Z" },
    { ...base, id: "03", kind: "item_received", itemName: "Key", quantity: 1, createdAt: "2026-10-04T12:03:00.000Z" },
    { ...base, id: "02", kind: "knowledge_summary_opened", knowledgeEntryId: "entry-c", knowledgeTitle: "North road", createdAt: "2026-10-04T12:02:00.000Z" }
  ];
  const digest = model.homeActivityDigest(events);
  assert.deepEqual(digest.map(({ id }) => id), ["06", "04", "03"]);
  assert.equal(digest.length, 3);
  assert.equal(digest.filter((event) => event.kind === "knowledge_facts_revealed" && event.knowledgeEntryId === "entry-a").length, 1);
  assert.equal(digest[0].createdAt, events[0].createdAt);
  assert.equal(digest[0].id, "06");
  assert.equal(model.homeActivityDigest([{ ...events[0], id: "07", createdAt: "2026-10-04T12:07:00.000Z" }])[0].id, "07",
    "a later reveal is a fresh digest item after the caller recomputes unseen events");
  assert.match(home, /homeActivityDigest\(player\.newActivity\)/);
  assert.match(home, /onClick=\{onProfile\}/);
  assert.match(home, /onClick=\{\(\) => onMarkSeen\(latest\.id\)\}/);
  assert.match(workspace, /"\/api\/player\/activity\/seen"/);
});

test("Home and Journal use player-facing explicit event labels with no generic fallback", () => {
  const common = { createdAt: "2026-10-04T12:00:00.000Z", sessionId: null, sessionName: null };
  const item = { ...common, id: "a", kind: "item_received", itemName: "Старинный ключ", quantity: 2 };
  const summary = { ...common, id: "b", kind: "knowledge_summary_opened", knowledgeEntryId: "entry", knowledgeTitle: "Аптекарь" };
  const facts = { ...common, id: "c", kind: "knowledge_facts_revealed", knowledgeEntryId: "entry", knowledgeTitle: "Аптекарь" };
  assert.equal(model.homeActivityLabel(item), "Получен предмет «Старинный ключ»");
  assert.equal(model.homeActivityLabel(summary), "Открыто знание «Аптекарь»");
  assert.equal(model.homeActivityLabel(facts), "Новые сведения «Аптекарь»");
  assert.equal(model.journalActivityLabel(item), "Получен предмет: Старинный ключ × 2");
  assert.equal(model.journalActivityLabel(summary), "Открыто знание: Аптекарь");
  assert.equal(model.journalActivityLabel(facts), "Открыты новые сведения: Аптекарь");
  assert.match(modelSource, /switch \(event\.kind\)/);
  assert.match(modelSource, /assertNever\(event\)/);
  assert.match(workspace, /journalActivityLabel\(event\)/);
  assert.match(workspace, /event\.sessionName &&/);
  assert.doesNotMatch(home, /CampaignActivity|event\.type/);
  assert.doesNotMatch(workspace, /event\.type|event\.details/);
  assert.match(home, /Пока ничего нового\./);
});

test("Profile uses only existing player-safe fields and guards its existing edit action", () => {
  for (const field of ["characterName", "archetype", "origin", "shortDescription", "personalGoal", "traits", "appearance", "quote"]) assert.ok(profile.includes(field));
  assert.equal(profile.includes("dmNotes"), false);
  assert.match(profile, /player\.canEdit/);
  assert.match(profile, /onSave\(\{ shortDescription: description, personalGoal: goal, traits, appearance, quote \}\)/);
  assert.match(profile, /traitDraft\.trim\(\)/);
  assert.match(profile, /traits\.length >= 8/);
  assert.match(profile, /Черты/);
  assert.match(profile, /Внешность/);
  assert.match(profile, /Цитата/);
});

test("Profile renders campaign fields read-only and omits empty values", () => {
  assert.match(profile, /profile\?\.profileFields\.length/);
  assert.match(profile, /profile\.profileFields\.filter\(\(field\) => field\.value\.trim\(\)\)/);
  assert.match(profile, /<dt>\{field\.label\}<\/dt><dd>\{field\.value\}<\/dd>/);
  assert.equal(profile.includes("setProfileField"), false);
});

test("Knowledge filters all six universal categories and maps player labels", () => {
  for (const [value, label] of [["character", "Персонажи"], ["place", "Места"], ["creature", "Существа"], ["item", "Предметы"], ["event", "События"], ["fact", "Факты"]]) {
    assert.equal(model.KNOWLEDGE_CATEGORY_LABELS[value], label);
  }
  assert.match(knowledge, /categoryOrder: KnowledgeCategory\[\] = \["character", "place", "creature", "item", "event", "fact"\]/);
  assert.match(knowledge, /categoryIcons/);
  assert.match(knowledge, /KNOWLEDGE_CATEGORY_LABELS\[entry\.category\]/);
  assert.match(knowledge, /entry\.summaryVisible && entry\.summary !== null/);
  assert.match(knowledge, /entry\.facts\.map\(\(fact\) => fact\.body\)/);
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
  assert.match(personalNotes, /visibleNotes\.map/);
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

test("Home selects at most two persisted pinned notes and excludes unpinned notes", () => {
  const notes = [
    { id: "a", pinned: false }, { id: "b", pinned: true }, { id: "c", pinned: true }, { id: "d", pinned: true }
  ];
  assert.deepEqual(model.pinnedHomeNotes(notes).map(({ id }) => id), ["b", "c"]);
  assert.match(home, /pinnedHomeNotes\(player\.notes\)/);
  assert.match(home, /onClick=\{onPinnedNotes\}/);
  assert.match(workspace, /setJournalTab\("notes"\)/);
});

test("Personal Notes uses live API state, production metadata labels and an editable plain-text form", () => {
  assert.match(workspace, /<PersonalNotesPage notes=\{player\.notes\}/);
  assert.match(workspace, /playerPost\(credential, noteId \? `\/api\/player\/notes/);
  assert.match(personalNotes, /Закреплено/);
  assert.match(personalNotes, /Все заметки/);
  assert.match(personalNotes, /Тип заметки/);
  assert.match(personalNotes, /Закрепить/);
  assert.match(personalNotes, /maxLength=\{120\}/);
  assert.match(personalNotes, /maxLength=\{2000\}/);
  assert.equal(personalNotes.includes("localStorage"), false);
  assert.equal(personalNotes.includes("checkbox/checkmark"), false);
});

test("untitled notes use a short body preview without mutating their stored title", () => {
  const note = { title: "", body: "Проверить северный мост\nУточнить у дозорного" };
  assert.equal(model.personalNoteDisplayTitle(note), "Проверить северный мост");
  assert.equal(model.personalNoteBodyPreview(note), "Уточнить у дозорного");
  assert.equal(note.title, "");
  assert.deepEqual(Object.keys(model.PERSONAL_NOTE_MARKER_LABELS), ["normal", "important", "check", "question"]);
  assert.equal(model.PERSONAL_NOTE_MARKER_LABELS.check, "Проверить");
});
