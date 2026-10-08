import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpen, Check, CircleHelp, Clock3, RefreshCw } from "lucide-react";
import type { JoinInfo, PlayerState } from "@progdm/shared";
import { joinName, loadJoinSnapshot } from "./sync";
import { PlayerApiError, playerRequest } from "./player/api";
import { JoinIntent } from "./player/join-intent";
import { PlayerWorkspace as ProductionPlayerWorkspace } from "./player/PlayerWorkspace";

const statusCopy = { rejected: "Нужно повторно попросить ведущего" };

function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function getPlayerState(credential: string) {
  return playerRequest<PlayerState>("/api/player/me", {
    headers: { Authorization: "Bearer " + credential },
    cache: "no-store"
  });
}

export function JoinPage({ invite }: { invite: string }) {
  const intent = useMemo(() => new JoinIntent(invite, {
    getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key)
  }), [invite]);
  const [information, setInformation] = useState<JoinInfo | null>(null);
  const [credential, setCredential] = useState(() => {
    try { return intent.read(); } catch { return ""; }
  });
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [name, setName] = useState<string | null>(() => {
    try { return localStorage.getItem("progdm.playerName:" + invite); } catch { return null; }
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const requestSequence = useRef(0);
  const submitting = useRef(false);
  const displayName = joinName(name, player?.displayName);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const sequence = ++requestSequence.current;
      try {
        const snapshot = await loadJoinSnapshot(credential, async (key) => {
          try {
            const current = await getPlayerState(key);
            intent.confirm(key);
            return current;
          } catch (failure) {
            if (failure instanceof PlayerApiError && failure.status === 401 && intent.retainUnauthorized(submitting.current)) return null;
            throw failure;
          }
        }, async () =>
          playerRequest<JoinInfo>("/api/join/" + encodeURIComponent(invite), { cache: "no-store" }));
        if (disposed || sequence !== requestSequence.current) return;
        if (snapshot.information) setInformation(snapshot.information);
        setPlayer(snapshot.player);
        setUnavailable(false);
        setLoading(false); setError("");
      } catch (failure) {
        if (disposed || sequence !== requestSequence.current) return;
        if (failure instanceof PlayerApiError && failure.status === 401 && credential) {
          try { intent.clear(credential); } catch { /* Storage may be disabled. */ }
          setCredential("");
          setPlayer(null);
        } else if (failure instanceof PlayerApiError && failure.status === 404) {
          setUnavailable(true);
          setError(failure instanceof Error ? failure.message : "Ссылка недействительна.");
        } else {
          setError(failure instanceof PlayerApiError ? failure.message : "Нет связи с сервером. Попробуйте ещё раз.");
        }
        setLoading(false);
      } finally { inFlight = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { if (!submitting.current) void refresh(); }, 3000);
    return () => { disposed = true; requestSequence.current++; window.clearInterval(interval); };
  }, [credential, invite, intent]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || unavailable || !information || !displayName.trim()) return;
    submitting.current = true;
    requestSequence.current++;
    setBusy(true); setError("");
    let key: string;
    try {
      localStorage.setItem("progdm.playerName:" + invite, displayName.trim());
      key = intent.begin(makeToken);
      setCredential(key);
    } catch {
      setError("Браузер не смог сохранить доступ. Разреши локальное хранилище и повтори.");
      setBusy(false);
      submitting.current = false;
      return;
    }
    void (async () => {
      try {
        await playerRequest("/api/join/" + encodeURIComponent(invite) + "/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: displayName.trim(), playerToken: key }),
          cache: "no-store"
        });
        intent.confirm(key);
        const sequence = ++requestSequence.current;
        const current = await getPlayerState(key);
        if (sequence === requestSequence.current) setPlayer(current);
      } catch (failure) {
        if (failure instanceof PlayerApiError && failure.status === 409) {
          try {
            const current = await getPlayerState(key);
            intent.confirm(key); setPlayer(current);
            return;
          } catch { /* Preserve the credential while the first request may still be unresolved. */ }
        }
        if (failure instanceof PlayerApiError && (failure.status === 400 || failure.status === 404) && intent.pending()) {
          intent.clear(key); setCredential("");
        }
        setError(failure instanceof Error ? failure.message : "Не удалось отправить заявку.");
        if (failure instanceof PlayerApiError && failure.status === 404) setUnavailable(true);
      } finally { submitting.current = false; setBusy(false); }
    })();
  }

  if (loading && !information && !player) return <main className="join-shell"><p role="status">Проверяем приглашение...</p></main>;

  return <main className={player?.status === "approved" ? "join-shell join-shell-player" : "join-shell"}>
    {player?.status !== "approved" && <header className="join-brand"><BookOpen /><strong>ProgDM</strong></header>}
    {information && player?.status !== "approved" && <p className="join-campaign">{information.campaignName} <span>/</span> {information.sessionName}</p>}
    <section className="join-content" aria-live={player?.status === "approved" ? "off" : "polite"}>
      {unavailable ? <>
        <CircleHelp className="join-state-icon error-icon" />
        <h1>Ссылка недоступна</h1>
        <p className="join-description">{error || "Попроси ведущего прислать новое приглашение."}</p>
      </> : player?.status === "approved" ? <ProductionPlayerWorkspace player={player} credential={credential} refresh={async () => {
        const sequence = ++requestSequence.current;
        const current = await getPlayerState(credential);
        if (sequence === requestSequence.current) setPlayer(current);
      }} /> : player?.status === "pending" ? <>
        <Clock3 className="join-state-icon pending-icon" />
        <h1>Заявка отправлена</h1>
        <p className="join-description">{player.displayName}, ведущий увидит запрос и ответит здесь.</p>
        <p className="join-caption"><RefreshCw size={14} /> Статус обновляется автоматически</p>
        {error && <p className="message error" role="alert">{error}</p>}
      </> : player?.status === "rejected" ? <>
        <CircleHelp className="join-state-icon" />
        <h1>Запрос пока не принят</h1>
        <p className="join-description">Можно отправить заявку повторно.</p>
        {error && <p className="message error" role="alert">{error}</p>}
        <form className="join-form" onSubmit={submit}>
          <label htmlFor="player-name">Твоё имя</label>
          <input id="player-name" autoComplete="name" maxLength={60} required value={displayName} disabled={busy} onChange={(event) => setName(event.target.value)} />
          <button className="primary" disabled={busy || !displayName.trim()}>{busy ? "Отправляем..." : "Отправить снова"}</button>
        </form>
      </> : <>
        <h1>Войти в партию</h1>
        <p className="join-description">Представься ведущему.</p>
        {error && <p className="message error" role="alert">{error}</p>}
        <form className="join-form" onSubmit={submit}>
          <label htmlFor="player-name">Твоё имя</label>
          <input id="player-name" autoComplete="name" autoFocus maxLength={60} required value={displayName} disabled={busy} onChange={(event) => setName(event.target.value)} />
          <button className="primary" disabled={busy || !displayName.trim()}>{busy ? "Отправляем..." : "Попросить доступ"}</button>
        </form>
      </>}
      {player?.status === "rejected" && <p className="join-caption"><Check size={14} />{statusCopy.rejected}</p>}
    </section>
  </main>;
}
