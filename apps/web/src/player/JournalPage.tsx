import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { PersonalNote, PlayerActivityEvent, PlayerJournalCursor, PlayerJournalPage, PlayerState } from "@progdm/shared";
import { journalActivityPresentation, journalEventGroups, journalEventTime } from "./model";
import { PersonalNotesPage } from "./PersonalNotesPage";

export type JournalTab = "chronicle" | "notes";

function compareEvents(left: PlayerActivityEvent, right: PlayerActivityEvent) {
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
  return left.id === right.id ? 0 : left.id > right.id ? -1 : 1;
}

function mergeEvents(current: PlayerActivityEvent[], incoming: PlayerActivityEvent[]) {
  return [...new Map([...current, ...incoming].map((event) => [event.id, event])).values()].sort(compareEvents);
}

export function JournalPage({ player, activeTab, onTabChange, onLoadPage, onOpenKnowledge, onMarkSeen, onSaveNote, busy }: {
  player: PlayerState;
  activeTab: JournalTab;
  onTabChange: (tab: JournalTab) => void;
  onLoadPage: (cursor?: PlayerJournalCursor) => Promise<PlayerJournalPage>;
  onOpenKnowledge: (entryId: string) => void;
  onMarkSeen: (eventId: string) => void;
  onSaveNote: (noteId: string | null, fields: Pick<PersonalNote, "title" | "body" | "marker" | "pinned">) => Promise<boolean>;
  busy: boolean;
}) {
  const [events, setEvents] = useState<PlayerActivityEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<PlayerJournalCursor | null>(null);
  const [loading, setLoading] = useState<"first" | "more" | null>(null);
  const [loadError, setLoadError] = useState("");
  const [headError, setHeadError] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const headGeneration = useRef(0);
  const paginationInFlight = useRef(false);
  const hasLoadedMore = useRef(false);
  const lastHeadSignal = useRef("");
  const loadedEvents = useRef(events);
  const headSignal = JSON.stringify([
    player.recentActivity.map((event) => event.id),
    player.knowledge.map((entry) => [entry.id, entry.title, entry.summaryVisible, entry.facts.map((fact) => fact.id)])
  ]);

  const loadFirstPage = useCallback(async () => {
    const generation = ++requestGeneration.current;
    headGeneration.current++;
    paginationInFlight.current = true;
    hasLoadedMore.current = false;
    setInitialized(false);
    setLoading("first");
    setLoadError("");
    setHeadError("");
    setEvents([]);
    setNextCursor(null);
    setSelectedId(null);
    try {
      const page = await onLoadPage();
      if (requestGeneration.current !== generation) return;
      setEvents(mergeEvents([], page.events));
      setNextCursor(page.nextCursor);
      setInitialized(true);
    } catch (failure) {
      if (requestGeneration.current === generation) setLoadError(failure instanceof Error ? failure.message : "Не удалось загрузить хронику.");
    } finally {
      if (requestGeneration.current === generation) { paginationInFlight.current = false; setLoading(null); }
    }
  }, [onLoadPage]);

  useEffect(() => {
    if (activeTab !== "chronicle") return;
    lastHeadSignal.current = headSignal;
    void loadFirstPage();
    return () => { requestGeneration.current += 1; headGeneration.current += 1; paginationInFlight.current = false; };
  }, [activeTab, loadFirstPage, player.characterId]);

  const refreshHead = useCallback(async () => {
    const generation = requestGeneration.current;
    const headTicket = ++headGeneration.current;
    const previousHead = loadedEvents.current[0];
    setHeadError("");
    try {
      let page = await onLoadPage();
      const firstCursor = page.nextCursor;
      const incoming = [...page.events];
      // Bridge bursts larger than a page before keeping an already-loaded tail cursor.
      while (previousHead && page.nextCursor && page.events.length && compareEvents(page.events.at(-1)!, previousHead) < 0) {
        if (requestGeneration.current !== generation || headGeneration.current !== headTicket) return;
        page = await onLoadPage(page.nextCursor);
        incoming.push(...page.events);
      }
      if (requestGeneration.current !== generation || headGeneration.current !== headTicket) return;
      setEvents((current) => mergeEvents(current, incoming));
      if (!hasLoadedMore.current || !previousHead) setNextCursor(firstCursor);
    } catch {
      if (requestGeneration.current === generation && headGeneration.current === headTicket) {
        setHeadError("Не удалось обновить хронику. Попробуйте ещё раз.");
      }
    }
  }, [onLoadPage]);

  useEffect(() => {
    if (activeTab !== "chronicle" || !initialized || lastHeadSignal.current === headSignal) return;
    lastHeadSignal.current = headSignal;
    void refreshHead();
  }, [activeTab, initialized, headSignal, refreshHead]);

  const loadMore = async (cursor: PlayerJournalCursor | null = nextCursor) => {
    if (!cursor || paginationInFlight.current) return;
    paginationInFlight.current = true;
    const generation = requestGeneration.current;
    setLoading("more");
    setLoadError("");
    try {
      const page = await onLoadPage(cursor);
      if (requestGeneration.current !== generation) return;
      hasLoadedMore.current = true;
      setEvents((current) => mergeEvents(current, page.events));
      setNextCursor(page.nextCursor);
    } catch (failure) {
      if (requestGeneration.current === generation) setLoadError(failure instanceof Error ? failure.message : "Не удалось загрузить более ранние события.");
    } finally {
      if (requestGeneration.current === generation) { paginationInFlight.current = false; setLoading(null); }
    }
  };

  const safeEvents = useMemo(() => {
    const knowledge = new Map(player.knowledge.map((entry) => [entry.id, entry]));
    return events.flatMap<PlayerActivityEvent>((event) => {
      if (event.kind !== "knowledge_summary_opened" && event.kind !== "knowledge_facts_revealed") return [event];
      const entry = knowledge.get(event.knowledgeEntryId);
      if (!entry || (event.kind === "knowledge_summary_opened" ? !entry.summaryVisible : !entry.facts.length)) return [];
      return [{ ...event, knowledgeTitle: entry.title }];
    });
  }, [events, player.knowledge]);
  loadedEvents.current = safeEvents;
  const groups = useMemo(() => journalEventGroups(safeEvents), [safeEvents]);
  const selected = safeEvents.find((event) => event.id === selectedId);
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);
  const selectedPresentation = selected ? journalActivityPresentation(selected) : null;
  const SelectedIcon = selectedPresentation?.icon;
  const selectedGroup = selected ? groups.find((group) => group.events.some((event) => event.id === selected.id)) : null;
  const newEventIds = useMemo(() => new Set(player.newActivity.map((event) => event.id)), [player.newActivity]);
  const newestNewEvent = player.newActivity[0];

  const retry = () => {
    if (events.length && nextCursor) void loadMore(nextCursor);
    else void loadFirstPage();
  };

  return <section className="prod-page prod-journal-page" aria-labelledby="prod-journal-title">
    <h1 id="prod-journal-title">Журнал</h1>
    <div className="prod-journal-tabs" role="tablist" aria-label="Разделы журнала">
      <button id="prod-journal-chronicle-tab" type="button" role="tab" aria-selected={activeTab === "chronicle"}
        aria-controls="prod-journal-chronicle" className={activeTab === "chronicle" ? "selected" : ""}
        onClick={() => onTabChange("chronicle")}>Хроника</button>
      <button id="prod-journal-notes-tab" type="button" role="tab" aria-selected={activeTab === "notes"}
        aria-controls="prod-journal-notes" className={activeTab === "notes" ? "selected" : ""}
        onClick={() => onTabChange("notes")}>Мои заметки</button>
    </div>

    {activeTab === "chronicle" && <div id="prod-journal-chronicle" role="tabpanel" aria-labelledby="prod-journal-chronicle-tab">
      {player.canEdit && newestNewEvent && <button className="prod-secondary prod-journal-seen" type="button" disabled={busy}
        onClick={() => onMarkSeen(newestNewEvent.id)}>Отметить новое просмотренным</button>}
      {loading === "first" && events.length === 0 && <p className="prod-empty" role="status">Загружаем хронику…</p>}
      {loadError && <div className="prod-journal-error" role="alert"><p>{loadError}</p><button className="prod-secondary" type="button" onClick={retry}>Повторить</button></div>}
      {headError && <div className="prod-journal-error" role="status"><p>{headError}</p><button className="prod-secondary" type="button" onClick={() => void refreshHead()}>Повторить</button></div>}
      {!loading && !loadError && safeEvents.length === 0 && <p className="prod-empty">Пока нет событий.</p>}
      {selected && selectedPresentation ? <article className="prod-journal-detail" aria-labelledby="prod-journal-detail-title">
        <button className="prod-back" type="button" onClick={() => setSelectedId(null)}><ArrowLeft aria-hidden="true" />Хроника</button>
        <div className="prod-journal-detail-heading">
          <span className="prod-journal-detail-icon">{SelectedIcon && <SelectedIcon aria-hidden="true" />}</span>
          <div><h2 id="prod-journal-detail-title">{selectedPresentation.title}</h2><p>{selectedPresentation.secondary}</p></div>
        </div>
        <p className="prod-journal-detail-meta">
          <time dateTime={selected.createdAt}>{selectedGroup?.dateLabel}, {journalEventTime(selected.createdAt)}</time>
          <span>{selected.sessionName ?? "Вне сессии"}</span>
        </p>
        {selectedPresentation.destination?.kind === "knowledge" && <button className="prod-secondary prod-journal-knowledge-link" type="button"
          onClick={() => onOpenKnowledge(selectedPresentation.destination!.entryId)}>Открыть запись знания</button>}
      </article> : <>
        {safeEvents.length > 0 && <div className="prod-chronicle-groups" aria-label="Хроника персонажа">
          {groups.map((group) => <section className="prod-chronicle-group" key={group.key}>
            <header><h2>{group.dateLabel}</h2><span>{group.sessionName}</span></header>
            <ol className="prod-chronicle-events">
              {group.events.map((event) => {
                const presentation = journalActivityPresentation(event);
                const Icon = presentation.icon;
                return <li key={event.id}>
                  <button className="prod-chronicle-event" type="button" onClick={() => setSelectedId(event.id)}
                    aria-label={`${presentation.title}: ${presentation.secondary}`}>
                    <time dateTime={event.createdAt}>{journalEventTime(event.createdAt)}</time>
                    <span className="prod-chronicle-axis"><Icon aria-hidden="true" /></span>
                    <span className="prod-chronicle-copy"><strong>{presentation.title}</strong><small>{presentation.secondary}</small></span>
                    {newEventIds.has(event.id) && <span className="prod-chronicle-new">Новое</span>}
                    <ChevronRight className="prod-chronicle-chevron" aria-hidden="true" />
                  </button>
                </li>;
              })}
            </ol>
          </section>)}
        </div>}
        {nextCursor && !loadError && <button className="prod-secondary prod-journal-more" type="button" disabled={loading === "more"}
          onClick={() => void loadMore()}>{loading === "more" ? "Загружаем…" : "Показать более ранние события"}</button>}
        {loading === "more" && <span className="prod-visually-hidden" role="status">Загружаем более ранние события.</span>}
      </>}
    </div>}

    {activeTab === "notes" && <div id="prod-journal-notes" role="tabpanel" aria-labelledby="prod-journal-notes-tab">
      <PersonalNotesPage notes={player.notes} busy={busy} canEdit={player.canEdit} onSave={onSaveNote} />
    </div>}
  </section>;
}
