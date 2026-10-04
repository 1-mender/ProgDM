import { useLayoutEffect, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, Pin, Plus, X } from "lucide-react";
import type { PersonalNote, PersonalNoteMarker } from "@progdm/shared";
import { PERSONAL_NOTE_MARKER_LABELS, personalNoteBodyPreview, personalNoteDisplayTitle, personalNoteMarkerIcon } from "./model";

type PersonalNoteDraft = Pick<PersonalNote, "title" | "body" | "marker" | "pinned">;
type EditTarget = PersonalNote | "new" | null;

export function PersonalNotesPage({ notes, busy, canEdit, onSave }: {
  notes: PersonalNote[];
  busy: boolean;
  canEdit: boolean;
  onSave: (noteId: string | null, fields: PersonalNoteDraft) => Promise<boolean>;
}) {
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [marker, setMarker] = useState<PersonalNoteMarker>("normal");
  const [pinned, setPinned] = useState(false);
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null;

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [selectedNoteId, editing]);

  function startCreate() {
    setSelectedNoteId(null);
    setEditing("new");
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

  function cancelEdit() {
    if (editing === "new") setSelectedNoteId(null);
    setEditing(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const isNew = editing === "new";
    const noteId = isNew ? null : editing.id;
    if (await onSave(noteId, { title, body, marker, pinned })) {
      setEditing(null);
      if (isNew) setSelectedNoteId(null);
    }
  }

  const pinnedNotes = notes.filter((note) => note.pinned);
  const otherNotes = notes.filter((note) => !note.pinned);
  const noteRows = (entries: PersonalNote[]) => <ul className="prod-personal-note-list">{entries.map((note) => {
    const MarkerIcon = personalNoteMarkerIcon(note.marker);
    return <li key={note.id}>
      <button className="prod-personal-note-copy" type="button" onClick={() => setSelectedNoteId(note.id)} aria-label={`Открыть заметку: ${personalNoteDisplayTitle(note)}`}>
        <span className="prod-personal-note-meta">
          {MarkerIcon && <span className={`prod-note-marker is-${note.marker}`}><MarkerIcon aria-hidden="true" />{PERSONAL_NOTE_MARKER_LABELS[note.marker]}</span>}
          {note.pinned && <Pin className="prod-note-pin" aria-label="Закреплена" />}
        </span>
        <strong>{personalNoteDisplayTitle(note)}</strong>
        {personalNoteBodyPreview(note) && <span className="prod-personal-note-preview">{personalNoteBodyPreview(note)}</span>}
      </button>
      {canEdit && <button className={`prod-note-pin-action${note.pinned ? " is-pinned" : ""}`} type="button" disabled={busy} aria-label={note.pinned ? "Открепить заметку" : "Закрепить заметку"}
        onClick={() => void onSave(note.id, { title: note.title, body: note.body, marker: note.marker, pinned: !note.pinned })}>
        <Pin aria-hidden="true" />
      </button>}
      <ChevronRight className="prod-note-chevron" aria-hidden="true" />
    </li>;
  })}</ul>;

  return <section className="prod-notes-page" aria-labelledby="prod-notes-heading">
    <div className="prod-notes-heading"><div><h2 id="prod-notes-heading">Мои заметки</h2><p>Заметки видны тебе и ведущему.</p></div>
      {!editing && !selectedNote && canEdit && <button className="prod-secondary" type="button" onClick={startCreate}><Plus aria-hidden="true" />Новая заметка</button>}
    </div>

    {editing ? <div className="prod-note-editor-wrap">
      <form className="prod-note-editor" onSubmit={(event) => void submit(event)}>
        <div className="prod-note-editor-heading"><h3>{editing === "new" ? "Новая заметка" : "Изменить заметку"}</h3>
          <button className="prod-icon-button" type="button" aria-label="Закрыть редактор" disabled={busy} onClick={cancelEdit}><X aria-hidden="true" /></button>
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
        <div className="prod-actions"><button className="prod-secondary" type="button" disabled={busy} onClick={cancelEdit}>Отмена</button>
          <button className="prod-primary" type="submit" disabled={busy || !body.trim()}>Сохранить</button></div>
      </form>
    </div> : selectedNote ? <article className="prod-note-detail" aria-labelledby="prod-note-detail-title">
      <button className="prod-back" type="button" onClick={() => setSelectedNoteId(null)}><ChevronLeft aria-hidden="true" />Назад к заметкам</button>
      <div className="prod-note-detail-heading">
        <div><h3 id="prod-note-detail-title">{personalNoteDisplayTitle(selectedNote)}</h3>
          <div className="prod-personal-note-meta">
            {(() => { const MarkerIcon = personalNoteMarkerIcon(selectedNote.marker); return MarkerIcon && <span className={`prod-note-marker is-${selectedNote.marker}`}><MarkerIcon aria-hidden="true" />{PERSONAL_NOTE_MARKER_LABELS[selectedNote.marker]}</span>; })()}
            {selectedNote.pinned && <span className="prod-note-marker"><Pin aria-hidden="true" />Закреплена</span>}
          </div>
        </div>
        {canEdit && <button className="prod-secondary" type="button" onClick={() => startEdit(selectedNote)}>Редактировать</button>}
      </div>
      <p className="prod-note-detail-body">{selectedNote.body}</p>
    </article> : <>
      {pinnedNotes.length > 0 && <section className="prod-note-group" aria-labelledby="prod-pinned-notes-heading">
        <h3 id="prod-pinned-notes-heading"><Pin aria-hidden="true" />Закреплено</h3>{noteRows(pinnedNotes)}
      </section>}
      {otherNotes.length > 0 && <section className="prod-note-group" aria-labelledby="prod-all-notes-heading">
        <h3 id="prod-all-notes-heading">{pinnedNotes.length > 0 ? "Остальные заметки" : "Все заметки"}</h3>{noteRows(otherNotes)}
      </section>}
      {notes.length === 0 && <p className="prod-empty">Пока нет заметок.</p>}
    </>}
  </section>;
}
