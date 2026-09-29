import { useEffect, useRef, useState, type FormEvent } from "react";
import { BookOpen, Check, CircleHelp, Clock3, Package, RefreshCw, ShieldCheck } from "lucide-react";
import type { JoinInfo, KnowledgeCategory, PlayerState } from "@progdm/shared";

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
    <header className="join-brand"><BookOpen /><strong>ProgDM</strong></header>
    {information && <p className="join-campaign">{information.campaignName} <span>/</span> {information.sessionName}</p>}
    <section className="join-content" aria-live="polite">
      {unavailable ? <>
        <CircleHelp className="join-state-icon error-icon" />
        <h1>Ссылка недоступна</h1>
        <p className="join-description">{error || "Попроси ведущего прислать новое приглашение."}</p>
      </> : player?.status === "approved" ? <>
        <ShieldCheck className="join-state-icon approved-icon" />
        <h1>Добро пожаловать, {player.displayName}</h1>
        <p className="join-description">{player.characterName
          ? <>Твой персонаж: <strong>{player.characterName}</strong>.</>
          : "Ведущий принял заявку."}</p>
        <p className="join-caption">{information?.campaignName} · {information?.sessionName}</p>
        <section className="player-inventory" aria-labelledby="inventory-title">
          <div className="inventory-heading"><h2 id="inventory-title">Инвентарь</h2><span className="muted">{player.inventory.length}</span></div>
          {player.inventory.length > 0
            ? <ul className="inventory-list">{player.inventory.map((item) => <li key={item.id}>
              <Package size={18} /><span>{item.name}</span><span className="inventory-quantity">{quantityLabel(item.quantity)}</span>
            </li>)}</ul>
            : <p className="inventory-empty">Пока пусто</p>}
        </section>
        <section className="player-knowledge" aria-labelledby="player-knowledge-title">
          <div className="inventory-heading"><h2 id="player-knowledge-title">Знания партии</h2><span className="muted">{player.knowledge.length}</span></div>
          {player.knowledge.length > 0
            ? <ul className="knowledge-list player-knowledge-list">{player.knowledge.map((entry) => <li key={entry.id} className="knowledge-row">
              <div className="knowledge-entry-copy"><div className="knowledge-entry-heading">
                <span className="knowledge-category">{knowledgeCategoryLabels[entry.category]}</span><strong>{entry.title}</strong>
              </div><p>{entry.description}</p></div>
            </li>)}</ul>
            : <p className="inventory-empty">Пока нет открытых записей</p>}
        </section>
        <p className="join-caption live-updates-caption"><RefreshCw size={14} />Инвентарь и знания обновляются автоматически</p>
      </> : player?.status === "pending" ? <>
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
