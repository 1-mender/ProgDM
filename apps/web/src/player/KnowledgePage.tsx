import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Lightbulb, MapPin, Package, PawPrint, Search, UserRound, X, type LucideIcon } from "lucide-react";
import type { KnowledgeCategory, PlayerState } from "@progdm/shared";
import { KNOWLEDGE_CATEGORY_LABELS, knowledgeCountLabel } from "./model";

const categoryOrder: KnowledgeCategory[] = ["character", "place", "creature", "item", "event", "fact"];
const categoryIcons: Record<KnowledgeCategory, LucideIcon> = {
  character: UserRound,
  place: MapPin,
  creature: PawPrint,
  item: Package,
  event: CalendarDays,
  fact: Lightbulb
};

export function KnowledgePage({ player }: { player: PlayerState }) {
  const [category, setCategory] = useState<KnowledgeCategory | "all">("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = player.knowledge.find((entry) => entry.id === selectedId);
  const categories = categoryOrder;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru");
    return player.knowledge.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      const searchable = [entry.title, KNOWLEDGE_CATEGORY_LABELS[entry.category],
        ...(entry.summaryVisible && entry.summary !== null ? [entry.summary] : []),
        ...entry.facts.map((fact) => fact.body)].join(" ").toLocaleLowerCase("ru");
      return !normalized || searchable.includes(normalized);
    });
  }, [category, player.knowledge, query]);

  if (selected) return <article className="prod-page prod-knowledge-detail">
    <button className="prod-back" type="button" onClick={() => setSelectedId(null)}><ChevronLeft aria-hidden="true" />Знания</button>
    <header><h1>{selected.title}</h1><span className="prod-category-label">{KNOWLEDGE_CATEGORY_LABELS[selected.category]}</span></header>
    {selected.summaryVisible && selected.summary !== null && <section><h2>Кратко</h2><p>{selected.summary}</p></section>}
    {selected.facts.length > 0 && <section className="prod-knowledge-facts"><h2>Что известно</h2><ul>
      {selected.facts.map((fact) => <li key={fact.id}>
        <p>{fact.body}</p>
        <small><time dateTime={fact.revealedAt}>{fact.sessionName ? `Открыто: ${fact.sessionName}` : fact.sessionId ? "Открыто ранее" : "Открыто вне сессии"}</time></small>
      </li>)}
    </ul></section>}
  </article>;

  return <div className="prod-page prod-knowledge">
    <div className="prod-page-heading">
      <div><h1>Знания</h1><span className="prod-count">{knowledgeCountLabel(player.knowledge.length)}</span></div>
      <button className="prod-icon-button" type="button" aria-label={searchOpen ? "Закрыть поиск" : "Поиск по знаниям"} title={searchOpen ? "Закрыть поиск" : "Поиск по знаниям"} onClick={() => { setSearchOpen((open) => !open); setQuery(""); }}>
        {searchOpen ? <X aria-hidden="true" /> : <Search aria-hidden="true" />}
      </button>
    </div>
    {searchOpen && <label className="prod-search"><Search aria-hidden="true" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти запись" aria-label="Найти запись" /></label>}
    <div className="prod-categories" role="group" aria-label="Категории знаний">
      <button type="button" aria-pressed={category === "all"} className={category === "all" ? "is-selected" : ""} onClick={() => setCategory("all")}>Все</button>
      {categories.map((value) => <button type="button" key={value} aria-pressed={category === value} className={category === value ? "is-selected" : ""} onClick={() => setCategory(value)}>{KNOWLEDGE_CATEGORY_LABELS[value]}</button>)}
    </div>
    {filtered.length ? <ul className="prod-knowledge-list">{filtered.map((entry) => {
      const CategoryIcon = categoryIcons[entry.category];
      return <li key={entry.id}>
        <button type="button" onClick={() => setSelectedId(entry.id)}>
          <CategoryIcon aria-hidden="true" />
          <span><strong>{entry.title}</strong><small>{KNOWLEDGE_CATEGORY_LABELS[entry.category]}</small></span>
          <ChevronRight aria-hidden="true" />
        </button>
      </li>;
    })}</ul> : <p className="prod-empty">{player.knowledge.length ? "Записей не найдено." : "Пока нет открытых записей."}</p>}
  </div>;
}
