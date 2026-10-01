import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/sync.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { LatestRequest, loadJoinSnapshot, joinName, mergeProfileDraft, approvalTarget } =
  await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

test("pending and rejected players recheck invitations on every refresh", async () => {
  let active = true;
  let checks = 0;
  const invite = async () => { checks++; if (!active) throw Object.assign(new Error("Closed"), { status: 404 }); return { sessionName: "Session" }; };
  const player = async () => ({ status: "pending" });
  await loadJoinSnapshot("token", player, invite);
  active = false;
  await assert.rejects(loadJoinSnapshot("token", player, invite), { status: 404 });
  await assert.rejects(loadJoinSnapshot("token", async () => ({ status: "rejected" }), invite), { status: 404 });
  assert.equal(checks, 3);
});

test("historical approved token loads even when invitation is closed", async () => {
  const snapshot = await loadJoinSnapshot("token", async () => ({ status: "approved", canEdit: false }),
    async () => { assert.fail("Approved historical access must not require a live invitation"); });
  assert.equal(snapshot.player.status, "approved");
  assert.equal(snapshot.player.canEdit, false);
});

test("rejected form uses the same name for input, button and submission; empty draft stays empty", () => {
  assert.equal(joinName(null, "Аня"), "Аня");
  assert.equal(Boolean(joinName(null, "Аня").trim()), true);
  assert.equal(joinName("", "Аня"), "");
  assert.equal(joinName("Другое", "Аня"), "Другое");
});

test("late responses cannot replace a newer selection or reopen a closed context", async () => {
  const requests = new LatestRequest();
  let complete;
  const delayed = new Promise((resolve) => { complete = resolve; });
  const old = requests.begin();
  const result = delayed.then(() => requests.isCurrent(old));
  const latest = requests.begin();
  assert.equal(requests.isCurrent(latest), true);
  complete();
  assert.equal(await result, false);
  requests.invalidate();
  assert.equal(requests.isCurrent(latest), false);
});

test("overview refresh updates untouched fields but preserves unsaved DM edits", () => {
  const original = { id: "Mira", name: "Mira", shortDescription: "Old", personalGoal: "Old goal", archetype: "Scout", origin: "North", dmNotes: "Private" };
  const draft = { ...original, dmNotes: "Unsaved", name: "New name" };
  const updated = { ...original, shortDescription: "Player update", personalGoal: "Player goal", archivedAt: "date" };
  assert.deepEqual(mergeProfileDraft(draft, original, updated), { ...updated, dmNotes: "Unsaved", name: "New name" });
  assert.deepEqual(mergeProfileDraft(null, null, updated), updated);
  assert.deepEqual(mergeProfileDraft(draft, original, { ...updated, id: "Nora" }), { ...updated, id: "Nora" });
});

test("a stale selected character never silently falls back to creating a character", () => {
  assert.deepEqual(approvalTarget("assigned-elsewhere", "New character"), { characterId: "assigned-elsewhere" });
  assert.deepEqual(approvalTarget("", "New character"), { characterName: "New character" });
});
