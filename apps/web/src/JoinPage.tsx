import { useEffect, useRef, useState, type FormEvent } from "react";
import { BookOpen, Check, CircleHelp, Clock3, Home, NotebookPen, Package, RefreshCw, ScrollText, Settings, UserRound } from "lucide-react";
import type { CampaignActivity, JoinInfo, KnowledgeCategory, PlayerState } from "@progdm/shared";

const statusCopy = { rejected: "Нужно повторно попросить ведущего" };
const knowledgeCategoryLabels: Record<KnowledgeCategory, string> = {
  npc: "Персонаж мира", monster: "Монстр", note: "Заметка или факт", quest: "Квест"
};
const quantityPlural = new Intl.PluralRules("ru");
function quantityLabel(quantity: number) {
  const unit = { one: "предмет", few: "предмета", many: "предметов", other: "предмета" }[quantityPlural.select(quantity) as "one" | "few" | "many" | "other"];
  return quantity + " " + unit;
}
type ApiFailure = Error & { status?: number };

function playerKey(invite: string) { return "progdm.playerToken:" + invite; }
function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) {
    const error = new Error(body.message ?? "Не удалось выполнить запрос.") as ApiFailure;
    error.status = response.status;
    throw error;
  }
  return body as T;
}
async function getPlayerState(credential: string) {
  return readResponse<PlayerState>(await fetch("/api/player/me", {
    headers: { Authorization: "Bearer " + credential },
    cache: "no-store"
  }));
}

async function playerPost<T>(credential: string, path: string, body: object): Promise<T> {
  return readResponse<T>(await fetch(path, {
    method: "POST", headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store"
  }));
}

function playerEvent(event: CampaignActivity): string {
  if (event.type === "item_granted") return `Получен предмет: ${event.details.itemName ?? "предмет"} × ${event.details.quantity ?? 1}`;
  return `Открыто знание: ${event.details.knowledgeTitle ?? "новая запись"}`;
}

function PlayerWorkspace({ player, credential, refresh }: { player: PlayerState; credential: string; refresh: () => Promise<void> }) {
  type View = "home" | "profile" | "inventory" | "knowledge" | "journal" | "notes" | "settings";
  const [view, setView] = useState<View>("home");
  const [bio, setBio] = useState(player.profile?.shortDescription ?? "");
  const [goal, setGoal] = useState(player.profile?.personalGoal ?? "");
  const [displayName, setDisplayName] = useState(player.displayName);
  const [noteBody, setNoteBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [expandedKnowledge, setExpandedKnowledge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const navigate = (next: View) => {
    if (next === "profile") { setBio(player.profile?.shortDescription ?? ""); setGoal(player.profile?.personalGoal ?? ""); }
    if (next === "settings") setDisplayName(player.displayName);
    setError(""); setNotice(""); setView(next);
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); setNotice(success); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось сохранить изменения."); }
    finally { setBusy(false); }
  };
  const nav: { id: View; label: string; icon: typeof Home }[] = [
    { id: "home", label: "Главная", icon: Home }, { id: "profile", label: "Профиль", icon: UserRound },
    { id: "inventory", label: "Инвентарь", icon: Package }, { id: "knowledge", label: "Знания", icon: BookOpen },
    { id: "journal", label: "Журнал", icon: ScrollText }, { id: "notes", label: "Заметки", icon: NotebookPen }
  ];
  const latest = player.newActivity[0];
  return <div className="player-app">
    <header className="player-app-header"><div><strong>{player.characterName ?? player.displayName}</strong><span>{player.campaignName} · {player.sessionName}</span></div>
      <button className="icon-button" title="Настройки" aria-label="Настройки" onClick={() => navigate("settings")}><Settings /></button></header>
    <div className="player-view">
      {error && <p className="message error" role="alert">{error}</p>}
      {notice && <p className="message success" role="status">{notice}</p>}
      {view === "home" && <>
        <h1>{player.characterName ?? "Персонаж ещё не назначен"}</h1>
        {player.profile?.archetype && <p className="muted">{player.profile.archetype}</p>}
        {player.profile?.shortDescription && <p>{player.profile.shortDescription}</p>}
        <section className="player-section"><div className="section-heading"><h2>Новое</h2>{player.newActivity.length > 0 && <span className="count">{player.newActivity.length}</span>}</div>
          {player.newActivity.length ? <><ul className="player-simple-list">{player.newActivity.slice(0, 3).map((event) => <li key={event.id}>{playerEvent(event)}</li>)}</ul>
            <div className="player-actions"><button className="secondary" onClick={() => navigate("journal")}>В журнал</button>
              {latest && <button className="secondary" disabled={busy} onClick={() => void run(() => playerPost(credential, "/api/player/activity/seen", { upToActivityId: latest.id }), "Просмотрено.")}><Check />Просмотрено</button>}</div></>
            : <p className="muted">Новых записей нет.</p>}
        </section>
        <section className="player-section"><h2>Важное</h2>
          <ul className="player-simple-list">{player.knowledge.slice(-2).map((entry) => <li key={entry.id}><button className="text-link" onClick={() => { navigate("knowledge"); setExpandedKnowledge(entry.id); }}>{entry.title}</button></li>)}
            {player.inventory.slice(-2).map((item) => <li key={item.id}>{item.name} · {item.quantity}</li>)}</ul>
          {!player.knowledge.length && !player.inventory.length && <p className="muted">Пока нет записей.</p>}
        </section>
      </>}
      {view === "profile" && <><h1>Профиль</h1><p className="player-profile-name">{player.characterName}</p>
        {player.profile?.archetype && <p><strong>Архетип:</strong> {player.profile.archetype}</p>}
        {player.profile?.origin && <p><strong>Происхождение:</strong> {player.profile.origin}</p>}
        {player.canEdit && <form className="player-form" onSubmit={(event) => { event.preventDefault(); void run(() => playerPost(credential, "/api/player/profile", { shortDescription: bio, personalGoal: goal }), "Профиль сохранён."); }}>
          <label htmlFor="player-bio">Описание</label><textarea id="player-bio" value={bio} maxLength={500} rows={4} disabled={busy} onChange={(event) => setBio(event.target.value)} />
          <label htmlFor="player-goal">Личная цель</label><textarea id="player-goal" value={goal} maxLength={500} rows={3} disabled={busy} onChange={(event) => setGoal(event.target.value)} />
          <button className="primary" disabled={busy}>Сохранить</button>
        </form>}
      </>}
      {view === "inventory" && <><h1>Инвентарь</h1>{player.inventory.length ? <ul className="player-simple-list">{player.inventory.map((item) => <li key={item.id}><Package size={18} />{item.name}<span className="muted">{quantityLabel(item.quantity)}</span></li>)}</ul> : <p className="muted">Пока пусто.</p>}</>}
      {view === "knowledge" && <><h1>Знания</h1>{player.knowledge.length ? <ul className="player-simple-list">{player.knowledge.map((entry) => <li key={entry.id} className="player-knowledge-item">
        <button className="text-link" aria-expanded={expandedKnowledge === entry.id} onClick={() => setExpandedKnowledge(expandedKnowledge === entry.id ? null : entry.id)}>{entry.title}</button>
        <span className="muted">{knowledgeCategoryLabels[entry.category]}</span>{expandedKnowledge === entry.id && <p>{entry.description}</p>}
      </li>)}</ul> : <p className="muted">Пока нет открытых записей.</p>}</>}
      {view === "journal" && <><h1>Журнал</h1>{player.recentActivity.length ? <ul className="player-simple-list">{player.recentActivity.map((event) => <li key={event.id}><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleDateString("ru-RU")}</time>{playerEvent(event)}</li>)}</ul> : <p className="muted">Пока нет событий.</p>}
        {latest && <button className="secondary" disabled={busy} onClick={() => void run(() => playerPost(credential, "/api/player/activity/seen", { upToActivityId: latest.id }), "Просмотрено.")}><Check />Просмотрено</button>}
      </>}
      {view === "notes" && <><h1>Личные заметки</h1><p className="muted">Видны тебе и ведущему.</p>
        {player.notes.length > 0 && <ul className="player-simple-list">{player.notes.map((note) => <li key={note.id}><p>{note.body}</p><button className="text-link" onClick={() => { setEditingNoteId(note.id); setNoteBody(note.body); }}>Изменить</button></li>)}</ul>}
        {player.canEdit && <form className="player-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await playerPost(credential, editingNoteId ? `/api/player/notes/${editingNoteId}` : "/api/player/notes", { body: noteBody });
          setNoteBody(""); setEditingNoteId(null);
        }, "Заметка сохранена."); }}>
          <label htmlFor="personal-note">{editingNoteId ? "Изменить заметку" : "Новая заметка"}</label>
          <textarea id="personal-note" value={noteBody} required maxLength={2000} rows={5} disabled={busy} onChange={(event) => setNoteBody(event.target.value)} />
          <div className="player-actions"><button className="primary" disabled={busy || !noteBody.trim()}>Сохранить</button>{editingNoteId && <button type="button" className="secondary" onClick={() => { setEditingNoteId(null); setNoteBody(""); }}>Отмена</button>}</div>
        </form>}
      </>}
      {view === "settings" && <><h1>Настройки</h1>{player.canEdit && <form className="player-form" onSubmit={(event) => { event.preventDefault(); void run(() => playerPost(credential, "/api/player/settings", { displayName }), "Имя обновлено."); }}>
        <label htmlFor="display-name">Имя игрока</label><input id="display-name" value={displayName} maxLength={60} required disabled={busy} onChange={(event) => setDisplayName(event.target.value)} />
        <button className="primary" disabled={busy || !displayName.trim()}>Сохранить</button>
      </form>}</>}
    </div>
    <nav className="player-nav" aria-label="Разделы игрока">{nav.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "selected" : ""} aria-current={view === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span></button>)}</nav>
  </div>;
}

export function JoinPage({ invite }: { invite: string }) {
  const [information, setInformation] = useState<JoinInfo | null>(null);
  const [credential, setCredential] = useState(() => {
    try { return localStorage.getItem(playerKey(invite)) ?? ""; } catch { return ""; }
  });
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [name, setName] = useState(() => {
    try { return localStorage.getItem("progdm.playerName:" + invite) ?? ""; } catch { return ""; }
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const sequence = ++requestSequence.current;
      try {
        if (!information) {
          const inviteResponse = await readResponse<JoinInfo>(await fetch("/api/join/" + encodeURIComponent(invite), { cache: "no-store" }));
          if (disposed) return;
          setInformation(inviteResponse);
          setUnavailable(false);
        }
        if (credential) {
          const current = await getPlayerState(credential);
          if (disposed || sequence !== requestSequence.current) return;
          setPlayer(current);
        }
        if (!disposed) { setLoading(false); setError(""); }
      } catch (failure) {
        if (disposed || sequence !== requestSequence.current) return;
        if (failure instanceof Error && (failure as ApiFailure).status === 401 && credential) {
          try { localStorage.removeItem(playerKey(invite)); } catch { /* Storage may be disabled. */ }
          setCredential("");
          setPlayer(null);
        } else if ((failure as ApiFailure).status === 404) {
          setUnavailable(true);
          setError(failure instanceof Error ? failure.message : "Ссылка недействительна.");
        } else {
          setError(failure instanceof Error ? failure.message : "Нет связи с приложением.");
        }
        setLoading(false);
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 3000);
    return () => { disposed = true; requestSequence.current++; window.clearInterval(interval); };
  }, [credential, information, invite]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || unavailable || !information) return;
    const displayName = name.trim();
    setBusy(true); setError("");
    const key = credential || makeToken();
    try {
      localStorage.setItem(playerKey(invite), key);
      localStorage.setItem("progdm.playerName:" + invite, displayName);
    } catch {
      setError("Браузер не смог сохранить доступ. Разреши локальное хранилище и повтори.");
      setBusy(false);
      return;
    }
    void (async () => {
      try {
        await readResponse(await fetch("/api/join/" + encodeURIComponent(invite) + "/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName, playerToken: key }),
          cache: "no-store"
        }));
        setCredential(key);
        setPlayer(await getPlayerState(key));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Не удалось отправить заявку.");
        if ((failure as ApiFailure).status === 404) setUnavailable(true);
      } finally { setBusy(false); }
    })();
  }

  if (loading && !information) return <main className="join-shell"><p role="status">Проверяем приглашение...</p></main>;

  return <main className="join-shell">
    {player?.status !== "approved" && <header className="join-brand"><BookOpen /><strong>ProgDM</strong></header>}
    {information && player?.status !== "approved" && <p className="join-campaign">{information.campaignName} <span>/</span> {information.sessionName}</p>}
    <section className="join-content" aria-live={player?.status === "approved" ? "off" : "polite"}>
      {unavailable ? <>
        <CircleHelp className="join-state-icon error-icon" />
        <h1>Ссылка недоступна</h1>
        <p className="join-description">{error || "Попроси ведущего прислать новое приглашение."}</p>
      </> : player?.status === "approved" ? <PlayerWorkspace player={player} credential={credential} refresh={async () => setPlayer(await getPlayerState(credential))} /> : player?.status === "pending" ? <>
        <Clock3 className="join-state-icon pending-icon" />
        <h1>Заявка отправлена</h1>
        <p className="join-description">{player.displayName}, ведущий увидит запрос и ответит здесь.</p>
        <p className="join-caption"><RefreshCw size={14} /> Статус обновляется автоматически</p>
      </> : player?.status === "rejected" ? <>
        <CircleHelp className="join-state-icon" />
        <h1>Запрос пока не принят</h1>
        <p className="join-description">Можно отправить заявку повторно.</p>
        {error && <p className="message error" role="alert">{error}</p>}
        <form className="join-form" onSubmit={submit}>
          <label htmlFor="player-name">Твоё имя</label>
          <input id="player-name" autoComplete="name" maxLength={60} required value={name || player.displayName} onChange={(event) => setName(event.target.value)} />
          <button className="primary" disabled={busy || !name.trim()}>{busy ? "Отправляем..." : "Отправить снова"}</button>
        </form>
      </> : <>
        <h1>Войти в партию</h1>
        <p className="join-description">Представься ведущему.</p>
        {error && <p className="message error" role="alert">{error}</p>}
        <form className="join-form" onSubmit={submit}>
          <label htmlFor="player-name">Твоё имя</label>
          <input id="player-name" autoComplete="name" autoFocus maxLength={60} required value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
          <button className="primary" disabled={busy || !name.trim()}>{busy ? "Отправляем..." : "Попросить доступ"}</button>
        </form>
      </>}
      {player?.status === "rejected" && <p className="join-caption"><Check size={14} />{statusCopy.rejected}</p>}
    </section>
  </main>;
}
