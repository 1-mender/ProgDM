import { useState } from "react";
import { BookOpen, Check, Package, ScrollText, Settings, UserRound } from "lucide-react";
import type { PlayerState } from "@progdm/shared";
import { playerPost } from "./api";
import { HomePage } from "./HomePage";
import { KnowledgePage } from "./KnowledgePage";
import { PlayerShell } from "./PlayerShell";
import { ProfilePage } from "./ProfilePage";
import type { PlayerView } from "./model";
import "./player.css";

const quantityPlural = new Intl.PluralRules("ru");
function quantityLabel(quantity: number) {
  const unit = { one: "предмет", few: "предмета", many: "предметов", other: "предмета" }[quantityPlural.select(quantity) as "one" | "few" | "many" | "other"];
  return quantity + " " + unit;
}

function journalEvent(event: PlayerState["recentActivity"][number]) {
  if (event.type === "item_granted") return `Получен предмет: ${event.details.itemName ?? "предмет"} × ${event.details.quantity ?? 1}`;
  return `Открыто знание: ${event.details.knowledgeTitle ?? "новая запись"}`;
}

export function PlayerWorkspace({ player, credential, refresh }: { player: PlayerState; credential: string; refresh: () => Promise<void> }) {
  const [view, setView] = useState<PlayerView>("home");
  const [journalTab, setJournalTab] = useState<"activity" | "notes">("activity");
  const [displayName, setDisplayName] = useState(player.displayName);
  const [noteBody, setNoteBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [expandedKnowledge, setExpandedKnowledge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const navigate = (next: PlayerView) => {
    if (next === "settings") setDisplayName(player.displayName);
    setError("");
    setNotice("");
    setView(next);
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(success);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось сохранить изменения.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const markSeen = (activityId: string) => void run(
    () => playerPost(credential, "/api/player/activity/seen", { upToActivityId: activityId }), "Просмотрено."
  );

  let content;
  if (view === "home") content = <HomePage player={player} busy={busy} onProfile={() => navigate("profile")} onJournal={() => navigate("journal")} onMarkSeen={markSeen} />;
  else if (view === "profile") content = <ProfilePage player={player} busy={busy} onSave={(fields) => run(
    () => playerPost(credential, "/api/player/profile", fields), "Профиль сохранён."
  )} />;
  else if (view === "knowledge") content = <KnowledgePage player={player} />;
  else if (view === "inventory") content = <section className="prod-page prod-legacy-page"><h1>Инвентарь</h1>
    {player.inventory.length ? <ul className="player-simple-list">{player.inventory.map((item) => <li key={item.id}><Package aria-hidden="true" />{item.name}<span className="muted">{quantityLabel(item.quantity)}</span></li>)}</ul> : <p className="prod-empty">Пока пусто.</p>}
  </section>;
  else if (view === "journal") content = <section className="prod-page prod-legacy-page"><h1>Журнал</h1>
    <div className="player-journal-tabs" role="tablist" aria-label="Разделы журнала">
      <button type="button" role="tab" aria-selected={journalTab === "activity"} className={journalTab === "activity" ? "selected" : ""} onClick={() => setJournalTab("activity")}>Хроника</button>
      <button type="button" role="tab" aria-selected={journalTab === "notes"} className={journalTab === "notes" ? "selected" : ""} onClick={() => setJournalTab("notes")}>Мои заметки</button>
    </div>
    {journalTab === "activity" && <>
      {player.recentActivity.length ? <ul className="player-simple-list">{player.recentActivity.map((event) => <li key={event.id}><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleDateString("ru-RU")}</time>{journalEvent(event)}</li>)}</ul> : <p className="prod-empty">Пока нет событий.</p>}
      {player.recentActivity[0] && <button className="prod-secondary" type="button" disabled={busy || !player.canEdit} onClick={() => markSeen(player.recentActivity[0]!.id)}><Check aria-hidden="true" />Отметить просмотренным</button>}
    </>}
    {journalTab === "notes" && <>
      <p className="prod-muted">Личные заметки видны тебе и ведущему.</p>
      {player.notes.length > 0 && <ul className="player-simple-list">{player.notes.map((note) => <li key={note.id}><p>{note.body}</p><button className="text-link" type="button" onClick={() => { setEditingNoteId(note.id); setNoteBody(note.body); }}>Изменить</button></li>)}</ul>}
      {player.canEdit && <form className="player-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        await playerPost(credential, editingNoteId ? `/api/player/notes/${editingNoteId}` : "/api/player/notes", { body: noteBody });
        setNoteBody("");
        setEditingNoteId(null);
      }, "Заметка сохранена."); }}>
        <label htmlFor="personal-note">{editingNoteId ? "Изменить заметку" : "Новая заметка"}</label>
        <textarea id="personal-note" value={noteBody} required maxLength={2000} rows={5} disabled={busy} onChange={(event) => setNoteBody(event.target.value)} />
        <div className="player-actions"><button className="prod-primary" type="submit" disabled={busy || !noteBody.trim()}>Сохранить</button>{editingNoteId && <button type="button" className="prod-secondary" onClick={() => { setEditingNoteId(null); setNoteBody(""); }}>Отмена</button>}</div>
      </form>}
    </>}
  </section>;
  else content = <section className="prod-page prod-legacy-page"><div className="prod-settings-heading"><h1>Настройки</h1><Settings aria-hidden="true" /></div>
    {player.canEdit && <form className="player-form" onSubmit={(event) => { event.preventDefault(); void run(
      () => playerPost(credential, "/api/player/settings", { displayName }), "Имя обновлено."
    ); }}>
      <label htmlFor="display-name">Имя игрока</label><input id="display-name" value={displayName} maxLength={60} required disabled={busy} onChange={(event) => setDisplayName(event.target.value)} />
      <button className="prod-primary" type="submit" disabled={busy || !displayName.trim()}>Сохранить</button>
    </form>}
  </section>;

  return <PlayerShell sessionName={player.sessionName} view={view} onNavigate={navigate} onSettings={() => navigate("settings")}>
    {error && <p className="prod-feedback is-error" role="alert">{error}</p>}
    {notice && <p className="prod-feedback is-success" role="status">{notice}</p>}
    {content}
  </PlayerShell>;
}
