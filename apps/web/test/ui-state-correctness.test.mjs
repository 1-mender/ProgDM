import assert from "node:assert/strict";
import test from "node:test";
import { button, componentRuntime, elements, loadTs } from "./helpers/runtime.mjs";

const profile = (overrides = {}) => ({ shortDescription: "Original", personalGoal: "Goal", traits: ["Careful"],
  appearance: "Coat", quote: "Quote", archetype: "Scout", origin: "North", profileFields: [], ...overrides });
const player = (overrides = {}) => ({ characterId: "Mira", characterName: "Mira", displayName: "Player", canEdit: true,
  profile: profile(), knowledge: [], notes: [], recentActivity: [], newActivity: [], ...overrides });
const field = (runtime, id) => elements(runtime.tree, (node) => node.props?.id === id)[0];
const input = (runtime, label) => elements(runtime.tree, (node) => node.type === "input" && node.props["aria-label"] === label)[0];
const change = (runtime, control, value) => { control.props.onChange({ target: { value } }); runtime.render(); };
function profileRuntime(properties = {}) {
  const runtime = componentRuntime();
  const { ProfilePage } = loadTs(new URL("../src/player/ProfilePage.tsx", import.meta.url), { react: runtime.react });
  const props = { player: player(), busy: false, onSave: async () => false, ...properties };
  runtime.mount(ProfilePage, props);
  return { runtime, props };
}

test("Profile edit preserves all draft fields and trait input during canonical polling; Cancel restores newest truth", () => {
  const { runtime, props } = profileRuntime();
  button(runtime.tree, "Редактировать").props.onClick(); runtime.render();
  for (const [id, value] of [["description", "Draft description"], ["goal", "Draft goal"], ["appearance", "Draft appearance"], ["quote", "Draft quote"]]) {
    change(runtime, field(runtime, "prod-profile-" + id), value);
  }
  change(runtime, input(runtime, "Черта 1"), "Draft trait");
  change(runtime, input(runtime, "Новая черта"), "Not added yet");
  const newest = player({ profile: profile({ shortDescription: "DM description", personalGoal: "DM goal", traits: ["DM trait"], appearance: "DM appearance", quote: "DM quote" }) });
  runtime.rerender({ ...props, player: newest });
  assert.equal(field(runtime, "prod-profile-description").props.value, "Draft description");
  assert.equal(field(runtime, "prod-profile-goal").props.value, "Draft goal");
  assert.equal(field(runtime, "prod-profile-appearance").props.value, "Draft appearance");
  assert.equal(field(runtime, "prod-profile-quote").props.value, "Draft quote");
  assert.equal(input(runtime, "Черта 1").props.value, "Draft trait");
  assert.equal(input(runtime, "Новая черта").props.value, "Not added yet");
  button(runtime.tree, "Отмена").props.onClick(); runtime.render();
  assert.equal(elements(runtime.tree, (node) => node.type === "form").length, 0);
  button(runtime.tree, "Редактировать").props.onClick(); runtime.render();
  assert.equal(field(runtime, "prod-profile-description").props.value, "DM description");
  assert.equal(field(runtime, "prod-profile-goal").props.value, "DM goal");
  assert.equal(field(runtime, "prod-profile-appearance").props.value, "DM appearance");
  assert.equal(field(runtime, "prod-profile-quote").props.value, "DM quote");
  assert.equal(input(runtime, "Черта 1").props.value, "DM trait");
  assert.equal(input(runtime, "Новая черта").props.value, "");
});

test("Profile failed save leaves edit mode and every draft value available for retry", async () => {
  let saved;
  const { runtime } = profileRuntime({ onSave: async (fields) => { saved = fields; return false; } });
  button(runtime.tree, "Редактировать").props.onClick(); runtime.render();
  change(runtime, field(runtime, "prod-profile-description"), "Failed draft");
  change(runtime, input(runtime, "Новая черта"), "Still typing");
  elements(runtime.tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await runtime.settle();
  assert.equal(saved.shortDescription, "Failed draft");
  assert.equal(field(runtime, "prod-profile-description").props.value, "Failed draft");
  assert.equal(input(runtime, "Новая черта").props.value, "Still typing");
});

test("Profile successful save closes editor and reopens from refreshed canonical values", async () => {
  let runtime;
  let props;
  ({ runtime, props } = profileRuntime({ onSave: async (fields) => {
    props = { ...props, player: player({ profile: profile({ ...fields, quote: "Server quote" }) }) };
    runtime.rerender(props);
    return true;
  } }));
  button(runtime.tree, "Редактировать").props.onClick(); runtime.render();
  change(runtime, field(runtime, "prod-profile-description"), "Saved draft");
  elements(runtime.tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await runtime.settle();
  assert.equal(elements(runtime.tree, (node) => node.type === "form").length, 0);
  assert.match(JSON.stringify(runtime.tree), /Saved draft/);
  button(runtime.tree, "Редактировать").props.onClick(); runtime.render();
  assert.equal(field(runtime, "prod-profile-quote").props.value, "Server quote");
});

test("Profile polling outside editing updates read mode and next Edit uses current canonical fields", () => {
  const { runtime, props } = profileRuntime();
  runtime.rerender({ ...props, player: player({ profile: profile({ shortDescription: "Newest canonical", traits: ["New trait"] }) }) });
  assert.match(JSON.stringify(runtime.tree), /Newest canonical/);
  button(runtime.tree, "Редактировать").props.onClick(); runtime.render();
  assert.equal(field(runtime, "prod-profile-description").props.value, "Newest canonical");
  assert.equal(input(runtime, "Черта 1").props.value, "New trait");
});

const event = (id, minute = 1, overrides = {}) => ({ id, kind: "item_received", itemName: id, quantity: 1,
  createdAt: `2026-10-08T12:${String(minute).padStart(2, "0")}:00.000Z`, sessionId: "session", sessionName: "Session", ...overrides });
const cursor = (id) => ({ beforeCreatedAt: "2026-10-08T12:00:00.000Z", beforeId: id });
const timeline = (runtime) => elements(runtime.tree, (node) => node.type === "li" && elements(node, (child) => child.props?.className === "prod-chronicle-event").length).map((node) => node.key);
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function journalRuntime(onLoadPage, overrides = {}) {
  const runtime = componentRuntime();
  const { JournalPage } = loadTs(new URL("../src/player/JournalPage.tsx", import.meta.url), { react: runtime.react });
  let props = { player: player({ recentActivity: [event("A")] }), activeTab: "chronicle", onTabChange() {}, onLoadPage,
    onOpenKnowledge() {}, onMarkSeen() {}, onSaveNote: async () => true, busy: false, ...overrides };
  runtime.mount(JournalPage, props); await runtime.settle();
  return { runtime, update: (patch) => { props = { ...props, ...patch }; runtime.rerender(props); }, get props() { return props; } };
}

test("Chronicle polling adds a new head without clearing events, closing detail or duplicating IDs", async () => {
  let calls = 0;
  const pending = deferred();
  const state = await journalRuntime(async () => ++calls === 1 ? { events: [event("A")], nextCursor: cursor("A") } : pending.promise);
  const { runtime } = state;
  elements(runtime.tree, (node) => node.props?.className === "prod-chronicle-event")[0].props.onClick(); runtime.render();
  state.update({ player: player({ recentActivity: [event("B", 2), event("A")] }) });
  assert.equal(calls, 2);
  assert.ok(field(runtime, "prod-journal-detail-title"));
  assert.doesNotMatch(JSON.stringify(runtime.tree), /Загружаем хронику/);
  pending.resolve({ events: [event("B", 2), event("A"), event("A")], nextCursor: cursor("new-head") });
  await runtime.settle();
  assert.ok(field(runtime, "prod-journal-detail-title"), "safe selected detail stays open");
  elements(runtime.tree, (node) => node.props?.className === "prod-back")[0].props.onClick(); runtime.render();
  assert.deepEqual(timeline(runtime), ["B", "A"]);
});

test("Chronicle preserves loaded older pages and their tail cursor during head refresh", async () => {
  const requests = [];
  const state = await journalRuntime(async (before) => {
    requests.push(before);
    if (requests.length === 1) return { events: [event("A", 3)], nextCursor: cursor("first-tail") };
    if (requests.length === 2) return { events: [event("OLD", 1)], nextCursor: cursor("older-tail") };
    if (requests.length === 3) return { events: [event("B", 4), event("A", 3)], nextCursor: cursor("new-head-tail") };
    return { events: [event("LAST", 0)], nextCursor: null };
  });
  button(state.runtime.tree, "Показать более ранние").props.onClick(); await state.runtime.settle();
  state.update({ player: player({ recentActivity: [event("B", 4), event("A", 3)] }) }); await state.runtime.settle();
  assert.deepEqual(timeline(state.runtime), ["B", "A", "OLD"]);
  button(state.runtime.tree, "Показать более ранние").props.onClick(); await state.runtime.settle();
  assert.deepEqual(requests[3], cursor("older-tail"));
  assert.deepEqual(timeline(state.runtime), ["B", "A", "OLD", "LAST"]);
});

test("Chronicle with only page one adopts the refreshed cursor and deterministic createdAt/id ordering", async () => {
  const requests = [];
  const state = await journalRuntime(async (before) => {
    requests.push(before);
    if (requests.length === 1) return { events: [event("A")], nextCursor: cursor("old") };
    if (requests.length === 2) return { events: [event("B", 2), event("Z", 2), event("B", 2), event("A")], nextCursor: cursor("new") };
    return { events: [], nextCursor: null };
  });
  state.update({ player: player({ recentActivity: [event("Z", 2), event("B", 2), event("A")] }) }); await state.runtime.settle();
  assert.deepEqual(timeline(state.runtime), ["Z", "B", "A"]);
  button(state.runtime.tree, "Показать более ранние").props.onClick(); await state.runtime.settle();
  assert.deepEqual(requests[2], cursor("new"));
});

test("Chronicle ignores unchanged polling and mark-seen/newActivity-only changes", async () => {
  let calls = 0;
  const state = await journalRuntime(async () => { calls++; return { events: [event("A")], nextCursor: null }; });
  state.update({ player: player({ recentActivity: [event("A")], newActivity: [event("A")] }) }); await state.runtime.settle();
  state.update({ player: player({ recentActivity: [event("A")], newActivity: [], notes: [{ id: "note" }] }) }); await state.runtime.settle();
  assert.equal(calls, 1);
  assert.deepEqual(timeline(state.runtime), ["A"]);
});

test("Chronicle immediately drops revoked Knowledge and closes its detail even if an old head response arrives late", async () => {
  const knowledge = { id: "entry", title: "Safe title", category: "fact", summaryVisible: true, summary: "Summary", facts: [] };
  const opened = event("K", 1, { kind: "knowledge_summary_opened", knowledgeEntryId: "entry", knowledgeTitle: "Safe title" });
  const pending = deferred();
  let calls = 0;
  const state = await journalRuntime(async () => ++calls === 1 ? { events: [opened, event("A", 0)], nextCursor: null } : pending.promise,
    { player: player({ knowledge: [knowledge], recentActivity: [opened, event("A", 0)] }) });
  elements(state.runtime.tree, (node) => node.props?.className === "prod-chronicle-event")[0].props.onClick(); state.runtime.render();
  assert.match(JSON.stringify(state.runtime.tree), /Safe title/);
  state.update({ player: player({ knowledge: [], recentActivity: [event("A", 0)] }) });
  assert.equal(field(state.runtime, "prod-journal-detail-title"), undefined);
  assert.doesNotMatch(JSON.stringify(state.runtime.tree), /Safe title/);
  pending.resolve({ events: [opened, event("A", 0)], nextCursor: null }); await state.runtime.settle();
  assert.deepEqual(timeline(state.runtime), ["A"]);
  assert.doesNotMatch(JSON.stringify(state.runtime.tree), /Safe title/);
});

test("Chronicle filters summary/fact access independently and uses current Knowledge title", async () => {
  const summary = event("S", 2, { kind: "knowledge_summary_opened", knowledgeEntryId: "entry", knowledgeTitle: "Stale title" });
  const facts = event("F", 1, { kind: "knowledge_facts_revealed", knowledgeEntryId: "entry", knowledgeTitle: "Stale title" });
  const state = await journalRuntime(async () => ({ events: [summary, facts], nextCursor: null }), {
    player: player({ recentActivity: [summary, facts], knowledge: [{ id: "entry", title: "Current title", summaryVisible: false, facts: [{ id: "fact" }] }] })
  });
  assert.deepEqual(timeline(state.runtime), ["F"]);
  assert.doesNotMatch(JSON.stringify(state.runtime.tree), /Stale title/);
  state.update({ player: player({ recentActivity: [], knowledge: [{ id: "entry", title: "Current title", summaryVisible: true, facts: [] }] }) });
  await state.runtime.settle();
  assert.deepEqual(timeline(state.runtime), ["S"]);
});

test("Chronicle background failure preserves events, cursor and selected detail; retry is quiet", async () => {
  let calls = 0;
  const state = await journalRuntime(async () => {
    calls++;
    if (calls === 2) throw new Error("offline");
    return { events: calls === 1 ? [event("A")] : [event("B", 2), event("A")], nextCursor: cursor("tail") };
  });
  elements(state.runtime.tree, (node) => node.props?.className === "prod-chronicle-event")[0].props.onClick(); state.runtime.render();
  state.update({ player: player({ recentActivity: [event("B", 2), event("A")] }) }); await state.runtime.settle();
  assert.ok(field(state.runtime, "prod-journal-detail-title"));
  assert.doesNotMatch(JSON.stringify(state.runtime.tree), /Загружаем хронику/);
  button(state.runtime.tree, "Повторить").props.onClick(); await state.runtime.settle();
  assert.ok(field(state.runtime, "prod-journal-detail-title"));
  elements(state.runtime.tree, (node) => node.props?.className === "prod-back")[0].props.onClick(); state.runtime.render();
  assert.deepEqual(timeline(state.runtime), ["B", "A"]);
});

test("Chronicle rejects late head results after a newer refresh or leaving the tab", async () => {
  const first = deferred(); const second = deferred();
  let calls = 0;
  const state = await journalRuntime(async () => {
    calls++;
    return calls === 1 ? { events: [event("A")], nextCursor: null } : calls === 2 ? first.promise : second.promise;
  });
  state.update({ player: player({ recentActivity: [event("B", 2)] }) });
  state.update({ player: player({ recentActivity: [event("C", 3)] }) });
  second.resolve({ events: [event("C", 3), event("A")], nextCursor: null }); await state.runtime.settle();
  first.resolve({ events: [event("B", 2)], nextCursor: null }); await state.runtime.settle();
  assert.deepEqual(timeline(state.runtime), ["C", "A"]);
  state.update({ activeTab: "notes", player: player({ recentActivity: [event("D", 4)] }) }); await state.runtime.settle();
  assert.equal(calls, 3);
  assert.equal(field(state.runtime, "prod-journal-detail-title"), undefined);
});

test("Chronicle bridges a multi-page burst without losing events above its saved tail cursor", async () => {
  const requests = [];
  const state = await journalRuntime(async (before) => {
    requests.push(before);
    if (requests.length === 1) return { events: [event("A", 1)], nextCursor: cursor("initial") };
    if (requests.length === 2) return { events: [event("OLD", 0)], nextCursor: cursor("tail") };
    if (requests.length === 3) return { events: [event("C", 3)], nextCursor: cursor("bridge") };
    return { events: [event("B", 2), event("A", 1)], nextCursor: cursor("head-tail") };
  });
  button(state.runtime.tree, "Показать более ранние").props.onClick(); await state.runtime.settle();
  state.update({ player: player({ recentActivity: [event("C", 3), event("B", 2)] }) }); await state.runtime.settle();
  assert.deepEqual(requests[3], cursor("bridge"));
  assert.deepEqual(timeline(state.runtime), ["C", "B", "A", "OLD"]);
});

test("Chronicle head and load-more responses preserve the tail cursor in either completion order", async () => {
  for (const headFirst of [true, false]) {
    const head = deferred(); const more = deferred(); const requests = [];
    const state = await journalRuntime(async (before) => {
      requests.push(before);
      if (requests.length === 1) return { events: [event("A", 3)], nextCursor: cursor("initial") };
      if (requests.length === 2) return more.promise;
      if (requests.length === 3) return head.promise;
      return { events: [event("LAST", 0)], nextCursor: null };
    });
    button(state.runtime.tree, "Показать более ранние").props.onClick(); state.runtime.render();
    state.update({ player: player({ recentActivity: [event("B", 4), event("A", 3)] }) });
    const finishHead = () => head.resolve({ events: [event("B", 4), event("A", 3)], nextCursor: cursor("new-head") });
    const finishMore = () => more.resolve({ events: [event("OLD", 1)], nextCursor: cursor("tail") });
    if (headFirst) finishHead(); else finishMore(); await state.runtime.settle();
    if (headFirst) finishMore(); else finishHead(); await state.runtime.settle();
    assert.deepEqual(timeline(state.runtime), ["B", "A", "OLD"]);
    button(state.runtime.tree, "Показать более ранние").props.onClick(); await state.runtime.settle();
    assert.deepEqual(requests[3], cursor("tail"));
    state.runtime.unmount();
  }
});

test("Chronicle polling during initial load refreshes the changed head after initialization", async () => {
  const initial = deferred(); let calls = 0;
  const state = await journalRuntime(async () => ++calls === 1 ? initial.promise : { events: [event("B", 2), event("A")], nextCursor: null });
  state.update({ player: player({ recentActivity: [event("B", 2), event("A")] }) });
  assert.equal(calls, 1);
  initial.resolve({ events: [event("A")], nextCursor: null }); await state.runtime.settle();
  assert.equal(calls, 2);
  assert.deepEqual(timeline(state.runtime), ["B", "A"]);
});

test("Chronicle leaving and reopening invalidates an in-flight head response", async () => {
  const head = deferred(); let calls = 0;
  const state = await journalRuntime(async () => {
    calls++;
    return calls === 1 ? { events: [event("A")], nextCursor: null }
      : calls === 2 ? head.promise : { events: [event("C", 3)], nextCursor: null };
  });
  state.update({ player: player({ recentActivity: [event("B", 2)] }) });
  state.update({ activeTab: "notes" });
  state.update({ activeTab: "chronicle", player: player({ recentActivity: [event("C", 3)] }) }); await state.runtime.settle();
  head.resolve({ events: [event("B", 2)], nextCursor: null }); await state.runtime.settle();
  assert.deepEqual(timeline(state.runtime), ["C"]);
});

test("Chronicle replaces an exhausted tail cursor when all cached events become hidden", async () => {
  const opened = event("K", 2, { kind: "knowledge_summary_opened", knowledgeEntryId: "entry", knowledgeTitle: "Old title" });
  const requests = [];
  const state = await journalRuntime(async (before) => {
    requests.push(before);
    if (requests.length === 1) return { events: [opened], nextCursor: cursor("old") };
    if (requests.length === 2) return { events: [], nextCursor: null };
    if (requests.length === 3) return { events: [event("B", 4)], nextCursor: cursor("new") };
    return { events: [event("A", 3)], nextCursor: null };
  }, { player: player({ recentActivity: [opened], knowledge: [{ id: "entry", title: "Old title", summaryVisible: true, facts: [] }] }) });
  button(state.runtime.tree, "Показать более ранние").props.onClick(); await state.runtime.settle();
  state.update({ player: player({ recentActivity: [event("B", 4)], knowledge: [] }) }); await state.runtime.settle();
  assert.deepEqual(timeline(state.runtime), ["B"]);
  button(state.runtime.tree, "Показать более ранние").props.onClick(); await state.runtime.settle();
  assert.deepEqual(requests[3], cursor("new"));
  assert.deepEqual(timeline(state.runtime), ["B", "A"]);
});
