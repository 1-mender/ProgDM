import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BookOpen, CalendarDays, Check, CircleStop, ClipboardList, Copy, Eye, EyeOff, FolderPlus, KeyRound, Link2, LogOut, PackagePlus, Play, Plus, QrCode, Radio, RefreshCw, UserCheck, UserPlus, UserX, Users, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { Campaign, Character, DmState, KnowledgeCategory, KnowledgeEntry, KnowledgeVisibility, Player, Session } from "@progdm/shared";
import { JoinPage } from "./JoinPage";

const tokenKey = "progdm.dmToken";
const campaignKey = "progdm.campaign";
const statusLabels = { planned: "Запланирована", active: "Идёт сейчас", ended: "Завершена" };
const knowledgeCategories: Record<KnowledgeCategory, string> = {
  npc: "Персонаж мира", monster: "Монстр", note: "Заметка или факт", quest: "Квест"
};
const sessionPlural = new Intl.PluralRules("ru");
function sessionCount(count: number) {
  const word = { one: "сессия", few: "сессии", many: "сессий", other: "сессии" }[sessionPlural.select(count) as "one" | "few" | "many" | "other"];
  return count + " " + word;
}

function readStored(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function storeValue(key: string, value: string) {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}
function initialToken() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("dm");
  if (token) {
    storeValue(tokenKey, token);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return token;
  }
  return readStored(tokenKey);
}
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(token: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(result.message ?? "Не удалось выполнить запрос.", response.status);
    return result as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error("Нет связи с сервером. Обновите данные перед повтором действия.");
  } finally { clearTimeout(timer); }
}

function Modal({ title, children, close, busy }: { title: string; children: ReactNode; close: () => void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
    return () => { dialog?.close(); previouslyFocused?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
    <div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button type="button" className="icon-button" title="Закрыть" aria-label="Закрыть" disabled={busy} onClick={close}><X /></button></div>
    {children}
  </dialog>;
}

type Confirmation = { kind: "start" | "end"; session: Session; previousId: string | null; previousName?: string };

export function App() {
  const invite = window.location.pathname.startsWith("/join/")
    ? window.location.pathname.slice("/join/".length).replace(/\/$/, "")
    : null;
  if (invite !== null) return <JoinPage invite={invite} />;
  return <DmWorkspace />;
}

function DmWorkspace() {
  const [token, setToken] = useState(initialToken);
  const [keyInput, setKeyInput] = useState("");
  const [state, setState] = useState<DmState | null>(null);
  const [selectedId, setSelectedId] = useState(() => readStored(campaignKey));
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadId = useRef(0);
  const [campaignForm, setCampaignForm] = useState(false);
  const [campaignName, setCampaignName] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [playerNames, setPlayerNames] = useState<Record<string, string>>({});
  const [characterChoices, setCharacterChoices] = useState<Record<string, string>>({});
  const [newCharacterName, setNewCharacterName] = useState("");
  const [itemTargetId, setItemTargetId] = useState("");
  const [catalogItemName, setCatalogItemName] = useState("");
  const [catalogItemId, setCatalogItemId] = useState("");
  const [itemQuantity, setItemQuantity] = useState("1");
  const [workspaceMode, setWorkspaceMode] = useState<"prepare" | "live">("prepare");
  const [knowledgeCategory, setKnowledgeCategory] = useState<KnowledgeCategory>("note");
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeDescription, setKnowledgeDescription] = useState("");
  const [knowledgeDrafts, setKnowledgeDrafts] = useState<Record<string, { visibility: KnowledgeVisibility; playerId: string }>>({});
  const [joinAddress, setJoinAddress] = useState("");
  const [manualJoinAddress, setManualJoinAddress] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    const id = ++loadId.current;
    if (!silent) setPhase("loading");
    try {
      const data = await request<DmState>(token, "/api/dm/state");
      if (id !== loadId.current) return;
      setState(data);
      setSelectedId((previous) => data.campaigns.some((campaign) => campaign.id === previous)
        ? previous : (data.current?.campaign.id ?? data.campaigns[0]?.id ?? ""));
      setPhase("ready");
    } catch (failure) {
      if (id !== loadId.current) return;
      setPhase("error");
      if (failure instanceof ApiError && failure.status === 401) {
        setToken(""); storeValue(tokenKey, ""); setState(null);
      }
      throw failure;
    }
  }, [token]);

  useEffect(() => {
    if (token) void refresh().catch((failure: Error) => setError(failure.message));
    const interval = window.setInterval(() => {
      if (token && !busyRef.current) void refresh(true).catch(() => {});
    }, 3000);
    return () => { loadId.current++; window.clearInterval(interval); };
  }, [token, refresh]);
  useEffect(() => { storeValue(campaignKey, selectedId); }, [selectedId]);

  const selected = state?.campaigns.find((campaign) => campaign.id === selectedId);
  const sessions = state?.sessions.filter((session) => session.campaignId === selectedId) ?? [];
  const orderedSessions = [...sessions].sort((a, b) =>
    ({ active: 0, planned: 1, ended: 2 }[a.status] - { active: 0, planned: 1, ended: 2 }[b.status]) ||
    b.createdAt.localeCompare(a.createdAt));
  const locked = busy || phase !== "ready";
  const current = state?.current;
  useEffect(() => {
    setWorkspaceMode(current?.session.status === "active" ? "live" : "prepare");
  }, [current?.session.id]);
  const campaignPlayers = current?.campaign.id === selectedId
    ? (state?.players ?? []).filter((player) => player.sessionId === current.session.id)
    : [];
  const pendingPlayers = campaignPlayers.filter((player) => player.status === "pending");
  const approvedPlayers = campaignPlayers.filter((player) => player.status === "approved");
  const grantablePlayers = approvedPlayers.filter((player) => player.characterId && player.characterName);
  const itemTarget = grantablePlayers.find((player) => player.id === itemTargetId) ?? grantablePlayers[0];
  const campaignItemCatalog = state?.itemCatalog.filter((item) => item.campaignId === selectedId) ?? [];
  const selectedCatalogItem = campaignItemCatalog.find((item) => item.id === catalogItemId) ?? campaignItemCatalog[0];
  const availableCharacters = state?.characters.filter((character) => character.campaignId === selectedId && !character.playerId) ?? [];
  const campaignKnowledge = state?.knowledge.filter((entry) => entry.campaignId === selectedId) ?? [];
  const addresses = state?.networkAddresses ?? [];
  const selectedAddress = addresses.find((entry) => entry.address === joinAddress)?.address ??
    (addresses.some((entry) => entry.address === window.location.hostname) ? window.location.hostname : addresses[0]?.address) ?? "";
  const manualAddressValid = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(manualJoinAddress) &&
    manualJoinAddress.split(".").every((part) => Number(part) <= 255);
  const phoneAddress = selectedAddress || (manualAddressValid ? manualJoinAddress : "");
  const invitationUrl = current?.session.status === "active" && phoneAddress
    ? window.location.protocol + "//" + phoneAddress + (window.location.port ? ":" + window.location.port : "") +
      "/join/" + current.session.joinToken
    : "";
  const addressKey = addresses.map((entry) => entry.address).join("|");
  useEffect(() => {
    if (addresses.length && !addresses.some((entry) => entry.address === joinAddress)) {
      setJoinAddress(addresses.some((entry) => entry.address === window.location.hostname)
        ? window.location.hostname : addresses[0]!.address);
    }
  }, [addressKey]);

  async function mutate(action: () => Promise<void>) {
    if (busyRef.current || phase !== "ready") return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await action();
      await refresh();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setToken(""); storeValue(tokenKey, ""); setState(null);
      }
      setError(failure instanceof Error ? failure.message : "Не удалось сохранить изменения.");
      if (!(failure instanceof ApiError)) setPhase("error");
      if (failure instanceof ApiError && failure.status === 409) {
        setConfirmation(null);
        try { await refresh(); } catch { setPhase("error"); }
      }
    } finally { busyRef.current = false; setBusy(false); }
  }

  function chooseCampaign(id: string) { setSelectedId(id); setSessionName(""); setNotice(""); setError(""); }
  function openCampaignForm() { setNotice(""); setError(""); setCampaignForm(true); }
  function confirm(intent: Confirmation) { setNotice(""); setError(""); setConfirmation(intent); }
  function createCampaign(event: FormEvent) {
    event.preventDefault();
    void mutate(async () => {
      const result = await request<{ campaign: Campaign }>(token, "/api/dm/campaigns", { name: campaignName.trim() });
      setSelectedId(result.campaign.id); setCampaignForm(false); setCampaignName(""); setSessionName("");
      setNotice("Кампания создана.");
    });
  }
  function createSession(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void mutate(async () => {
      await request(token, "/api/dm/campaigns/" + selected.id + "/sessions", { name: sessionName.trim() });
      setSessionName(""); setNotice("Сессия создана.");
    });
  }
  function createCharacter(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void mutate(async () => {
      await request(token, "/api/dm/campaigns/" + selected.id + "/characters", { name: newCharacterName.trim() });
      setNewCharacterName("");
      setNotice("Персонаж создан.");
    });
  }
  function createCatalogItem(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void mutate(async () => {
      await request(token, "/api/dm/campaigns/" + selected.id + "/items", { name: catalogItemName.trim() });
      setCatalogItemName("");
      setNotice("Предмет добавлен в справочник.");
    });
  }
  function grantItem(event: FormEvent) {
    event.preventDefault();
    if (!itemTarget?.characterId || !selectedCatalogItem) return;
    void mutate(async () => {
      await request(token, "/api/dm/characters/" + itemTarget.characterId + "/items", {
        catalogItemId: selectedCatalogItem.id, quantity: Number(itemQuantity)
      });
      setNotice("Предмет выдан игроку.");
    });
  }
  function createKnowledge(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void mutate(async () => {
      await request(token, "/api/dm/campaigns/" + selected.id + "/knowledge", {
        category: knowledgeCategory, title: knowledgeTitle.trim(), description: knowledgeDescription.trim()
      });
      setKnowledgeTitle(""); setKnowledgeDescription("");
      setNotice("Запись добавлена и пока скрыта от игроков.");
    });
  }
  function saveKnowledgeVisibility(entry: KnowledgeEntry, draft: { visibility: KnowledgeVisibility; playerId: string }) {
    const unchanged = draft.visibility === entry.visibility &&
      (draft.visibility !== "player" || draft.playerId === (entry.visibleToPlayerId ?? ""));
    const visibility: KnowledgeVisibility = unchanged && entry.visibility !== "hidden" ? "hidden" : draft.visibility;
    if (visibility === "hidden" && entry.visibility === "hidden") return;
    void mutate(async () => {
      await request(token, "/api/dm/knowledge/" + entry.id + "/visibility", visibility === "player"
        ? { visibility, playerId: draft.playerId }
        : { visibility });
      setKnowledgeDrafts((previous) => { const next = { ...previous }; delete next[entry.id]; return next; });
      setNotice(visibility === "hidden" ? "Запись скрыта от игроков." : "Доступ к записи обновлён.");
    });
  }
  function approvePlayer(player: Player) {
    const choice = characterChoices[player.id] ?? "";
    const character = availableCharacters.find((item) => item.id === choice);
    const characterName = (playerNames[player.id] ?? player.displayName).trim();
    void mutate(async () => {
      await request(token, "/api/dm/players/" + player.id + "/approve",
        character ? { characterId: character.id } : { characterName });
      setNotice("Игрок принят.");
    });
  }
  function rejectPlayer(player: Player) {
    void mutate(async () => {
      await request(token, "/api/dm/players/" + player.id + "/reject", {});
      setNotice("Заявка отклонена.");
    });
  }
  function startSession(session: Session) {
    const intent: Confirmation = { kind: "start", session, previousId: current?.session.id ?? null, previousName: current?.session.name };
    if (current) confirm(intent);
    else execute(intent);
  }
  function execute(intent: Confirmation) {
    void mutate(async () => {
      await request(token, "/api/dm/sessions/" + intent.session.id + "/" + intent.kind,
        intent.kind === "start" ? { expectedActiveSessionId: intent.previousId } : {});
      setConfirmation(null);
      setNotice(intent.kind === "start" ? "Сессия началась." : "Сессия завершена.");
    });
  }
  function logout() {
    loadId.current++; storeValue(tokenKey, ""); setToken(""); setState(null); setError(""); setNotice("");
  }
  const alerts = <>
    {error && <div className="message error" role="alert">{error}</div>}
    {notice && <div className="message success" role="status"><Check size={17} />{notice}</div>}
  </>;

  if (!token) return <main className="login">
    <div className="brand"><BookOpen /><strong>ProgDM</strong></div>
    <h1>Доступ ведущего</h1>
    {alerts}
    <form onSubmit={(event) => { event.preventDefault(); storeValue(tokenKey, keyInput.trim()); setError(""); setToken(keyInput.trim()); setKeyInput(""); }}>
      <label htmlFor="dm-key">Ключ ведущего</label>
      <input id="dm-key" type="password" autoComplete="current-password" autoFocus required value={keyInput} onChange={(event) => setKeyInput(event.target.value)} />
      <button className="primary" disabled={!keyInput.trim()}><KeyRound />Войти</button>
    </form>
  </main>;

  return <div className="app">
    <header className="topbar">
      <div className="brand"><BookOpen /><strong>ProgDM</strong><span className="role-label">Ведущий</span></div>
      <div className="toolbar">
        <span className={"connection " + phase}><i />{phase === "loading" ? "Обновление" : phase === "error" ? "Нет связи" : "Подключено"}</span>
        <button className="icon-button" title="Обновить" aria-label="Обновить" disabled={busy || phase === "loading"} onClick={() => { setError(""); void refresh().catch((failure: Error) => setError(failure.message)); }}><RefreshCw className={phase === "loading" ? "spin" : ""} /></button>
        <button className="icon-button" title="Выйти" aria-label="Выйти" disabled={busy} onClick={logout}><LogOut /></button>
      </div>
    </header>
    <div className="workspace">
      <aside className="sidebar">
        <div className="section-heading"><h2>Кампании <span className="count">{state?.campaigns.length ?? 0}</span></h2><button className="icon-button" title="Новая кампания" aria-label="Новая кампания" disabled={locked} onClick={openCampaignForm}><Plus /></button></div>
        <nav aria-label="Кампании">
          {state?.campaigns.map((campaign) => <button key={campaign.id} className={"campaign-row " + (selectedId === campaign.id ? "selected" : "")} aria-current={selectedId === campaign.id ? "page" : undefined} disabled={busy} onClick={() => chooseCampaign(campaign.id)}>
            <BookOpen size={18} /><span>{campaign.name}</span>{current?.campaign.id === campaign.id && <i className="live-dot" aria-label="Активная сессия" />}
          </button>)}
        </nav>
        {state?.campaigns.length === 0 && <p className="muted sidebar-empty">Пока нет кампаний</p>}
      </aside>
      <main className="content">
        {!campaignForm && !confirmation && alerts}
        {current && <section className="current-session" aria-label="Текущая сессия">
          <div className="current-title"><span className="live-label"><i className="live-dot" />Сейчас за столом</span><strong>{current.session.name}</strong><button className="text-link" disabled={busy} onClick={() => chooseCampaign(current.campaign.id)}>{current.campaign.name}</button></div>
          <button className="secondary" disabled={locked} onClick={() => confirm({ kind: "end", session: current.session, previousId: current.session.id })}><CircleStop />Завершить</button>
        </section>}
        {workspaceMode === "live" && current?.session.status === "active" && <section className="join-panel" aria-labelledby="join-title">
          <div className="section-heading"><h2 id="join-title"><QrCode size={18} />Подключение игроков</h2></div>
          <div className="join-share">
            <div className="qr-frame">{invitationUrl
              ? <QRCodeSVG value={invitationUrl} size={184} level="M" marginSize={3}
                title={"Ссылка для входа в сессию «" + current.session.name + "»"} />
              : <span className="muted">Адрес сети недоступен</span>}</div>
            <div className="join-share-info">
              {addresses.length > 1 && <div className="field"><label htmlFor="join-address">Сеть Wi-Fi</label>
                <select id="join-address" value={selectedAddress} onChange={(event) => setJoinAddress(event.target.value)}>
                  {addresses.map((address) => <option key={address.address} value={address.address}>{address.label} · {address.address}</option>)}
                </select>
              </div>}
              {addresses.length === 0 && <div className="field"><label htmlFor="manual-join-ip">IP ноутбука в Wi-Fi</label>
                <input id="manual-join-ip" inputMode="decimal" autoComplete="off" placeholder="192.168.1.20"
                  value={manualJoinAddress} onChange={(event) => setManualJoinAddress(event.target.value)} />
              </div>}
              {invitationUrl && <code className="invite-url">{invitationUrl}</code>}
              <p className="join-caption"><Link2 size={15} /> Игрокам нужно подключиться к той же сети Wi-Fi.</p>
              <button className="secondary" disabled={!invitationUrl} onClick={() => {
                if (!invitationUrl) return;
                void navigator.clipboard.writeText(invitationUrl).then(() => {
                  setCopied(true); window.setTimeout(() => setCopied(false), 1800);
                }).catch(() => setError("Не удалось скопировать ссылку. Отсканируй QR-код."));
              }}><Copy />{copied ? "Скопировано" : "Копировать ссылку"}</button>
            </div>
          </div>
        </section>}
        {phase === "loading" && !state && <p role="status" className="empty">Загрузка кампаний...</p>}
        {phase === "error" && !state && <div className="empty"><h1>Данные недоступны</h1><button className="secondary" onClick={() => { setError(""); void refresh().catch((failure: Error) => setError(failure.message)); }}><RefreshCw />Повторить</button></div>}
        {state && !selected && <section className="empty">
          <BookOpen size={40} strokeWidth={1.4} /><h1>Кампаний пока нет</h1>
          <button className="primary" disabled={locked} onClick={openCampaignForm}><FolderPlus />Создать кампанию</button>
        </section>}
        {selected && <>
          <div className="page-heading"><div><p className="eyebrow">Кампания</p><h1>{selected.name}</h1></div><span className="muted">{sessionCount(sessions.length)}</span></div>
          <div className="workspace-tabs" role="tablist" aria-label="Режим работы">
            <button role="tab" aria-selected={workspaceMode === "prepare"} className={workspaceMode === "prepare" ? "selected" : ""} onClick={() => setWorkspaceMode("prepare")}><ClipboardList size={17} />Подготовка</button>
            <button role="tab" aria-selected={workspaceMode === "live"} className={workspaceMode === "live" ? "selected" : ""} disabled={!current || current.campaign.id !== selectedId} onClick={() => setWorkspaceMode("live")}><Radio size={17} />За столом</button>
          </div>
          {workspaceMode === "prepare" && <>
          <section className="session-create" aria-labelledby="new-session-title">
            <h2 id="new-session-title">Новая сессия</h2>
            <form className="inline-form" onSubmit={createSession}>
              <div className="field"><label htmlFor="session-name">Название</label><input id="session-name" placeholder={"Сессия " + (sessions.length + 1)} maxLength={120} required value={sessionName} disabled={locked} onChange={(event) => setSessionName(event.target.value)} /></div>
              <button className="primary" disabled={locked || !sessionName.trim()}><Plus />Создать сессию</button>
            </form>
          </section>
          <section className="catalog-section" aria-labelledby="catalog-title">
            <div className="section-heading"><h2 id="catalog-title">Справочник предметов <span className="count">{campaignItemCatalog.length}</span></h2></div>
            <form className="inline-form catalog-create-form" onSubmit={createCatalogItem}>
              <div className="field"><label htmlFor="catalog-item-name">Название предмета</label><input id="catalog-item-name" value={catalogItemName} maxLength={120} required disabled={locked} onChange={(event) => setCatalogItemName(event.target.value)} placeholder="Например, зелье лечения" /></div>
              <button className="secondary" disabled={locked || !catalogItemName.trim()}><Plus />Добавить в справочник</button>
            </form>
            {campaignItemCatalog.length > 0 && <ul className="character-list">{campaignItemCatalog.map((item) => <li key={item.id}><PackagePlus size={16} /><span>{item.name}</span></li>)}</ul>}
          </section>
          <section className="character-tools">
            <div className="section-heading"><h2>Персонажи <span className="count">{availableCharacters.length}</span></h2></div>
            <form className="inline-form character-create-form" onSubmit={createCharacter}>
              <div className="field"><label htmlFor="new-character-name">Имя персонажа</label><input id="new-character-name" value={newCharacterName} maxLength={120} disabled={locked} onChange={(event) => setNewCharacterName(event.target.value)} placeholder="Для назначения игроку" /></div>
              <button className="secondary" disabled={locked || !newCharacterName.trim()}><UserPlus />Добавить персонажа</button>
            </form>
            {availableCharacters.length > 0 && <ul className="character-list">{availableCharacters.map((character: Character) => <li key={character.id}><Users size={16} /><span>{character.name}</span></li>)}</ul>}
          </section>
          </>}
          {workspaceMode === "live" && <section className="party-section" aria-labelledby="players-title">
            <div className="section-heading"><h2 id="players-title">Игроки <span className="count">{approvedPlayers.length}</span></h2>
              {pendingPlayers.length > 0 && <span className="badge pending">{pendingPlayers.length} новых заявки</span>}
            </div>
            {pendingPlayers.length > 0 && <ul className="party-list">
              {pendingPlayers.map((player) => {
                const choice = characterChoices[player.id] ?? "";
                return <li key={player.id} className="party-row pending-row">
                  <div className="player-identity"><strong>{player.displayName}</strong><span className="muted">Запрос: {player.sessionName}</span></div>
                  <form className="assign-form" onSubmit={(event) => { event.preventDefault(); approvePlayer(player); }}>
                    <label htmlFor={"character-choice-" + player.id}>Персонаж</label>
                    <select id={"character-choice-" + player.id} value={choice} disabled={locked}
                      onChange={(event) => setCharacterChoices((previous) => ({ ...previous, [player.id]: event.target.value }))}>
                      <option value="">Создать нового...</option>
                      {availableCharacters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
                    </select>
                    {!choice && <input aria-label={"Имя нового персонажа для " + player.displayName} maxLength={120} required placeholder="Имя персонажа"
                      value={playerNames[player.id] ?? player.displayName} disabled={locked}
                      onChange={(event) => setPlayerNames((previous) => ({ ...previous, [player.id]: event.target.value }))} />}
                    <div className="party-actions">
                      <button className="primary" disabled={locked || (!choice && !(playerNames[player.id] ?? player.displayName).trim())}><UserCheck />Принять</button>
                      <button type="button" className="icon-button" title="Отклонить заявку" aria-label={"Отклонить заявку " + player.displayName} disabled={locked} onClick={() => rejectPlayer(player)}><UserX /></button>
                    </div>
                  </form>
                </li>;
              })}
            </ul>}
            {approvedPlayers.length > 0 && <ul className="party-list accepted-list">
              {approvedPlayers.map((player) => <li key={player.id} className="party-row accepted-row">
                <div className="player-identity"><strong>{player.displayName}</strong><span className="muted">{player.sessionName}</span></div>
                <span className="character-name">{player.characterName}</span><span className="badge accepted"><Check size={15} />В партии</span>
              </li>)}
            </ul>}
            {grantablePlayers.length > 0 && <div className="item-grant">
              <h3><PackagePlus size={18} />Выдать предмет</h3>
              <form className="inline-form item-grant-form" onSubmit={grantItem}>
                <div className="field"><label htmlFor="item-target">Игрок и персонаж</label>
                  <select id="item-target" value={itemTarget?.id ?? ""} disabled={locked}
                    onChange={(event) => setItemTargetId(event.target.value)}>
                    {grantablePlayers.map((player) => <option key={player.id} value={player.id}>{player.displayName} · {player.characterName}</option>)}
                  </select>
                </div>
                <div className="field"><label htmlFor="catalog-item">Предмет</label>
                  {campaignItemCatalog.length > 0
                    ? <select id="catalog-item" value={selectedCatalogItem?.id ?? ""} disabled={locked} onChange={(event) => setCatalogItemId(event.target.value)}>{campaignItemCatalog.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                    : <button type="button" className="text-link" onClick={() => setWorkspaceMode("prepare")}>Сначала заполните справочник предметов</button>}
                </div>
                <div className="field quantity-field"><label htmlFor="item-quantity">Количество</label>
                  <input id="item-quantity" type="number" min={1} max={9999} step={1} required value={itemQuantity} disabled={locked}
                    onChange={(event) => setItemQuantity(event.target.value)} />
                </div>
                <button className="primary" disabled={locked || !selectedCatalogItem || !itemTarget || !Number.isInteger(Number(itemQuantity)) || Number(itemQuantity) < 1 || Number(itemQuantity) > 9999}>
                  <PackagePlus />Выдать
                </button>
              </form>
            </div>}
            {pendingPlayers.length === 0 && approvedPlayers.length === 0 && <p className="empty-list">Заявок пока нет</p>}
          </section>
          }
          <section className="knowledge-section" aria-labelledby="knowledge-title">
            <div className="section-heading"><h2 id="knowledge-title">Знания партии <span className="count">{campaignKnowledge.length}</span></h2></div>
            {workspaceMode === "prepare" && <form className="knowledge-create-form" onSubmit={createKnowledge}>
              <div className="knowledge-create-fields">
                <div className="field"><label htmlFor="knowledge-category">Тип записи</label>
                  <select id="knowledge-category" value={knowledgeCategory} disabled={locked}
                    onChange={(event) => setKnowledgeCategory(event.target.value as KnowledgeCategory)}>
                    {Object.entries(knowledgeCategories).map(([category, label]) => <option key={category} value={category}>{label}</option>)}
                  </select>
                </div>
                <div className="field"><label htmlFor="knowledge-title-input">Название</label>
                  <input id="knowledge-title-input" value={knowledgeTitle} maxLength={120} required disabled={locked}
                    onChange={(event) => setKnowledgeTitle(event.target.value)} placeholder="Например, трактирщик Грим" />
                </div>
                <div className="field knowledge-description-field"><label htmlFor="knowledge-description">Краткое описание</label>
                  <textarea id="knowledge-description" value={knowledgeDescription} maxLength={2000} required disabled={locked}
                    onChange={(event) => setKnowledgeDescription(event.target.value)} rows={3} placeholder="Что персонажи знают об этом?" />
                </div>
              </div>
              <button className="secondary" disabled={locked || !knowledgeTitle.trim() || !knowledgeDescription.trim()}><Plus />Добавить скрытую запись</button>
            </form>}
            {campaignKnowledge.length === 0 ? <p className="empty-list">Записей пока нет</p> : <ul className="knowledge-list">
              {campaignKnowledge.map((entry) => {
                const draft = knowledgeDrafts[entry.id] ?? {
                  visibility: entry.visibility,
                  playerId: entry.visibleToPlayerId ?? ""
                };
                const unchanged = draft.visibility === entry.visibility &&
                  (draft.visibility !== "player" || draft.playerId === (entry.visibleToPlayerId ?? ""));
                const nextVisibility: KnowledgeVisibility = unchanged && entry.visibility !== "hidden" ? "hidden" : draft.visibility;
                const targetMissing = nextVisibility === "player" && !grantablePlayers.some((player) => player.id === draft.playerId);
                const actionLabel = nextVisibility === "hidden"
                  ? entry.visibility === "hidden" ? "Скрыта" : "Скрыть"
                  : entry.visibility !== "hidden" && !unchanged ? "Обновить доступ" : "Открыть";
                return <li key={entry.id} className="knowledge-row">
                  <div className="knowledge-entry-copy">
                    <div className="knowledge-entry-heading"><span className="knowledge-category">{knowledgeCategories[entry.category]}</span>
                      <strong>{entry.title}</strong></div>
                    <p>{entry.description}</p>
                    <span className={"knowledge-visibility " + entry.visibility}>
                      {entry.visibility === "hidden" ? "Скрыто" : entry.visibility === "party" ? "Открыто всей партии" : "Открыто: " + (state?.players.find((player) => player.id === entry.visibleToPlayerId)?.displayName ?? "игроку")}
                    </span>
                  </div>
                  {workspaceMode === "live" ? <form className="knowledge-controls" onSubmit={(event) => { event.preventDefault(); saveKnowledgeVisibility(entry, draft); }}>
                    <label className="visually-hidden" htmlFor={"knowledge-visibility-" + entry.id}>Кому показать запись</label>
                    <select id={"knowledge-visibility-" + entry.id} value={draft.visibility} disabled={locked}
                      onChange={(event) => setKnowledgeDrafts((previous) => ({ ...previous, [entry.id]: {
                        ...draft, visibility: event.target.value as KnowledgeVisibility,
                        playerId: event.target.value === "player" ? draft.playerId : ""
                      } }))}>
                      <option value="hidden">Скрыто</option>
                      <option value="player">Одному игроку</option>
                      <option value="party">Всем игрокам</option>
                    </select>
                    {draft.visibility === "player" && <>
                      <label className="visually-hidden" htmlFor={"knowledge-player-" + entry.id}>Выберите игрока</label>
                      <select id={"knowledge-player-" + entry.id} value={draft.playerId} disabled={locked}
                        onChange={(event) => setKnowledgeDrafts((previous) => ({ ...previous, [entry.id]: { ...draft, playerId: event.target.value } }))}>
                        <option value="">Выберите игрока</option>
                        {grantablePlayers.map((player) => <option key={player.id} value={player.id}>{player.displayName}</option>)}
                      </select>
                    </>}
                    <button className={nextVisibility === "hidden" ? "secondary" : "primary"}
                      disabled={locked || (nextVisibility === "hidden" && entry.visibility === "hidden") || targetMissing}>
                      {nextVisibility === "hidden" ? <EyeOff /> : <Eye />}{actionLabel}
                    </button>
                  </form> : null}
                </li>;
              })}
            </ul>}
          </section>
          {workspaceMode === "prepare" && <section className="session-history" aria-labelledby="sessions-title">
            <div className="section-heading"><h2 id="sessions-title">Сессии</h2><CalendarDays size={18} className="muted" /></div>
            {orderedSessions.length === 0 ? <p className="empty-list">Сессий пока нет</p> : <ul className="session-list">
              {orderedSessions.map((session) => <li key={session.id} className="session-row">
                <div className="session-info"><strong>{session.name}</strong><span className="muted">{new Date(session.createdAt).toLocaleDateString("ru-RU")}</span></div>
                <span className={"badge " + session.status}>{statusLabels[session.status]}</span>
                <div className="session-action">{session.status === "planned" && <button className="secondary" disabled={locked} onClick={() => startSession(session)}><Play />Начать</button>}
                {session.status === "active" && <button className="secondary" disabled={locked} onClick={() => confirm({ kind: "end", session, previousId: session.id })}><CircleStop />Завершить</button>}
                {session.status === "ended" && <Check size={18} className="muted" aria-label="Завершена" />}</div>
              </li>)}
            </ul>}
          </section>}
        </>}
      </main>
    </div>
    {campaignForm && <Modal title="Новая кампания" busy={busy} close={() => { setCampaignForm(false); setError(""); }}>
      {alerts}
      <form onSubmit={createCampaign}>
        <label htmlFor="campaign-name">Название кампании</label><input id="campaign-name" autoFocus maxLength={120} required value={campaignName} disabled={busy} onChange={(event) => setCampaignName(event.target.value)} />
        <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setCampaignForm(false)}>Отмена</button><button className="primary" disabled={locked || !campaignName.trim()}>{busy ? "Сохранение..." : "Создать"}</button></div>
      </form>
    </Modal>}
    {confirmation && <Modal title={confirmation.kind === "start" ? "Сменить сессию?" : "Завершить сессию?"} busy={busy} close={() => { setConfirmation(null); setError(""); }}>
      {alerts}
      <p className="confirmation-copy">{confirmation.kind === "start" ? <>«{confirmation.previousName}» завершится. Начнётся «{confirmation.session.name}».</> : <>«{confirmation.session.name}» останется в истории. Возобновить её будет нельзя.</>}</p>
      <div className="dialog-actions"><button className="secondary" autoFocus disabled={busy} onClick={() => setConfirmation(null)}>Отмена</button><button className="primary" disabled={locked} onClick={() => execute(confirmation)}>{busy ? "Сохранение..." : confirmation.kind === "start" ? "Сменить сессию" : "Завершить сессию"}</button></div>
    </Modal>}
  </div>;
}
