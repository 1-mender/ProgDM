import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { Settings } from "lucide-react";
import type { PlayerInventoryTransferTarget, PlayerJournalCursor, PlayerJournalPage, PlayerState } from "@progdm/shared";
import { PlayerApiError, PlayerNetworkError, playerGet, playerPost } from "./api";
import { InventoryIntents, type InventoryIntent } from "./inventory-intents";
import { HomePage } from "./HomePage";
import { InventoryPage } from "./InventoryPage";
import { KnowledgePage } from "./KnowledgePage";
import { JournalPage, type JournalTab } from "./JournalPage";
import { PlayerShell } from "./PlayerShell";
import { ProfilePage } from "./ProfilePage";
import { resetPlayerScroll, type PlayerView } from "./model";
import "./player.css";

export function PlayerWorkspace({ player, credential, refresh }: { player: PlayerState; credential: string; refresh: () => Promise<void> }) {
  const inventoryIntents = useMemo(() => new InventoryIntents(credential, {
    getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value)
  }), [credential]);
  const [view, setView] = useState<PlayerView>("home");
  const [journalTab, setJournalTab] = useState<JournalTab>("chronicle");
  const [knowledgeFocusId, setKnowledgeFocusId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(player.displayName);
  const [expandedKnowledge, setExpandedKnowledge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useLayoutEffect(() => {
    resetPlayerScroll(window);
  }, [view, journalTab]);

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
  const runInventoryAction = async (intent: InventoryIntent, success: string): Promise<"success" | "ambiguous" | "failed"> => {
    if (busy) return "failed";
    setBusy(true);
    setError("");
    setNotice("");
    let mutationCommitted = false;
    try {
      await inventoryIntents.execute(intent, async (operationId) => {
        const result = await playerPost(credential, `/api/player/inventory/${intent.inventoryItemId}/${intent.type}`, {
          quantity: intent.quantity, operationId,
          ...(intent.type === "transfer" ? { recipientCharacterId: intent.recipientCharacterId } : {})
        });
        mutationCommitted = true;
        return result;
      }, refresh);
      setNotice(success);
      return "success";
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось изменить инвентарь.");
      return mutationCommitted || !(failure instanceof PlayerApiError) || failure instanceof PlayerNetworkError ? "ambiguous" : "failed";
    } finally {
      setBusy(false);
    }
  };
  const markSeen = (activityId: string) => void run(
    () => playerPost(credential, "/api/player/activity/seen", { upToActivityId: activityId }), "Просмотрено."
  );
  const loadJournalPage = useCallback((cursor?: PlayerJournalCursor) => {
    const query = new URLSearchParams({ limit: "30" });
    if (cursor) {
      query.set("beforeCreatedAt", cursor.beforeCreatedAt);
      query.set("beforeId", cursor.beforeId);
    }
    return playerGet<PlayerJournalPage>(credential, `/api/player/journal?${query.toString()}`);
  }, [credential]);
  const clearKnowledgeFocus = useCallback(() => setKnowledgeFocusId(null), []);
  let pendingInventory: InventoryIntent[] = [];
  try { pendingInventory = inventoryIntents.pending(); } catch { /* Destructive actions fail closed if storage is unavailable. */ }
  const recoverInventory = async () => {
    for (const intent of pendingInventory) {
      if (await runInventoryAction(intent, "Действие с инвентарём подтверждено.") !== "success") break;
    }
  };

  let content;
  if (view === "home") content = <HomePage player={player} busy={busy} onProfile={() => navigate("profile")} onJournal={() => navigate("journal")} onPinnedNotes={() => {
    setJournalTab("notes");
    navigate("journal");
  }} onMarkSeen={markSeen} />;
  else if (view === "profile") content = <ProfilePage player={player} busy={busy} onSave={(fields) => run(
    () => playerPost(credential, "/api/player/profile", fields), "Профиль сохранён."
  )} />;
  else if (view === "knowledge") content = <KnowledgePage player={player} focusEntryId={knowledgeFocusId} onFocusHandled={clearKnowledgeFocus} />;
  else if (view === "inventory") content = <InventoryPage player={player} busy={busy} actionError={error}
    onEquip={(itemId) => run(() => playerPost(credential, `/api/player/inventory/${itemId}/equip`, {}), "Предмет экипирован.")}
    onUnequip={(itemId) => run(() => playerPost(credential, `/api/player/inventory/${itemId}/unequip`, {}), "Предмет перемещён в сумку.")}
    onLoadTransferTargets={async (itemId) => (await playerGet<{ targets: PlayerInventoryTransferTarget[] }>(credential,
      `/api/player/inventory/${itemId}/transfer-targets`)).targets}
    onTransfer={(itemId, recipientId, quantity) => runInventoryAction(
      { type: "transfer", inventoryItemId: itemId, recipientCharacterId: recipientId, quantity }, "Предмет передан.")}
    onDiscard={(itemId, quantity) => runInventoryAction(
      { type: "discard", inventoryItemId: itemId, quantity }, "Предмет выброшен.")} />;
  else if (view === "journal") content = <JournalPage player={player} activeTab={journalTab} onTabChange={setJournalTab}
    onLoadPage={loadJournalPage} onOpenKnowledge={(entryId) => { setKnowledgeFocusId(entryId); navigate("knowledge"); }}
    onMarkSeen={markSeen} busy={busy} onSaveNote={(noteId, fields) => run(
      () => playerPost(credential, noteId ? `/api/player/notes/${noteId}` : "/api/player/notes", fields), "Заметка сохранена."
    )} />;
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
    {pendingInventory.length > 0 && player.canEdit && <div className="prod-feedback" role="status">
      <p>Есть неподтверждённые действия с инвентарём.</p>
      <button className="prod-secondary" type="button" disabled={busy} onClick={() => void recoverInventory()}>Проверить результат</button>
    </div>}
    {content}
  </PlayerShell>;
}
