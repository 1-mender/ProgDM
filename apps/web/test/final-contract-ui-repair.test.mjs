import assert from "node:assert/strict";
import test from "node:test";
import { button, componentRuntime, elements, loadTs, setGlobal } from "./helpers/runtime.mjs";

const note = { id: "note", title: "Original", body: "Original body", marker: "normal", pinned: false };
const control = (runtime, id) => elements(runtime.tree, (node) => node.props?.id === id)[0];
const submit = (runtime) => elements(runtime.tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
function mount(t, overrides = {}) {
  setGlobal(t, "window", { scrollTo() {} });
  const runtime = componentRuntime(), saves = [];
  const { PersonalNotesPage } = loadTs(new URL("../src/player/PersonalNotesPage.tsx", import.meta.url), { react: runtime.react });
  const props = { notes: [note], busy: false, canEdit: true, onSave: async (...args) => { saves.push(args); return false; }, ...overrides };
  runtime.mount(PersonalNotesPage, props);
  return { runtime, props, saves };
}
function edit(runtime) {
  elements(runtime.tree, (node) => node.props?.className === "prod-personal-note-copy")[0].props.onClick(); runtime.render();
  button(runtime.tree, "Редактировать").props.onClick(); runtime.render();
  control(runtime, "prod-note-title").props.onChange({ target: { value: "Draft title" } });
  control(runtime, "prod-note-body").props.onChange({ target: { value: "Unsaved long draft" } });
  control(runtime, "prod-note-marker").props.onChange({ target: { value: "check" } }); runtime.render();
  elements(runtime.tree, (node) => node.type === "input" && node.props.type === "checkbox")[0].props.onChange({ target: { checked: true } }); runtime.render();
}

test("Notes loss of canEdit preserves all draft fields, disables mutations and permits continuing after rights return", async (t) => {
  const { runtime, props, saves } = mount(t); edit(runtime);
  runtime.rerender({ ...props, canEdit: false, notes: [{ ...note, body: "Latest canonical" }] });
  assert.equal(control(runtime, "prod-note-title").props.value, "Draft title");
  assert.equal(control(runtime, "prod-note-body").props.value, "Unsaved long draft");
  assert.equal(control(runtime, "prod-note-marker").props.value, "check");
  const controls = elements(runtime.tree, (node) => ["input", "select", "textarea"].includes(node.type));
  assert.ok(controls.length >= 4); assert.ok(controls.every((node) => node.props.disabled));
  assert.equal(controls.find((node) => node.props.type === "checkbox").props.checked, true);
  assert.equal(button(runtime.tree, "Сохранить").props.disabled, true);
  assert.match(JSON.stringify(runtime.tree), /Несохранённый текст сохранён на этом экране/);
  assert.equal(elements(runtime.tree, (node) => node.props?.className?.startsWith("prod-note-pin-action")).length, 0);
  submit(runtime); await runtime.settle(); assert.deepEqual(saves, []);
  runtime.rerender(props);
  assert.equal(button(runtime.tree, "Сохранить").props.disabled, false);
  assert.equal(control(runtime, "prod-note-body").props.value, "Unsaved long draft");
  submit(runtime); await runtime.settle();
  assert.deepEqual(saves[0], [note.id, { title: "Draft title", body: "Unsaved long draft", marker: "check", pinned: true }, undefined]);
});

for (const action of ["cancel", "close"]) test(`Notes read-only draft can safely ${action} without saving`, (t) => {
  const { runtime, props, saves } = mount(t); edit(runtime); runtime.rerender({ ...props, canEdit: false });
  const close = action === "cancel" ? button(runtime.tree, "Отмена")
    : elements(runtime.tree, (node) => node.props?.["aria-label"] === "Закрыть редактор")[0];
  assert.equal(close.props.disabled, false); close.props.onClick(); runtime.render();
  assert.equal(elements(runtime.tree, (node) => node.type === "form").length, 0);
  assert.deepEqual(saves, []);
});

test("Notes initially read-only exposes no create/edit/pin mutation controls", (t) => {
  const { runtime } = mount(t, { canEdit: false });
  assert.equal(button(runtime.tree, "Новая заметка"), undefined);
  elements(runtime.tree, (node) => node.props?.className === "prod-personal-note-copy")[0].props.onClick(); runtime.render();
  assert.equal(button(runtime.tree, "Редактировать"), undefined);
  assert.equal(elements(runtime.tree, (node) => node.type === "form").length, 0);
  assert.equal(elements(runtime.tree, (node) => node.props?.className?.startsWith("prod-note-pin-action")).length, 0);
});

test("new Notes draft retains creation UUID across permission loss and does not create without rights", async (t) => {
  const { runtime, props, saves } = mount(t);
  button(runtime.tree, "Новая заметка").props.onClick(); runtime.render();
  control(runtime, "prod-note-body").props.onChange({ target: { value: "New draft" } }); runtime.render();
  submit(runtime); await runtime.settle(); const creationId = saves[0][2]; saves.length = 0;
  runtime.rerender({ ...props, canEdit: false });
  assert.equal(control(runtime, "prod-note-body").props.value, "New draft");
  assert.equal(button(runtime.tree, "Сохранить").props.disabled, true);
  submit(runtime); await runtime.settle(); assert.deepEqual(saves, []);
  runtime.rerender(props); submit(runtime); await runtime.settle();
  assert.equal(saves[0][0], null); assert.equal(saves[0][2], creationId);
});

test("existing Notes target disappearing keeps a read-only draft even if canEdit returns", async (t) => {
  const { runtime, props, saves } = mount(t); edit(runtime);
  runtime.rerender({ ...props, notes: [], canEdit: false });
  runtime.rerender({ ...props, notes: [], canEdit: true });
  assert.equal(control(runtime, "prod-note-body").props.value, "Unsaved long draft");
  assert.equal(button(runtime.tree, "Сохранить").props.disabled, true);
  assert.match(JSON.stringify(runtime.tree), /Заметка больше недоступна/);
  submit(runtime); await runtime.settle(); assert.deepEqual(saves, []);
});
