import { useState, type FormEvent } from "react";
import { Pin, Plus, X } from "lucide-react";
import type { PersonalNote, PersonalNoteMarker } from "@progdm/shared";
import { PERSONAL_NOTE_MARKER_LABELS, personalNoteBodyPreview, personalNoteDisplayTitle } from "./model";

type PersonalNoteDraft = Pick<PersonalNote, "title" | "body" | "marker" | "pinned">;

export function PersonalNotesPage({ notes, busy, canEdit, onSave }: {
  notes: PersonalNote[];
  busy: boolean;
  canEdit: boolean;
  onSave: (noteId: string | null, fields: PersonalNoteDraft) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState<"pinned" | "all">("all");
  const [editing, setEditing] = useState<PersonalNote | null | false>(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [marker, setMarker] = useState<PersonalNoteMarker>("normal");
  const [pinned, setPinned] = useState(false);

  function startCreate() {
    setEditing(null);
    setTitle("");
    setBody("");
    setMarker("normal");
    setPinned(false);
  }

  function startEdit(note: PersonalNote) {
    setEditing(note);
    setTitle(note.title);
    setBody(note.body);
    setMarker(note.marker);
    setPinned(note.pinned);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (editing === false) return;
    if (await onSave(editing?.id ?? null, { title, body, marker, pinned })) setEditing(false);
  }

  const visibleNotes = notes.filter((note) => filter === "all" || note.pinned);
  return <section className="prod-notes-page" aria-labelledby="prod-notes-heading">
    <div className="prod-notes-heading"><div><h2 id="prod-notes-heading">Мои заметки</h2><p>Заметки видны тебе и ведущему.</p></div>
      {canEdit && <button className="prod-secondary" type="button" onClick={startCreate}><Plus aria-hidden="true" />Новая заметка</button>}
    </div>
    <div className="prod-note-filters" role="group" aria-label="Фильтр заметок">
      <button type="button" className={filter === "pinned" ? "is-selected" : ""} aria-pressed={filter === "pinned"} onClick={() => setFilter("pinned")}>Закреплено</button>
      <button type="button" className={filter === "all" ? "is-selected" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Все заметки</button>
    </div>
    {visibleNotes.length ? <ul className="prod-personal-note-list">{visibleNotes.map((note) => <li key={note.id}>
      <button className="prod-personal-note-copy" type="button" disabled={!canEdit} onClick={() => startEdit(note)} aria-label={`${canEdit ? "Изменить" : "Заметка"}: ${personalNoteDisplayTitle(note)}`}>
        <span className="prod-personal-note-meta">
          {note.marker !== "normal" && <span className={`prod-note-marker is-${note.marker}`}>{PERSONAL_NOTE_MARKER_LABELS[note.marker]}</span>}
          {note.pinned && <Pin className="prod-note-pin" aria-label="Закреплена" />}
        </span>
        <strong>{personalNoteDisplayTitle(note)}</strong>
        {personalNoteBodyPreview(note) && <span className="prod-personal-note-preview">{personalNoteBodyPreview(note)}</span>}
      </button>
      {canEdit && <button className={`prod-note-pin-action${note.pinned ? " is-pinned" : ""}`} type="button" disabled={busy} aria-label={note.pinned ? "Открепить заметку" : "Закрепить заметку"}
        onClick={() => void onSave(note.id, { title: note.title, body: note.body, marker: note.marker, pinned: !note.pinned })}>
        <Pin aria-hidden="true" />
      </button>}
    </li>)}</ul> : <p className="prod-empty">{filter === "pinned" ? "Пока нет закреплённых заметок." : "Пока нет заметок."}</p>}

    {editing !== false && <div className="prod-note-editor-wrap">
      <form className="prod-note-editor" onSubmit={(event) => void submit(event)}>
        <div className="prod-note-editor-heading"><h3>{editing ? "Изменить заметку" : "Новая заметка"}</h3>
          <button className="prod-icon-button" type="button" aria-label="Закрыть редактор" onClick={() => setEditing(false)}><X aria-hidden="true" /></button>
        </div>
        <label htmlFor="prod-note-title">Название</label>
        <input id="prod-note-title" value={title} maxLength={120} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        <label htmlFor="prod-note-marker">Тип заметки</label>
        <select id="prod-note-marker" value={marker} disabled={busy} onChange={(event) => setMarker(event.target.value as PersonalNoteMarker)}>
          {Object.entries(PERSONAL_NOTE_MARKER_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        <label htmlFor="prod-note-body">Текст</label>
        <textarea id="prod-note-body" value={body} required maxLength={2000} rows={5} disabled={busy} onChange={(event) => setBody(event.target.value)} />
        <label className="prod-note-pin-checkbox"><input type="checkbox" checked={pinned} disabled={busy} onChange={(event) => setPinned(event.target.checked)} />Закрепить</label>
        <div className="prod-actions"><button className="prod-secondary" type="button" disabled={busy} onClick={() => setEditing(false)}>Отмена</button>
          <button className="prod-primary" type="submit" disabled={busy || !body.trim()}>Сохранить</button></div>
      </form>
    </div>}
  </section>;
}
