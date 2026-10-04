import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Archive, ArrowDown, ArrowUp, BookOpen, CalendarDays, Check, CircleStop, ClipboardList, Copy, Database, Download, Eye, EyeOff, FolderPlus, KeyRound, Link2, LogOut, PackagePlus, Pencil, Play, Plus, QrCode, Radio, RefreshCw, RotateCcw, ScrollText, Trash2, Upload, UserCheck, UserPlus, UserX, Users, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { ActivityType, Campaign, CampaignActivity, Character, CharacterProfileFieldValue, DataHealth, DmState, InventoryItem, KnowledgeCategory, KnowledgeEntry, KnowledgeFact, KnowledgeFactReveal, KnowledgeFactRevealAudience, KnowledgeVisibility, PersonalNote, Player, Session } from "@progdm/shared";
import { JoinPage } from "./JoinPage";
import { approvalTarget, LatestRequest, mergeProfileDraft, PendingOperationIds } from "./sync";

const tokenKey = "progdm.dmToken";
const campaignKey = "progdm.campaign";
const statusLabels = { planned: "Запланирована", active: "Идёт сейчас", ended: "Завершена" };
const knowledgeCategories: Record<KnowledgeCategory, string> = {
  character: "Персонаж", place: "Место", creature: "Существо", item: "Предмет", event: "Событие", fact: "Факт"
};
const activityLabels: Record<ActivityType, string> = {
  campaign_created: "Кампания создана", campaign_imported: "Кампания импортирована", backup_restored: "Копия восстановлена",
  session_created: "Сессия создана", session_started: "Сессия началась", session_ended: "Сессия завершена",
  player_requested: "Заявка игрока", player_approved: "Игрок принят", player_rejected: "Заявка отклонена",
  character_created: "Персонаж создан", character_assigned: "Персонаж назначен", character_archived: "Персонаж архивирован", character_restored: "Персонаж восстановлен",
  catalog_item_created: "Предмет добавлен в справочник", item_granted: "Предмет выдан",
  knowledge_created: "Знание создано", knowledge_visibility_changed: "Видимость знания изменена",
  knowledge_fact_revealed: "Факт знания открыт", knowledge_fact_access_revoked: "Доступ к факту знания отозван",
  character_profile_updated: "Профиль обновлён", personal_note_created: "Личная заметка добавлена", personal_note_updated: "Личная заметка обновлена"
};
function activitySummary(event: CampaignActivity): string {
  const subject = event.details.characterName ?? event.details.playerName ?? event.details.knowledgeTitle ?? event.details.itemName ?? event.details.sessionName ?? event.details.campaignName;
  const quantity = event.type === "item_granted" ? ` × ${event.details.quantity ?? 1}` : "";
  return `${activityLabels[event.type]}${subject ? `: ${subject}` : ""}${quantity}`;
}
const sessionPlural = new Intl.PluralRules("ru");
type BackupInfo = { id: string; createdAt: string; size: number };
type CharacterOverview = { character: Character; player: { id: string; displayName: string } | null; profileFields: CharacterProfileFieldValue[]; inventory: InventoryItem[]; knowledge: KnowledgeEntry[]; notes: PersonalNote[]; activity: CampaignActivity[] };
type DmSection = "sessions" | "players" | "join" | "characters" | "character" | "catalog" | "knowledge" | "history" | "data";
function ActivityList({ activity }: { activity: CampaignActivity[] }) {
  return activity.length ? <ol className="activity-list">{activity.map((event) => <li key={event.id}>
    <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("ru-RU")}</time>
    <span>{activitySummary(event)}</span>
  </li>)}</ol> : <p className="muted">Пока нет событий.</p>;
}
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
class AmbiguousRevealFailure extends Error {}
async function request<T>(token: string, path: string, body?: unknown, timeoutMs = 10000, method?: string): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
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

async function downloadFile(token: string, path: string, filename: string) {
  const response = await fetch(path, { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new ApiError(result.message ?? "Не удалось скачать файл.", response.status);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [characterOverview, setCharacterOverview] = useState<CharacterOverview | null>(null);
  const [profileDraft, setProfileDraft] = useState<Character | null>(null);
  const [profileFieldDraft, setProfileFieldDraft] = useState<Record<string, string>>({});
  const profileFieldBase = useRef<Record<string, string>>({});
  const [openedCharacterId, setOpenedCharacterId] = useState("");
  const openedCharacter = useRef("");
  const overviewRequests = useRef(new LatestRequest());
  const historyRequests = useRef(new LatestRequest());
  const knowledgeFactRequests = useRef(new LatestRequest());
  const pendingRevealOperations = useRef(new PendingOperationIds());
  const profileBase = useRef<Character | null>(null);
  const [backupId, setBackupId] = useState("");
  const [health, setHealth] = useState<DataHealth | null>(null);
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
  const [newProfileFieldLabel, setNewProfileFieldLabel] = useState("");
  const [editingProfileField, setEditingProfileField] = useState<{ id: string; label: string } | null>(null);
  const [catalogItemName, setCatalogItemName] = useState("");
  const [catalogItemId, setCatalogItemId] = useState("");
  const [itemQuantity, setItemQuantity] = useState("1");
  const [workspaceMode, setWorkspaceMode] = useState<"prepare" | "live">("prepare");
  const [section, setSection] = useState<DmSection>("sessions");
  const [grantOpen, setGrantOpen] = useState(false);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState("");
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  const [fullActivity, setFullActivity] = useState<CampaignActivity[] | null>(null);
  const [knowledgeCategory, setKnowledgeCategory] = useState<KnowledgeCategory>("fact");
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeDescription, setKnowledgeDescription] = useState("");
  const [knowledgeTargetId, setKnowledgeTargetId] = useState("");
  const [knowledgeFacts, setKnowledgeFacts] = useState<KnowledgeFact[]>([]);
  const [knowledgeFactReveals, setKnowledgeFactReveals] = useState<KnowledgeFactReveal[]>([]);
  const [knowledgeFactsLoading, setKnowledgeFactsLoading] = useState(false);
  const [knowledgeFactsError, setKnowledgeFactsError] = useState("");
  const [knowledgeFactsReload, setKnowledgeFactsReload] = useState(0);
  const [newKnowledgeFact, setNewKnowledgeFact] = useState("");
  const [editingKnowledgeFact, setEditingKnowledgeFact] = useState<{ id: string; body: string } | null>(null);
  const [deletingKnowledgeFact, setDeletingKnowledgeFact] = useState<KnowledgeFact | null>(null);
  const [revokingKnowledgeFact, setRevokingKnowledgeFact] = useState<{ fact: KnowledgeFact; reveal: KnowledgeFactReveal } | null>(null);
  const [knowledgeRevealCharacterId, setKnowledgeRevealCharacterId] = useState("");
  const [joinAddress, setJoinAddress] = useState("");
  const [manualJoinAddress, setManualJoinAddress] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    const id = ++loadId.current;
    if (!silent) setPhase("loading");
    try {
      const [data, backupData] = await Promise.all([
        request<DmState>(token, "/api/dm/state"), request<{ backups: BackupInfo[] }>(token, "/api/dm/backups")
      ]);
      if (id !== loadId.current) return;
      setState(data);
      setBackups(backupData.backups);
      setBackupId((previous) => backupData.backups.some((backup) => backup.id === previous) ? previous : backupData.backups[0]?.id ?? "");
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

  const refreshOverview = useCallback(async (resetDraft = false) => {
    const characterId = openedCharacter.current;
    if (!characterId) return;
    const ticket = overviewRequests.current.begin();
    let overview: CharacterOverview;
    try { overview = await request<CharacterOverview>(token, `/api/dm/characters/${characterId}/overview`); }
    catch (failure) {
      if (overviewRequests.current.isCurrent(ticket) && openedCharacter.current === characterId) throw failure;
      return;
    }
    if (!overviewRequests.current.isCurrent(ticket) || openedCharacter.current !== characterId) return;
    const previous = profileBase.current;
    profileBase.current = overview.character;
    setCharacterOverview(overview);
    setProfileDraft((draft) => resetDraft ? overview.character : mergeProfileDraft(draft, previous, overview.character));
    const previousFields = profileFieldBase.current;
    const incomingFields = Object.fromEntries(overview.profileFields.map((field) => [field.id, field.value]));
    setProfileFieldDraft((draft) => resetDraft || !Object.keys(previousFields).length ? incomingFields :
      Object.fromEntries(overview.profileFields.map((field) => [field.id,
        draft[field.id] !== previousFields[field.id] ? draft[field.id] ?? "" : incomingFields[field.id] ?? ""])));
    profileFieldBase.current = incomingFields;
  }, [token]);

  useEffect(() => {
    if (!openedCharacterId || !token) return;
    let inFlight = false;
    const update = () => {
      if (busyRef.current || inFlight) return;
      inFlight = true;
      void refreshOverview().catch((failure: Error) => {
        if (openedCharacter.current === openedCharacterId) setError(failure.message);
      }).finally(() => { inFlight = false; });
    };
    update();
    const interval = window.setInterval(update, 3000);
    return () => { overviewRequests.current.invalidate(); window.clearInterval(interval); };
  }, [openedCharacterId, token, refreshOverview]);

  useEffect(() => {
    if (section !== "history" || !selectedId || !token) return;
    let disposed = false;
    let inFlight = false;
    setFullActivity(null);
    const update = async () => {
      if (busyRef.current || inFlight) return;
      inFlight = true;
      const ticket = historyRequests.current.begin();
      try {
        const result = await request<{ activity: CampaignActivity[] }>(token, `/api/dm/campaigns/${selectedId}/activity`);
        if (!disposed && historyRequests.current.isCurrent(ticket)) setFullActivity(result.activity);
      } catch (failure) {
        if (!disposed && historyRequests.current.isCurrent(ticket)) setError((failure as Error).message);
      } finally { inFlight = false; }
    };
    void update();
    const interval = window.setInterval(() => { void update(); }, 3000);
    return () => { disposed = true; historyRequests.current.invalidate(); window.clearInterval(interval); };
  }, [section, selectedId, token]);

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
    const live = current?.session.status === "active" && current.campaign.id === selectedId;
    setWorkspaceMode(live ? "live" : "prepare");
    setSection(live ? "players" : "sessions");
    if (!live) setRevokingKnowledgeFact(null);
  }, [current?.session.id, selectedId]);
  const campaignPlayers = current?.campaign.id === selectedId
    ? (state?.players ?? []).filter((player) => player.sessionId === current.session.id)
    : [];
  const pendingPlayers = campaignPlayers.filter((player) => player.status === "pending");
  const approvedPlayers = campaignPlayers.filter((player) => player.status === "approved");
  const grantablePlayers = approvedPlayers.filter((player) => player.characterId && player.characterName);
  const campaignItemCatalog = state?.itemCatalog.filter((item) => item.campaignId === selectedId) ?? [];
  const selectedCatalogItem = campaignItemCatalog.find((item) => item.id === catalogItemId) ?? campaignItemCatalog[0];
  const assignedCharacterIds = new Set(campaignPlayers.map((player) => player.characterId).filter((id): id is string => id !== null));
  const campaignCharacters = state?.characters.filter((character) => character.campaignId === selectedId) ?? [];
  const campaignProfileFields = (state?.profileFields ?? []).filter((field) => field.campaignId === selectedId)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const availableCharacters = campaignCharacters.filter((character) => !character.archivedAt && !assignedCharacterIds.has(character.id));
  const campaignActivity = state?.activity.filter((event) => event.campaignId === selectedId) ?? [];
  const campaignKnowledge = state?.knowledge.filter((entry) => entry.campaignId === selectedId) ?? [];
  const filteredKnowledge = campaignKnowledge.filter((entry) => entry.title.toLocaleLowerCase("ru").includes(knowledgeSearch.trim().toLocaleLowerCase("ru")));
  const selectedKnowledge = filteredKnowledge.find((entry) => entry.id === selectedKnowledgeId) ?? filteredKnowledge[0];
  const liveRevealCharacters = [...new Map(grantablePlayers.flatMap((player) => {
    const character = campaignCharacters.find((item) => item.id === player.characterId);
    return character && !character.archivedAt ? [[character.id, character] as const] : [];
  })).values()];
  const liveRevealCharacterIds = liveRevealCharacters.map((character) => character.id).join("|");
  const selectedPlayer = grantablePlayers.find((player) => player.characterId === characterOverview?.character.id);
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
    if (!liveRevealCharacters.some((character) => character.id === knowledgeRevealCharacterId)) {
      setKnowledgeRevealCharacterId(liveRevealCharacters[0]?.id ?? "");
    }
  }, [selectedId, current?.session.id, liveRevealCharacterIds]);
  useEffect(() => {
    const entryId = selectedKnowledge?.id;
    if (section !== "knowledge" || !selectedId || !entryId || !token) {
      knowledgeFactRequests.current.invalidate();
      setKnowledgeFacts([]); setKnowledgeFactReveals([]); setKnowledgeFactsLoading(false); setKnowledgeFactsError("");
      return;
    }
    const campaignId = selectedId;
    const ticket = knowledgeFactRequests.current.begin();
    setKnowledgeFacts([]); setKnowledgeFactReveals([]); setKnowledgeFactsLoading(true); setKnowledgeFactsError("");
    setEditingKnowledgeFact(null); setDeletingKnowledgeFact(null); setNewKnowledgeFact("");
    setRevokingKnowledgeFact(null);
    void Promise.all([
      request<{ facts: KnowledgeFact[] }>(token, `/api/dm/campaigns/${campaignId}/knowledge/${entryId}/facts`),
      request<{ reveals: KnowledgeFactReveal[] }>(token, `/api/dm/campaigns/${campaignId}/knowledge/${entryId}/facts/reveals`)
    ]).then(([facts, reveals]) => {
      if (knowledgeFactRequests.current.isCurrent(ticket)) {
        setKnowledgeFacts(facts.facts);
        setKnowledgeFactReveals(reveals.reveals);
      }
    }).catch((failure: Error) => {
      if (knowledgeFactRequests.current.isCurrent(ticket)) setKnowledgeFactsError(failure.message);
    }).finally(() => {
      if (knowledgeFactRequests.current.isCurrent(ticket)) setKnowledgeFactsLoading(false);
    });
    return () => { knowledgeFactRequests.current.invalidate(); };
  }, [section, selectedId, selectedKnowledge?.id, token, knowledgeFactsReload]);
  useEffect(() => {
    if (addresses.length && !addresses.some((entry) => entry.address === joinAddress)) {
      setJoinAddress(addresses.some((entry) => entry.address === window.location.hostname)
        ? window.location.hostname : addresses[0]!.address);
    }
  }, [addressKey]);

  async function mutate(action: () => Promise<void>) {
    if (busyRef.current || phase !== "ready") return;
    overviewRequests.current.invalidate(); historyRequests.current.invalidate();
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await action();
      await refresh();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setToken(""); storeValue(tokenKey, ""); setState(null);
      }
      setError(failure instanceof Error ? failure.message : "Не удалось сохранить изменения.");
      if (!(failure instanceof ApiError) && !(failure instanceof AmbiguousRevealFailure)) setPhase("error");
      if (failure instanceof ApiError && failure.status === 409) {
        setConfirmation(null);
        try { await refresh(); } catch { setPhase("error"); }
      }
    } finally { busyRef.current = false; setBusy(false); }
  }

  function closeCharacter() {
    overviewRequests.current.invalidate(); openedCharacter.current = ""; profileBase.current = null;
    profileFieldBase.current = {}; setProfileFieldDraft({});
    setOpenedCharacterId(""); setCharacterOverview(null); setProfileDraft(null);
  }
  function chooseCampaign(id: string) { closeCharacter(); historyRequests.current.invalidate(); setSelectedId(id); setSessionName(""); setNotice(""); setError(""); setSection("sessions"); setWorkspaceMode("prepare"); setFullActivity(null); setKnowledgeTargetId(""); setSelectedKnowledgeId(""); setKnowledgeSearch(""); }
  function showSection(next: DmSection) {
    setSection(next);
    historyRequests.current.invalidate();
    if (next !== "character") setGrantOpen(false);
  }
  function openCharacter(characterId: string) {
    closeCharacter();
    openedCharacter.current = characterId;
    setOpenedCharacterId(characterId); setSection("character"); setGrantOpen(false);
  }
  function saveCharacterProfile(event: FormEvent) {
    event.preventDefault();
    if (!profileDraft) return;
    void mutate(async () => {
      await request(token, `/api/dm/characters/${profileDraft.id}/profile`, {
        name: profileDraft.name, shortDescription: profileDraft.shortDescription, archetype: profileDraft.archetype,
        origin: profileDraft.origin, personalGoal: profileDraft.personalGoal, dmNotes: profileDraft.dmNotes,
        traits: profileDraft.traits, appearance: profileDraft.appearance, quote: profileDraft.quote
      });
      await refreshOverview(true); setNotice("Профиль сохранён.");
    });
  }
  function saveCharacterProfileFields(event: FormEvent) {
    event.preventDefault();
    if (!characterOverview) return;
    void mutate(async () => {
      const result = await request<{ profileFields: CharacterProfileFieldValue[] }>(token,
        `/api/dm/characters/${characterOverview.character.id}/profile-fields`, {
          values: characterOverview.profileFields.map((field) => ({ fieldId: field.id, value: profileFieldDraft[field.id] ?? "" }))
        }, 10000, "PUT");
      setCharacterOverview((current) => current ? { ...current, profileFields: result.profileFields } : current);
      const values = Object.fromEntries(result.profileFields.map((field) => [field.id, field.value]));
      profileFieldBase.current = values; setProfileFieldDraft(values);
      setNotice("Сведения персонажа сохранены.");
    });
  }
  function createProfileField(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selectedId}/profile-fields`, { label: newProfileFieldLabel });
      setNewProfileFieldLabel(""); setNotice("Поле профиля добавлено.");
    });
  }
  function renameProfileField(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !editingProfileField) return;
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selectedId}/profile-fields/${editingProfileField.id}`,
        { label: editingProfileField.label }, 10000, "PATCH");
      setEditingProfileField(null); setNotice("Название поля обновлено.");
    });
  }
  function reorderProfileField(fieldId: string, direction: -1 | 1) {
    if (!selectedId) return;
    const fields = (state?.profileFields ?? []).filter((field) => field.campaignId === selectedId)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const index = fields.findIndex((field) => field.id === fieldId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= fields.length) return;
    const ordered = [...fields]; [ordered[index], ordered[next]] = [ordered[next]!, ordered[index]!];
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selectedId}/profile-fields/reorder`, { fieldIds: ordered.map((field) => field.id) });
      setNotice("Порядок полей обновлён.");
    });
  }
  function deleteProfileField(field: { id: string; label: string }) {
    if (!selectedId || !window.confirm(`Удалить поле профиля?\n\nПоле «${field.label}» будет удалено из профилей всех персонажей кампании.`)) return;
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selectedId}/profile-fields/${field.id}`, undefined, 10000, "DELETE");
      setEditingProfileField(null); setNotice("Поле профиля удалено.");
    });
  }
  function editProfile(field: "name" | "shortDescription" | "archetype" | "origin" | "personalGoal" | "dmNotes" | "appearance" | "quote", value: string) {
    setProfileDraft((current) => current ? { ...current, [field]: value } : null);
  }
  function editProfileTrait(index: number, value: string) {
    setProfileDraft((current) => current ? { ...current, traits: current.traits.map((trait, traitIndex) => traitIndex === index ? value : trait) } : null);
  }
  function openCampaignForm() { setNotice(""); setError(""); setCampaignForm(true); }
  function confirm(intent: Confirmation) { setNotice(""); setError(""); setConfirmation(intent); }
  function createCampaign(event: FormEvent) {
    event.preventDefault();
    void mutate(async () => {
      const result = await request<{ campaign: Campaign }>(token, "/api/dm/campaigns", { name: campaignName.trim() });
      chooseCampaign(result.campaign.id); setCampaignForm(false); setCampaignName(""); setSessionName("");
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
    if (!selectedPlayer?.characterId || !selectedCatalogItem) return;
    void mutate(async () => {
      await request(token, "/api/dm/characters/" + selectedPlayer.characterId + "/items", {
        catalogItemId: selectedCatalogItem.id, quantity: Number(itemQuantity)
      });
      await refreshOverview();
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
  function revealNextFact(audience: KnowledgeFactRevealAudience, characterId?: string) {
    const entry = selectedKnowledge;
    if (!selected || !entry || workspaceMode !== "live" || knowledgeFacts.length === 0) return;
    const targetId = audience === "character" ? characterId : undefined;
    if (audience === "character" && !targetId) return;
    const operationKey = JSON.stringify([selected.id, entry.id, audience, targetId ?? null]);
    const operationId = pendingRevealOperations.current.getOrCreate(operationKey);
    void mutate(async () => {
      try {
        const { result } = await request<{ result: { fact: KnowledgeFact } | null }>(token,
          `/api/dm/campaigns/${selected.id}/knowledge/${entry.id}/facts/reveal-next`, {
            audience, ...(audience === "character" ? { characterId: targetId } : {}), operationId
          });
        pendingRevealOperations.current.complete(operationKey, operationId);
        setKnowledgeFactsReload((value) => value + 1);
        setNotice(result ? `Факт открыт ${audience === "party" ? "группе" : "персонажу"}.` : "Все факты для выбранного получателя уже открыты.");
      } catch (failure) {
        if (failure instanceof ApiError && failure.status < 500) {
          pendingRevealOperations.current.complete(operationKey, operationId);
          throw failure;
        }
        if (failure instanceof ApiError) throw failure;
        throw new AmbiguousRevealFailure("Не удалось подтвердить раскрытие. Нажмите действие ещё раз: повтор использует тот же запрос и не откроет следующий факт случайно.");
      }
    });
  }
  function revealSelectedFact(fact: KnowledgeFact, audience: KnowledgeFactRevealAudience, characterId?: string) {
    const entry = selectedKnowledge;
    if (!selected || !entry || workspaceMode !== "live") return;
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selected.id}/knowledge/${entry.id}/facts/${fact.id}/reveal`, {
        audience, ...(audience === "character" ? { characterId } : {})
      });
      setKnowledgeFactsReload((value) => value + 1);
      setNotice(`Факт открыт ${audience === "party" ? "группе" : "выбранному персонажу"}.`);
    });
  }
  function revealAllFacts(audience: KnowledgeFactRevealAudience, characterId?: string) {
    const entry = selectedKnowledge;
    if (!selected || !entry || workspaceMode !== "live" || !knowledgeFacts.length) return;
    void mutate(async () => {
      const { result } = await request<{ result: { createdCount: number } }>(token,
        `/api/dm/campaigns/${selected.id}/knowledge/${entry.id}/facts/reveal-all`, {
          audience, ...(audience === "character" ? { characterId } : {})
        });
      setKnowledgeFactsReload((value) => value + 1);
      setNotice(result.createdCount ? `Открыто фактов: ${result.createdCount}.` : "Новых закрытых фактов для этого получателя нет.");
    });
  }
  function revokeKnowledgeFactAccess() {
    const entry = selectedKnowledge;
    const target = revokingKnowledgeFact;
    if (!selected || !entry || !target) return;
    void mutate(async () => {
      const { revoked } = await request<{ revoked: boolean }>(token,
        `/api/dm/campaigns/${selected.id}/knowledge/${entry.id}/facts/${target.fact.id}/revoke`, {
          audience: target.reveal.audience,
          ...(target.reveal.audience === "character" ? { characterId: target.reveal.characterId } : {})
        });
      setRevokingKnowledgeFact(null); setKnowledgeFactsReload((value) => value + 1);
      setNotice(revoked ? "Доступ к факту отозван. История события сохранена." : "Этот доступ уже отозван.");
    });
  }
  function createKnowledgeFact(event: FormEvent) {
    event.preventDefault();
    const entry = selectedKnowledge;
    if (!selected || !entry) return;
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selected.id}/knowledge/${entry.id}/facts`, { body: newKnowledgeFact.trim() });
      setNewKnowledgeFact(""); setKnowledgeFactsReload((value) => value + 1); setNotice("Факт добавлен.");
    });
  }
  function saveKnowledgeFact(event: FormEvent) {
    event.preventDefault();
    const entry = selectedKnowledge;
    const draft = editingKnowledgeFact;
    if (!selected || !entry || !draft) return;
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selected.id}/knowledge/${entry.id}/facts/${draft.id}`, { body: draft.body.trim() }, 10000, "PATCH");
      setEditingKnowledgeFact(null); setKnowledgeFactsReload((value) => value + 1); setNotice("Факт сохранён.");
    });
  }
  function moveKnowledgeFact(fact: KnowledgeFact, offset: -1 | 1) {
    const entry = selectedKnowledge;
    if (!selected || !entry) return;
    const index = knowledgeFacts.findIndex((item) => item.id === fact.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= knowledgeFacts.length) return;
    const factIds = knowledgeFacts.map((item) => item.id);
    [factIds[index], factIds[target]] = [factIds[target]!, factIds[index]!];
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selected.id}/knowledge/${entry.id}/facts/reorder`, { factIds });
      setKnowledgeFactsReload((value) => value + 1); setNotice("Порядок фактов изменён.");
    });
  }
  function deleteKnowledgeFact() {
    const entry = selectedKnowledge;
    const fact = deletingKnowledgeFact;
    if (!selected || !entry || !fact) return;
    void mutate(async () => {
      await request(token, `/api/dm/campaigns/${selected.id}/knowledge/${entry.id}/facts/${fact.id}`, undefined, 10000, "DELETE");
      setDeletingKnowledgeFact(null); setEditingKnowledgeFact(null);
      setKnowledgeFactsReload((value) => value + 1); setNotice("Факт удалён. История раскрытий сохранена.");
    });
  }
  function createBackup() {
    void mutate(async () => {
      const { backup } = await request<{ backup: BackupInfo }>(token, "/api/dm/backups", {}, 120000);
      await downloadFile(token, "/api/dm/backups/" + encodeURIComponent(backup.id) + "/download", "ProgDM-rezervnaya-kopiya.db");
      setNotice("Резервная копия создана и скачана.");
    });
  }
  function restoreBackupNow() {
    if (!backupId || !window.confirm("Текущая база будет заменена выбранной копией. Перед восстановлением приложение автоматически сохранит текущие данные. Продолжить?")) return;
    void mutate(async () => {
      await request(token, "/api/dm/backups/restore", { id: backupId }, 120000);
      closeCharacter(); historyRequests.current.invalidate(); setFullActivity(null);
      setNotice("Копия восстановлена. Перед восстановлением создана страховочная копия.");
    });
  }
  function checkHealth() {
    void mutate(async () => {
      const result = await request<DataHealth>(token, "/api/dm/data/health", {});
      setHealth(result);
      setNotice(result.ok ? "Проблем не обнаружено." : "Обнаружены проблемы с данными.");
    });
  }
  function changeCharacterArchive(character: Character) {
    void mutate(async () => {
      await request(token, `/api/dm/characters/${character.id}/${character.archivedAt ? "restore" : "archive"}`, {});
      if (characterOverview?.character.id === character.id) {
        await refreshOverview();
      }
      setNotice(character.archivedAt ? "Персонаж восстановлен." : "Персонаж архивирован.");
    });
  }
  function exportCampaign() {
    if (!selected) return;
    void mutate(async () => {
      await downloadFile(token, "/api/dm/campaigns/" + selected.id + "/export", "ProgDM-kampaniya.json");
      setNotice("Кампания выгружена в файл.");
    });
  }
  function importCampaignFile(file?: File) {
    if (!file) return;
    void mutate(async () => {
      let archive: unknown;
      try { archive = JSON.parse(await file.text()); }
      catch { throw new Error("Файл не является корректным JSON."); }
      const result = await request<{ campaign: Campaign }>(token, "/api/dm/campaigns/import", archive, 120000);
      chooseCampaign(result.campaign.id);
      setNotice("Кампания импортирована.");
    });
  }
  function saveKnowledgeVisibility(entry: KnowledgeEntry, draft: { visibility: KnowledgeVisibility; characterId: string }) {
    const visibility = draft.visibility;
    if (visibility === entry.visibility && (visibility !== "character" || draft.characterId === entry.visibleToCharacterId)) return;
    void mutate(async () => {
      await request(token, "/api/dm/knowledge/" + entry.id + "/visibility", visibility === "character"
        ? { visibility, characterId: draft.characterId }
        : { visibility });
      await refreshOverview();
      setNotice(visibility === "hidden" ? "Запись скрыта от игроков." : "Доступ к записи обновлён.");
    });
  }
  function approvePlayer(player: Player) {
    const choice = characterChoices[player.id] ?? "";
    const characterName = (playerNames[player.id] ?? player.displayName).trim();
    void mutate(async () => {
      await request(token, "/api/dm/players/" + player.id + "/approve",
        approvalTarget(choice, characterName));
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
    closeCharacter(); historyRequests.current.invalidate();
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
        {selected && <nav className="dm-navigation" aria-label="Разделы ведущего">
          <p className="dm-nav-label">Рабочее место</p>
          {(workspaceMode === "live" ? [
            { id: "players", label: "Игроки", icon: Users }, { id: "join", label: "Подключение", icon: QrCode },
            { id: "characters", label: "Персонажи", icon: UserPlus }, { id: "knowledge", label: "Знания", icon: Eye },
            { id: "history", label: "История", icon: ScrollText }
          ] : [
            { id: "sessions", label: "Сессии", icon: CalendarDays }, { id: "characters", label: "Персонажи", icon: UserPlus },
            { id: "catalog", label: "Предметы", icon: PackagePlus }, { id: "knowledge", label: "Знания", icon: Eye },
            { id: "history", label: "История", icon: ScrollText }, { id: "data", label: "Данные", icon: Database }
          ]).map(({ id, label, icon: Icon }) => <button key={id} className={section === id ? "selected" : ""} aria-current={section === id ? "page" : undefined} onClick={() => showSection(id as DmSection)}><Icon size={17} />{label}</button>)}
        </nav>}
      </aside>
      <main className="content">
        {!campaignForm && !confirmation && alerts}
        {phase === "loading" && !state && <p role="status" className="empty">Загрузка кампаний...</p>}
        {phase === "error" && !state && <div className="empty"><h1>Данные недоступны</h1><button className="secondary" onClick={() => { setError(""); void refresh().catch((failure: Error) => setError(failure.message)); }}><RefreshCw />Повторить</button></div>}
        {state && !selected && <section className="empty">
          <BookOpen size={40} strokeWidth={1.4} /><h1>Кампаний пока нет</h1>
          <button className="primary" disabled={locked} onClick={openCampaignForm}><FolderPlus />Создать кампанию</button>
        </section>}
        {selected && <>
          <div className="page-heading"><div><p className="eyebrow">Кампания</p><h1>{selected.name}</h1></div><span className="muted">{sessionCount(sessions.length)}</span></div>
          <div className="workspace-tabs" role="tablist" aria-label="Режим работы">
            <button role="tab" aria-selected={workspaceMode === "prepare"} className={workspaceMode === "prepare" ? "selected" : ""} onClick={() => { setWorkspaceMode("prepare"); showSection("sessions"); }}><ClipboardList size={17} />Подготовка</button>
            <button role="tab" aria-selected={workspaceMode === "live"} className={workspaceMode === "live" ? "selected" : ""} disabled={!current || current.campaign.id !== selectedId} onClick={() => { setWorkspaceMode("live"); showSection("players"); }}><Radio size={17} />За столом</button>
          </div>
          <div className={"dm-layout" + (section === "history" ? " dm-layout-wide" : "")}><div className="dm-main">
          {current?.campaign.id === selectedId && <section className="current-session" aria-label="Текущая сессия">
            <div className="current-title"><span className="live-label"><i className="live-dot" />Сейчас за столом</span><strong>{current.session.name}</strong></div>
            <button className="secondary" disabled={locked} onClick={() => confirm({ kind: "end", session: current.session, previousId: current.session.id })}><CircleStop />Завершить</button>
          </section>}
          {section === "join" && workspaceMode === "live" && current?.campaign.id === selectedId && <section className="join-panel" aria-labelledby="join-title">
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
          {section === "data" && workspaceMode === "prepare" &&
          <section className="data-tools" aria-labelledby="data-tools-title">
            <div className="section-heading"><h2 id="data-tools-title"><Database size={18} />Данные и копии</h2></div>
            <div className="data-tool-actions">
              <button className="secondary" disabled={locked} onClick={createBackup}><Download />Создать копию и скачать базу</button>
              <button className="secondary" disabled={locked} onClick={exportCampaign}><Download />Экспорт кампании</button>
              <label className="secondary file-action"><Upload />Импорт кампании<input type="file" accept=".json,application/json" disabled={locked} onChange={(event) => { importCampaignFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
              <button className="secondary" disabled={locked} onClick={checkHealth}><Check />Проверить данные</button>
            </div>
            {health && <div className="health-result" role="status">
              <strong>{health.ok ? "Проблем не обнаружено" : "Обнаружены проблемы"}</strong>
              {!health.ok && <ul>{health.checks.filter((item) => item.status === "error").map((item) => <li key={item.name}>{item.name}: {item.message}</li>)}</ul>}
            </div>}
            <p className="muted backup-note">Копии хранятся в data/backups. Для переноса сохраните файл базы вместе с папкой progdm-backup-…-uploads с тем же идентификатором.</p>
            {backups.length > 0 && <div className="backup-restore">
              <div className="field"><label htmlFor="backup-choice">Резервная копия</label><select id="backup-choice" value={backupId} disabled={locked} onChange={(event) => setBackupId(event.target.value)}>
                {backups.map((backup) => <option key={backup.id} value={backup.id}>{new Date(backup.createdAt).toLocaleString("ru-RU")} · {(backup.size / 1024 / 1024).toFixed(1)} МБ</option>)}
              </select></div>
              <button className="secondary" disabled={locked || !backupId} onClick={restoreBackupNow}><RefreshCw />Восстановить</button>
              <button className="icon-button" title="Скачать выбранную копию" aria-label="Скачать выбранную копию" disabled={locked || !backupId} onClick={() => void mutate(async () => {
                await downloadFile(token, "/api/dm/backups/" + encodeURIComponent(backupId) + "/download", "ProgDM-rezervnaya-kopiya.db");
              })}><Download /></button>
            </div>}
          </section>
          }
          {section === "sessions" && workspaceMode === "prepare" && <>
          <section className="session-create" aria-labelledby="new-session-title">
            <h2 id="new-session-title">Новая сессия</h2>
            <form className="inline-form" onSubmit={createSession}>
              <div className="field"><label htmlFor="session-name">Название</label><input id="session-name" placeholder={"Сессия " + (sessions.length + 1)} maxLength={120} required value={sessionName} disabled={locked} onChange={(event) => setSessionName(event.target.value)} /></div>
              <button className="primary" disabled={locked || !sessionName.trim()}><Plus />Создать сессию</button>
            </form>
          </section>
          <section className="session-history" aria-labelledby="sessions-title">
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
          </section></>}
          {section === "catalog" && workspaceMode === "prepare" &&
          <section className="catalog-section" aria-labelledby="catalog-title">
            <div className="section-heading"><h2 id="catalog-title">Справочник предметов <span className="count">{campaignItemCatalog.length}</span></h2></div>
            <form className="inline-form catalog-create-form" onSubmit={createCatalogItem}>
              <div className="field"><label htmlFor="catalog-item-name">Название предмета</label><input id="catalog-item-name" value={catalogItemName} maxLength={120} required disabled={locked} onChange={(event) => setCatalogItemName(event.target.value)} placeholder="Например, старинный ключ" /></div>
              <button className="secondary" disabled={locked || !catalogItemName.trim()}><Plus />Добавить в справочник</button>
            </form>
            {campaignItemCatalog.length > 0 && <ul className="character-list">{campaignItemCatalog.map((item) => <li key={item.id}><PackagePlus size={16} /><span>{item.name}</span></li>)}</ul>}
          </section>}
          {section === "characters" &&
          <section className="character-tools">
            <div className="section-heading"><h2>Персонажи <span className="count">{campaignCharacters.length}</span></h2></div>
            {workspaceMode === "prepare" && <details className="campaign-profile-fields">
              <summary>Поля профиля персонажа <span className="count">{campaignProfileFields.length} / 20</span></summary>
              {campaignProfileFields.length > 0 && <ul className="character-list">{campaignProfileFields.map((field, index) => <li key={field.id}>
                {editingProfileField?.id === field.id ? <form className="inline-form" onSubmit={renameProfileField}>
                  <input aria-label="Название поля профиля" value={editingProfileField.label} maxLength={60} disabled={locked}
                    onChange={(event) => setEditingProfileField({ id: field.id, label: event.target.value })} />
                  <button className="secondary" disabled={locked || !editingProfileField.label.trim()}>Сохранить</button>
                  <button type="button" className="icon-button" aria-label="Отмена" onClick={() => setEditingProfileField(null)}><X /></button>
                </form> : <><span>{field.label}</span>
                  <button className="icon-button" title="Переместить выше" aria-label={`Переместить поле «${field.label}» выше`} disabled={locked || index === 0} onClick={() => reorderProfileField(field.id, -1)}><ArrowUp /></button>
                  <button className="icon-button" title="Переместить ниже" aria-label={`Переместить поле «${field.label}» ниже`} disabled={locked || index === campaignProfileFields.length - 1} onClick={() => reorderProfileField(field.id, 1)}><ArrowDown /></button>
                  <button className="icon-button" title="Переименовать поле" aria-label={`Переименовать поле «${field.label}»`} disabled={locked} onClick={() => setEditingProfileField({ id: field.id, label: field.label })}><Pencil /></button>
                  <button className="icon-button" title="Удалить поле" aria-label={`Удалить поле «${field.label}»`} disabled={locked} onClick={() => deleteProfileField(field)}><Trash2 /></button>
                </>}
              </li>)}</ul>}
              <form className="inline-form character-create-form" onSubmit={createProfileField}>
                <div className="field"><label htmlFor="campaign-profile-field-label">Название нового поля</label><input id="campaign-profile-field-label"
                  value={newProfileFieldLabel} maxLength={60} disabled={locked || campaignProfileFields.length >= 20}
                  onChange={(event) => setNewProfileFieldLabel(event.target.value)} placeholder="Например, Орден" /></div>
                <button className="secondary" disabled={locked || campaignProfileFields.length >= 20 || !newProfileFieldLabel.trim()}><Plus />Добавить поле</button>
              </form>
            </details>}
            {workspaceMode === "prepare" && <form className="inline-form character-create-form" onSubmit={createCharacter}>
              <div className="field"><label htmlFor="new-character-name">Имя персонажа</label><input id="new-character-name" value={newCharacterName} maxLength={120} disabled={locked} onChange={(event) => setNewCharacterName(event.target.value)} placeholder="Для назначения игроку" /></div>
              <button className="secondary" disabled={locked || !newCharacterName.trim()}><UserPlus />Добавить персонажа</button>
            </form>}
            {campaignCharacters.length > 0 && <ul className="character-list">{campaignCharacters.map((character: Character) => <li key={character.id}>
              <Users size={16} /><button className="text-link" onClick={() => openCharacter(character.id)}>{character.name}{character.archivedAt ? " · В архиве" : ""}</button>
              <button className="icon-button" title={character.archivedAt ? "Вернуть из архива" : "Архивировать"} aria-label={(character.archivedAt ? "Вернуть из архива " : "Архивировать ") + character.name} disabled={locked || (!character.archivedAt && assignedCharacterIds.has(character.id))} onClick={() => changeCharacterArchive(character)}>{character.archivedAt ? <RotateCcw /> : <Archive />}</button>
            </li>)}</ul>}
          </section>}
          {section === "history" && <section className="activity-section" aria-labelledby="activity-title">
            <div className="section-heading"><h2 id="activity-title">История кампании</h2></div>
            <ActivityList activity={fullActivity ?? campaignActivity} />
          </section>}
          {workspaceMode === "live" && section === "players" && <section className="party-section" aria-labelledby="players-title">
            <div className="section-heading"><h2 id="players-title">Игроки <span className="count">{approvedPlayers.length}</span></h2>
              {pendingPlayers.length > 0 && <span className="badge pending">Новые заявки: {pendingPlayers.length}</span>}
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
                <button className="text-link character-name" onClick={() => player.characterId && openCharacter(player.characterId)}>{player.characterName}</button><span className="badge accepted"><Check size={15} />В партии</span>
              </li>)}
            </ul>}
            {pendingPlayers.length === 0 && approvedPlayers.length === 0 && <p className="empty-list">Заявок пока нет</p>}
          </section>
          }
          {section === "character" && !characterOverview && <p role="status">Загружаем профиль...</p>}
          {section === "character" && characterOverview?.character.campaignId === selectedId && profileDraft && <section id="character-overview" className="character-overview" aria-labelledby="character-overview-title">
            <div className="section-heading"><h2 id="character-overview-title">{characterOverview.character.name}{characterOverview.character.archivedAt ? " · В архиве" : ""}</h2>
              <button className="icon-button" title="Закрыть профиль" aria-label="Закрыть профиль" onClick={() => { closeCharacter(); showSection(workspaceMode === "live" ? "players" : "characters"); }}><X /></button></div>
            <p className="muted">{characterOverview.player ? `Сейчас играет: ${characterOverview.player.displayName}` : "Сейчас не назначен"}</p>
            <div className="character-profile-readout">
              <p><strong>Архетип:</strong> {characterOverview.character.archetype || "Не указан"}</p>
              <p><strong>Происхождение:</strong> {characterOverview.character.origin || "Не указано"}</p>
              <p><strong>Описание:</strong> {characterOverview.character.shortDescription || "Не указано"}</p>
              {characterOverview.character.traits.length > 0 && <p><strong>Черты:</strong> {characterOverview.character.traits.join(" · ")}</p>}
              <p><strong>Личная цель:</strong> {characterOverview.character.personalGoal || "Не указана"}</p>
              {characterOverview.character.appearance && <p><strong>Внешность:</strong> {characterOverview.character.appearance}</p>}
              {characterOverview.character.quote && <p><strong>Цитата:</strong> {characterOverview.character.quote}</p>}
              {characterOverview.profileFields.filter((field) => field.value.trim()).map((field) => <p key={field.id}><strong>{field.label}:</strong> {field.value}</p>)}
              <p><strong>Заметки ведущего:</strong> {characterOverview.character.dmNotes || "Нет"}</p>
            </div>
            <div className="character-overview-actions">
              {selectedPlayer && <button className="secondary" aria-expanded={grantOpen} onClick={() => setGrantOpen(!grantOpen)}><PackagePlus />Выдать предмет</button>}
              <button className="secondary" onClick={() => { setKnowledgeTargetId(characterOverview.character.id); showSection("knowledge"); }}><Eye />Открыть знание</button>
              <button className="secondary" disabled={locked || (!characterOverview.character.archivedAt && !!characterOverview.player)} onClick={() => changeCharacterArchive(characterOverview.character)}>{characterOverview.character.archivedAt ? <RotateCcw /> : <Archive />}{characterOverview.character.archivedAt ? "Вернуть" : "Архивировать"}</button>
            </div>
            {grantOpen && selectedPlayer && <form className="item-grant-form contextual-grant" onSubmit={grantItem}>
              <div className="field"><label htmlFor="catalog-item">Предмет для {characterOverview.character.name}</label>
                {campaignItemCatalog.length ? <select id="catalog-item" value={selectedCatalogItem?.id ?? ""} disabled={locked} onChange={(event) => setCatalogItemId(event.target.value)}>{campaignItemCatalog.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                  : <button type="button" className="text-link" onClick={() => { setWorkspaceMode("prepare"); showSection("catalog"); }}>Открыть справочник предметов</button>}
              </div>
              <div className="field quantity-field"><label htmlFor="item-quantity">Количество</label><input id="item-quantity" type="number" min={1} max={9999} step={1} required value={itemQuantity} disabled={locked} onChange={(event) => setItemQuantity(event.target.value)} /></div>
              <button className="primary" disabled={locked || !selectedCatalogItem || !Number.isInteger(Number(itemQuantity)) || Number(itemQuantity) < 1 || Number(itemQuantity) > 9999}><PackagePlus />Выдать</button>
            </form>}
            <details className="character-edit"><summary>Редактировать профиль</summary>
              <form className="character-profile-form" onSubmit={saveCharacterProfile}>
                <label>Имя<input value={profileDraft.name} maxLength={120} required disabled={locked} onChange={(event) => editProfile("name", event.target.value)} /></label>
                <label>Краткое описание<textarea value={profileDraft.shortDescription} maxLength={500} rows={2} disabled={locked} onChange={(event) => editProfile("shortDescription", event.target.value)} /></label>
                <label>Архетип<input value={profileDraft.archetype} maxLength={120} disabled={locked} onChange={(event) => editProfile("archetype", event.target.value)} /></label>
                <label>Происхождение<textarea value={profileDraft.origin} maxLength={500} rows={2} disabled={locked} onChange={(event) => editProfile("origin", event.target.value)} /></label>
                <label>Личная цель<textarea value={profileDraft.personalGoal} maxLength={500} rows={2} disabled={locked} onChange={(event) => editProfile("personalGoal", event.target.value)} /></label>
                <fieldset className="character-traits-editor" disabled={locked}>
                  <legend>Черты ({profileDraft.traits.length} / 8)</legend>
                  {profileDraft.traits.map((trait, index) => <div className="character-trait-row" key={`profile-trait-${index}`}>
                    <input aria-label={`Черта ${index + 1}`} value={trait} maxLength={40} onChange={(event) => editProfileTrait(index, event.target.value)} />
                    <button type="button" className="icon-button" aria-label={`Удалить черту ${index + 1}`} onClick={() => setProfileDraft((current) => current ? { ...current, traits: current.traits.filter((_, traitIndex) => traitIndex !== index) } : null)}><X /></button>
                  </div>)}
                  <button type="button" className="text-link" disabled={profileDraft.traits.length >= 8} onClick={() => setProfileDraft((current) => current && current.traits.length < 8 ? { ...current, traits: [...current.traits, ""] } : current)}>Добавить черту</button>
                </fieldset>
                <label>Внешность<textarea value={profileDraft.appearance} maxLength={1000} rows={3} disabled={locked} onChange={(event) => editProfile("appearance", event.target.value)} /></label>
                <label>Цитата<textarea value={profileDraft.quote} maxLength={300} rows={2} disabled={locked} onChange={(event) => editProfile("quote", event.target.value)} /></label>
                <label>Заметки ведущего<textarea value={profileDraft.dmNotes} maxLength={2000} rows={3} disabled={locked} onChange={(event) => editProfile("dmNotes", event.target.value)} /></label>
                <button className="primary" disabled={locked || !profileDraft.name.trim() || profileDraft.traits.some((trait) => !trait.trim())}>Сохранить профиль</button>
              </form>
            </details>
            {characterOverview.profileFields.length > 0 && <details className="character-edit">
              <summary>Сведения кампании</summary>
              <form className="character-profile-form" onSubmit={saveCharacterProfileFields}>
                {characterOverview.profileFields.map((field) => <label key={field.id}>{field.label}
                  <input value={profileFieldDraft[field.id] ?? ""} maxLength={500} disabled={locked}
                    onChange={(event) => setProfileFieldDraft((current) => ({ ...current, [field.id]: event.target.value }))} />
                </label>)}
                <button className="primary" disabled={locked}>Сохранить сведения</button>
              </form>
            </details>}
            <div className="character-overview-grid">
              <div><h3>Инвентарь</h3>{characterOverview.inventory.length ? <ul>{characterOverview.inventory.map((item) => <li key={item.id}>{item.name} · {item.quantity}</li>)}</ul> : <p className="muted">Пусто</p>}</div>
              <div><h3>Знания</h3>{characterOverview.knowledge.length ? <ul>{characterOverview.knowledge.map((entry) => <li key={entry.id}>{entry.title}</li>)}</ul> : <p className="muted">Нет открытых записей</p>}</div>
              <div><h3>Личные заметки</h3>{characterOverview.notes.length ? <ul>{characterOverview.notes.map((note) => <li key={note.id}>{note.body}</li>)}</ul> : <p className="muted">Пусто</p>}</div>
              <div><h3>Последние события</h3>{characterOverview.activity.length ? <ul>{characterOverview.activity.slice(0, 5).map((event) => <li key={event.id}>{activitySummary(event)}</li>)}</ul> : <p className="muted">Пока нет событий</p>}</div>
            </div>
          </section>}
          {section === "knowledge" && <section className="knowledge-section" aria-labelledby="knowledge-title">
            <div className="section-heading"><h2 id="knowledge-title">Знания партии <span className="count">{campaignKnowledge.length}</span></h2></div>
            {workspaceMode === "prepare" && <details className="knowledge-add"><summary>Добавить запись</summary><form className="knowledge-create-form" onSubmit={createKnowledge}>
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
            </form></details>}
            <div className="field knowledge-search"><label htmlFor="knowledge-search">Найти запись</label><input id="knowledge-search" value={knowledgeSearch} onChange={(event) => { setKnowledgeSearch(event.target.value); setSelectedKnowledgeId(""); setKnowledgeTargetId(characterOverview?.character.id ?? ""); }} placeholder="Название" /></div>
            {campaignKnowledge.length === 0 ? <p className="empty-list">Записей пока нет</p> : filteredKnowledge.length === 0 ? <p className="empty-list">Ничего не найдено</p> : <div className="knowledge-workspace">
              <ul className="knowledge-index">{filteredKnowledge.map((entry) => <li key={entry.id}><button className={selectedKnowledge?.id === entry.id ? "selected" : ""} onClick={() => { setSelectedKnowledgeId(entry.id); setKnowledgeTargetId(entry.visibleToCharacterId ?? characterOverview?.character.id ?? ""); }}>
                <span>{entry.title}</span><small>{knowledgeCategories[entry.category]} · {entry.visibility === "hidden" ? "Скрыто" : entry.visibility === "party" ? "Вся партия" : "Персонаж"}</small>
              </button></li>)}</ul>
              {selectedKnowledge && (() => {
                const entry = selectedKnowledge;
                const targetMissing = !campaignCharacters.some((character) => character.id === knowledgeTargetId);
                const partyRevealedIds = new Set(knowledgeFactReveals.filter((reveal) => reveal.audience === "party").map((reveal) => reveal.knowledgeFactId));
                const nextPartyFact = knowledgeFacts.find((fact) => !partyRevealedIds.has(fact.id));
                const partyRevealedCount = knowledgeFacts.filter((fact) => partyRevealedIds.has(fact.id)).length;
                return <div className="knowledge-detail">
                  <p className="eyebrow knowledge-summary-label">Краткое описание · управление доступом</p>
                  <div className="knowledge-entry-copy">
                    <div className="knowledge-entry-heading"><span className="knowledge-category">{knowledgeCategories[entry.category]}</span>
                      <h3>{entry.title}</h3></div>
                    <p>{entry.description}</p>
                    <span className={"knowledge-visibility " + entry.visibility}>
                      {entry.visibility === "hidden" ? "Скрыто" : entry.visibility === "party" ? "Открыто всей партии" : "Знает персонаж: " + (state?.characters.find((character) => character.id === entry.visibleToCharacterId)?.name ?? "персонаж")}
                    </span>
                  </div>
                  <div className="knowledge-quick-actions">
                    <button className="secondary" disabled={locked || entry.visibility === "party"} onClick={() => saveKnowledgeVisibility(entry, { visibility: "party", characterId: "" })}><Eye />Открыть описание партии</button>
                    {characterOverview?.character.campaignId === selectedId && <button className="secondary" disabled={locked || (entry.visibility === "character" && entry.visibleToCharacterId === characterOverview.character.id)} onClick={() => saveKnowledgeVisibility(entry, { visibility: "character", characterId: characterOverview.character.id })}><Eye />Открыть описание: {characterOverview.character.name}</button>}
                    <button className="secondary" disabled={locked || entry.visibility === "hidden"} onClick={() => saveKnowledgeVisibility(entry, { visibility: "hidden", characterId: "" })}><EyeOff />Скрыть описание</button>
                  </div>
                  <form className="knowledge-controls" onSubmit={(event) => { event.preventDefault(); saveKnowledgeVisibility(entry, { visibility: "character", characterId: knowledgeTargetId }); }}>
                    <label htmlFor={"knowledge-character-" + entry.id}>Конкретному персонажу</label>
                    <select id={"knowledge-character-" + entry.id} value={knowledgeTargetId} disabled={locked} onChange={(event) => setKnowledgeTargetId(event.target.value)}>
                      <option value="">Выберите персонажа</option>
                      {campaignCharacters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
                    </select>
                    <button className="secondary" disabled={locked || targetMissing || (entry.visibility === "character" && entry.visibleToCharacterId === knowledgeTargetId)}><Eye />Открыть персонажу</button>
                  </form>
                  <section className="knowledge-facts" aria-labelledby="knowledge-facts-title">
                    <div className="section-heading"><h3 id="knowledge-facts-title">Факты · раскрытие во время игры</h3><span className="count">{knowledgeFacts.length}</span></div>
                    <p className="muted knowledge-facts-hint">Факты открываются отдельно и не меняют доступ к краткому описанию.</p>
                    {workspaceMode === "live" && knowledgeFacts.length > 0 && <div className="knowledge-live-reveal">
                      <p className="knowledge-reveal-progress">{partyRevealedCount} / {knowledgeFacts.length} открыто группе</p>
                      {nextPartyFact ? <p className="knowledge-next-preview"><span>Следующий факт</span>{nextPartyFact.body}</p> : <p className="muted">Все факты уже открыты группе.</p>}
                      <button className="primary" disabled={locked || !nextPartyFact || knowledgeFactsLoading}
                        onClick={() => revealNextFact("party")}><Eye />Открыть группе</button>
                    </div>}
                    {knowledgeFactsLoading ? <p className="muted">Загружаем факты…</p> : knowledgeFactsError ? <p className="message error" role="alert">{knowledgeFactsError}</p> : knowledgeFacts.length ? <ol className="knowledge-fact-list">
                      {knowledgeFacts.map((fact, index) => <li className="knowledge-fact-row" key={fact.id}>
                        {(() => {
                          const grants = knowledgeFactReveals.filter((reveal) => reveal.knowledgeFactId === fact.id);
                          const nameForReveal = (reveal: KnowledgeFactReveal) => campaignCharacters.find((character) => character.id === reveal.characterId)?.name ?? "Персонаж";
                          return <div className="knowledge-fact-status" aria-label="Кому открыт факт">
                            {grants.some((reveal) => reveal.audience === "party") && <span>Группе</span>}
                            {grants.filter((reveal) => reveal.audience === "character").map((reveal) => <span key={reveal.id}>{nameForReveal(reveal)}</span>)}
                            {!grants.length && <span className="muted">Скрыт</span>}
                          </div>;
                        })()}
                        {workspaceMode === "prepare" && editingKnowledgeFact?.id === fact.id ? <form className="knowledge-fact-editor" onSubmit={saveKnowledgeFact}>
                          <label htmlFor={`knowledge-fact-edit-${fact.id}`}>Текст факта</label>
                          <textarea id={`knowledge-fact-edit-${fact.id}`} value={editingKnowledgeFact.body} maxLength={2000} required disabled={locked}
                            onChange={(event) => setEditingKnowledgeFact({ id: fact.id, body: event.target.value })} rows={3} />
                          <div className="knowledge-fact-actions"><button className="secondary" type="button" disabled={locked} onClick={() => setEditingKnowledgeFact(null)}>Отмена</button>
                            <button className="primary" disabled={locked || !editingKnowledgeFact.body.trim()}>Сохранить</button></div>
                        </form> : <>
                          <p>{fact.body}</p>
                          {workspaceMode === "prepare" && <div className="knowledge-fact-actions" aria-label="Действия с фактом">
                            <button className="icon-button" type="button" title="Переместить выше" aria-label="Переместить факт выше" disabled={locked || index === 0} onClick={() => moveKnowledgeFact(fact, -1)}><ArrowUp /></button>
                            <button className="icon-button" type="button" title="Переместить ниже" aria-label="Переместить факт ниже" disabled={locked || index === knowledgeFacts.length - 1} onClick={() => moveKnowledgeFact(fact, 1)}><ArrowDown /></button>
                            <button className="icon-button" type="button" title="Изменить факт" aria-label="Изменить факт" disabled={locked} onClick={() => setEditingKnowledgeFact({ id: fact.id, body: fact.body })}><Pencil /></button>
                            <button className="icon-button" type="button" title="Удалить факт" aria-label="Удалить факт" disabled={locked} onClick={() => setDeletingKnowledgeFact(fact)}><Trash2 /></button>
                          </div>}
                          {workspaceMode === "live" && <details className="knowledge-fact-live-menu">
                            <summary>Действия</summary>
                            {(() => {
                              const grants = knowledgeFactReveals.filter((reveal) => reveal.knowledgeFactId === fact.id);
                              const partyGrant = grants.some((reveal) => reveal.audience === "party");
                              const characterGrant = knowledgeRevealCharacterId
                                ? grants.find((reveal) => reveal.audience === "character" && reveal.characterId === knowledgeRevealCharacterId)
                                : undefined;
                              return <div className="knowledge-fact-live-actions">
                                <button type="button" className="secondary" disabled={locked || partyGrant || knowledgeFactsLoading}
                                  onClick={() => revealSelectedFact(fact, "party")}>{partyGrant ? "Уже открыто группе" : "Открыть этот факт группе"}</button>
                                <button type="button" className="secondary" disabled={locked || !knowledgeRevealCharacterId || Boolean(characterGrant) || knowledgeFactsLoading}
                                  onClick={() => revealSelectedFact(fact, "character", knowledgeRevealCharacterId)}>{characterGrant ? "Уже открыто персонажу" : "Открыть выбранному персонажу"}</button>
                                {grants.map((reveal) => <button type="button" className="text-action" key={reveal.id} disabled={locked}
                                  onClick={() => setRevokingKnowledgeFact({ fact, reveal })}>Отозвать доступ: {reveal.audience === "party" ? "группе" : campaignCharacters.find((character) => character.id === reveal.characterId)?.name ?? "персонажу"}</button>)}
                              </div>;
                            })()}
                          </details>}
                        </>}
                      </li>)}
                    </ol> : !knowledgeFactsLoading && <p className="muted">Для этой записи фактов пока нет.</p>}
                    {workspaceMode === "prepare" && <form className="knowledge-fact-create" onSubmit={createKnowledgeFact}>
                      <label htmlFor="knowledge-fact-new">Добавить факт</label>
                      <textarea id="knowledge-fact-new" value={newKnowledgeFact} maxLength={2000} required disabled={locked || knowledgeFactsLoading}
                        onChange={(event) => setNewKnowledgeFact(event.target.value)} rows={3} placeholder="Отдельное сведение, которое можно будет открыть позже" />
                      <button className="secondary" disabled={locked || knowledgeFactsLoading || !newKnowledgeFact.trim()}><Plus />Добавить факт</button>
                    </form>}
                    {workspaceMode === "live" && knowledgeFacts.length > 0 && <details className="knowledge-reveal-more">
                      <summary>Дополнительно</summary>
                      <div className="knowledge-reveal-more-content">
                        <button type="button" className="secondary" disabled={locked || !nextPartyFact || knowledgeFactsLoading}
                          onClick={() => revealAllFacts("party")}>Открыть все факты группе</button>
                        {liveRevealCharacters.length ? <>
                          <div className="field"><label htmlFor="knowledge-reveal-character">Персонаж текущей сессии</label>
                            <select id="knowledge-reveal-character" value={knowledgeRevealCharacterId} disabled={locked || knowledgeFactsLoading}
                              onChange={(event) => setKnowledgeRevealCharacterId(event.target.value)}>
                              {liveRevealCharacters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
                            </select>
                          </div>
                          <div className="knowledge-reveal-more-actions">
                            <button type="button" className="secondary" disabled={locked || !knowledgeRevealCharacterId || knowledgeFactsLoading}
                              onClick={() => revealNextFact("character", knowledgeRevealCharacterId)}>Открыть следующий персонажу</button>
                            <button type="button" className="secondary" disabled={locked || !knowledgeRevealCharacterId || knowledgeFactsLoading}
                              onClick={() => revealAllFacts("character", knowledgeRevealCharacterId)}>Открыть все персонажу</button>
                          </div>
                        </> : <p className="muted">В активной сессии пока нет принятых игроков с назначенными персонажами.</p>}
                      </div>
                    </details>}
                  </section>
                </div>;
              })()}
            </div>}
          </section>}
          </div>{section !== "history" && <aside className="dm-context" aria-label="Контекст и последние события">
            {workspaceMode === "live" && <section><h2>Быстрый доступ</h2>
              <button className="secondary" onClick={() => showSection("players")}><Users />Игроки{pendingPlayers.length ? ` · ${pendingPlayers.length} ожидают` : ""}</button>
              <button className="secondary" onClick={() => showSection("join")}><QrCode />Показать QR</button>
              <button className="secondary" onClick={() => showSection("knowledge")}><Eye />Знания</button>
            </section>}
            <section><div className="section-heading"><h2>Последние события</h2><button className="icon-button" title="Вся история" aria-label="Вся история" onClick={() => showSection("history")}><ScrollText /></button></div>
              <ActivityList activity={campaignActivity.slice(-5).reverse()} />
            </section>
          </aside>}</div>
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
    {deletingKnowledgeFact && <Modal title="Удалить факт?" busy={busy} close={() => setDeletingKnowledgeFact(null)}>
      <p className="confirmation-copy">Факт исчезнет из текущих знаний. История уже совершённых раскрытий сохранится.</p>
      <div className="dialog-actions"><button className="secondary" autoFocus disabled={busy} onClick={() => setDeletingKnowledgeFact(null)}>Отмена</button>
        <button className="destructive" disabled={locked} onClick={deleteKnowledgeFact}>{busy ? "Удаление…" : "Удалить"}</button></div>
    </Modal>}
    {revokingKnowledgeFact && <Modal title="Отозвать доступ?" busy={busy} close={() => setRevokingKnowledgeFact(null)}>
      <p className="confirmation-copy">Это исправит текущий доступ к факту. Уже совершённое раскрытие останется в истории.</p>
      <div className="dialog-actions"><button className="secondary" autoFocus disabled={busy} onClick={() => setRevokingKnowledgeFact(null)}>Отмена</button>
        <button className="destructive" disabled={locked} onClick={revokeKnowledgeFactAccess}>{busy ? "Сохранение…" : "Отозвать доступ"}</button></div>
    </Modal>}
  </div>;
}
