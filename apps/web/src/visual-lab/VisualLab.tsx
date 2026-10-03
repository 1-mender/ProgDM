import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ArrowUpRight, Backpack, BookOpen, BriefcaseMedical, CalendarDays, Check, ChevronLeft, ChevronRight, CircleDot, CircleHelp, Compass, Crosshair, Diamond, FileText, Flag, Flashlight, FlaskConical, House, KeyRound, LayoutGrid, Lightbulb, Link2, Mail, MapPin, Monitor, NotebookPen, Package, PawPrint, Pin, Plus, PocketKnife, Search, Shield, Shirt, Smartphone, Sparkles, UserRound, Wrench, X } from "lucide-react";
import { bagCapacity, canFitInBag, character, codexInventory, equipmentSlots, inventory, navigation, notes, profile, updates, variants, refinedArchive, type LabEquipmentSlot, type LabInventoryItem, type LabView, type Variant } from "./model";
import portrait from "./assets/mira.png";
import apothecaryPortrait from "./assets/apothecary.png";
import "./visual-lab.css";
import "./field-archive.css";

const navigationIcons = [House, Backpack, BookOpen, NotebookPen, UserRound];
const itemIcons = [KeyRound, NotebookPen, Compass];
const codexItemIcons = { key: KeyRound, book: BookOpen, amulet: Diamond, flask: FlaskConical, letter: Mail, medical: BriefcaseMedical, compass: Compass, flashlight: Flashlight, rope: Link2, knife: PocketKnife, jacket: Shirt, lockpicks: Wrench };
const equipmentIcons = { primary: Crosshair, secondary: CircleDot, protection: Shield, accessory: Diamond, tool: Wrench, special: Sparkles };
type ItemSelection = { item: LabInventoryItem; source: "bag" | "equipment"; slotId?: string };
type KnowledgeKind = "Персонажи" | "Места" | "Существа" | "Предметы" | "События" | "Факты";
type KnowledgeEntry = { id: string; name: string; kind: KnowledgeKind; type: string; summary: string; detail: string; session: string; isNew?: boolean; hasImage?: boolean };
const knowledgeCategories = ["Все", "Персонажи", "Места", "Существа", "Предметы", "События", "Факты"] as const;
const knowledgeIcons = { Персонажи: UserRound, Места: MapPin, Существа: PawPrint, Предметы: Package, События: CalendarDays, Факты: Lightbulb };
const b2Knowledge: readonly KnowledgeEntry[] = [
  { id: "apothecary", name: "Аптекарь", kind: "Персонажи", type: "Персонаж мира", summary: "Владелец аптеки в северной части города.", detail: "Персонаж видел его возле закрытого склада. По словам местных, он работает по ночам и редко оставляет лавку без присмотра.", session: "Сессия 3", hasImage: true },
  { id: "tunnels", name: "Северные туннели", kind: "Места", type: "Место", summary: "Старый подземный путь под северным трактом.", detail: "Входы отмечены каменными столбами. Внутри прохладно и тихо; часть проходов завалена.", session: "Сессия 2" },
  { id: "black-dog", name: "Чёрный пёс", kind: "Существа", type: "Существо", summary: "Крупный зверь, замеченный у заброшенной переправы.", detail: "Местные описывают его как бесшумного и осторожного. Следы обрываются у кромки леса.", session: "Сессия 3" },
  { id: "medallion", name: "Сломанный медальон", kind: "Предметы", type: "Предмет", summary: "Медный медальон с повреждённым креплением.", detail: "На обратной стороне сохранился фрагмент гравировки. Символ совпадает с отметкой на старой карте.", session: "Сессия 2" },
  { id: "caravan", name: "Исчезновение каравана", kind: "События", type: "Событие", summary: "Торговый караван не прибыл в город в назначенный день.", detail: "Последний раз караван видели на северном тракте. Причина исчезновения пока неизвестна.", session: "Сессия 3", isNew: true },
  { id: "symbol", name: "Странный символ", kind: "Факты", type: "Факт", summary: "Знак повторяется на каменных дверях и медальоне.", detail: "Персонаж видел этот знак в двух разных местах. Его значение пока не установлено.", session: "Сессия 1", isNew: true },
];
type NoteMarker = "Обычная" | "Важно" | "Проверить" | "Вопрос";
type JournalNote = { id: string; title: string; detail: string; marker: NoteMarker; pinned: boolean };
type ChronicleEvent = { id: string; kind: "item" | "knowledge" | "message" | "important" | "interactive"; title: string; linkedTitle: string; description: string; time: string; destination?: "Инвентарь" | "Знания" };
const chronicleGroups: { date: string; session: string; events: ChronicleEvent[] }[] = [
  { date: "18 сентября", session: "Сессия 3", events: [
    { id: "key", kind: "item", title: "Получен предмет", linkedTitle: "Старинный ключ", description: "Добавлен в инвентарь персонажа.", time: "19:40", destination: "Инвентарь" },
    { id: "apothecary", kind: "knowledge", title: "Открыто знание", linkedTitle: "Аптекарь", description: "Запись стала доступна в знаниях персонажа.", time: "18:15", destination: "Знания" },
    { id: "letter", kind: "message", title: "Получено письмо", linkedTitle: "Неизвестный отправитель", description: "Письмо сохранено среди вещей персонажа.", time: "17:50" },
    { id: "caravan", kind: "important", title: "Караван не прибыл", linkedTitle: "Северный тракт", description: "Торговцы не появились к назначенному часу.", time: "17:20" },
    { id: "safe", kind: "interactive", title: "Интерактив завершён", linkedTitle: "Сейф открыт", description: "Группа открыла сейф после решения кодовой загадки.", time: "16:45" },
  ] },
  { date: "17 сентября", session: "Сессия 2", events: [
    { id: "tunnels", kind: "knowledge", title: "Открыто знание", linkedTitle: "Северные туннели", description: "В журнале знаний появилась запись о подземном пути.", time: "20:10", destination: "Знания" },
    { id: "compass", kind: "item", title: "Получен предмет", linkedTitle: "Компас", description: "Компас передан персонажу после перехода через тракт.", time: "18:30", destination: "Инвентарь" },
  ] },
];
const journalEventIcons = { item: KeyRound, knowledge: BookOpen, message: Mail, important: Flag, interactive: Sparkles };
const noteMarkerIcons = { Обычная: CircleDot, Важно: Flag, Проверить: Check, Вопрос: CircleHelp };
const noteMarkers: NoteMarker[] = ["Обычная", "Важно", "Проверить", "Вопрос"];

function VisualTokens({ variant }: { variant: Variant }) {
  return <details className="vl-tokens" open>
    <summary>Визуальные токены</summary>
    <dl>
      {([['Фон', variant.background], ['Поверхность', variant.surface], ['Текст', variant.text], ['Акцент', variant.accent], ['Граница', variant.border]] as const).map(([label, color]) =>
        <div key={label}><dt><i style={{ background: color }} />{label}</dt><dd>{color}</dd></div>)}
      <div><dt>Заголовки</dt><dd>{variant.heading}</dd></div>
      <div><dt>Основной текст</dt><dd>{variant.body}</dd></div>
    </dl>
  </details>;
}

function PlayerPreview({ variant, view, onView, refined = false }: { variant: Variant; view: LabView; onView: (view: LabView) => void; refined?: boolean }) {
  const archive = variant.id === "b" && refined;
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileDraft, setProfileDraft] = useState<{ description: string; goal: string }>({ ...profile });
  const [bagItems, setBagItems] = useState<LabInventoryItem[]>([...codexInventory]);
  const [equippedItems, setEquippedItems] = useState<LabEquipmentSlot[]>(equipmentSlots.map(slot => ({ ...slot })));
  const [selectedItem, setSelectedItem] = useState<ItemSelection | null>(null);
  const [itemNotice, setItemNotice] = useState("");
  const style = {
    "--vl-bg": variant.background, "--vl-surface": variant.surface, "--vl-text": variant.text,
    "--vl-accent": variant.accent, "--vl-border": variant.border, "--vl-muted": variant.muted,
    "--vl-heading": variant.heading, "--vl-body": variant.body,
  } as CSSProperties;
  const bagSlotsUsed = bagItems.reduce((total, item) => total + item.slots, 0);
  const detailOpen = archive && view === "Инвентарь" && selectedItem !== null;
  const equipSelectedItem = () => {
    if (!selectedItem || selectedItem.source !== "bag" || !selectedItem.item.equipSlot) return;
    const slotIndex = equippedItems.findIndex(slot => slot.name === selectedItem.item.equipSlot);
    if (slotIndex < 0) return;
    const replaced = equippedItems[slotIndex]!.item;
    if (replaced && !canFitInBag(bagSlotsUsed - selectedItem.item.slots, replaced.slots)) {
      setItemNotice("В сумке нет места для заменяемого предмета.");
      return;
    }
    setBagItems(current => [...current.filter(item => item.id !== selectedItem.item.id), ...(replaced ? [replaced] : [])]);
    setEquippedItems(current => current.map((slot, index) => index === slotIndex ? { ...slot, item: selectedItem.item } : slot));
    setSelectedItem({ item: selectedItem.item, source: "equipment", slotId: equippedItems[slotIndex]!.id });
    setItemNotice(`Экипировано: ${selectedItem.item.equipSlot}.`);
  };
  const unequipSelectedItem = () => {
    if (!selectedItem || selectedItem.source !== "equipment" || !selectedItem.slotId) return;
    if (!canFitInBag(bagSlotsUsed, selectedItem.item.slots)) {
      setItemNotice("Сумка заполнена. Освободите место перед снятием предмета.");
      return;
    }
    setEquippedItems(current => current.map(slot => slot.id === selectedItem.slotId ? { ...slot, item: null } : slot));
    setBagItems(current => [...current, selectedItem.item]);
    setSelectedItem({ item: selectedItem.item, source: "bag" });
    setItemNotice("Предмет перемещён в сумку.");
  };
  const performItemAction = () => {
    if (selectedItem?.item.action === "Открыть") setItemNotice("Письмо открыто в прототипе.");
  };
  const hero = <section className="vl-identity" aria-label="Персонаж">
    <figure><img src={portrait} alt="Портрет Mira Voss" /></figure>
    <div className="vl-identity-text"><h1>{character.name}</h1><p>{character.archetype}</p><div className="vl-origin"><span>Происхождение</span><strong>{character.origin}</strong></div></div>
  </section>;
  const codexSection = <>
    {view === "Главная" && <>
      {hero}
      <section className="vl-updates"><div className="vl-heading"><h2>Новое</h2><span className="vl-counter">{updates.length}</span></div>
        {updates.slice(0, 3).map(update => <details key={update.id} className="vl-update"><summary><span>{update.text}</span><ChevronRight size={18} /></summary><p>{update.detail}</p></details>)}
        <button className="vl-journal-link" onClick={() => onView("Журнал")}>Весь журнал<ArrowUpRight size={18} /></button>
      </section>
    </>}
    {view === "Инвентарь" && <CodexInventory bagItems={bagItems} equippedItems={equippedItems} bagSlotsUsed={bagSlotsUsed} onSelect={(item, source, slotId) => { setSelectedItem({ item, source, slotId }); setItemNotice(""); }} />}
    {view === "Знания" && <CodexKnowledge />}
    {view === "Журнал" && <CodexJournal onView={onView} />}
    {view === "Профиль" && <section className="vl-codex-profile">{hero}{editingProfile ? <form onSubmit={event => { event.preventDefault(); setEditingProfile(false); }}><label>Архетип<input value={character.archetype} readOnly /></label><label>Происхождение<input value={character.origin} readOnly /></label><label>Описание<textarea value={profileDraft.description} onChange={event => setProfileDraft(current => ({ ...current, description: event.target.value }))} /></label><label>Личная цель<textarea value={profileDraft.goal} onChange={event => setProfileDraft(current => ({ ...current, goal: event.target.value }))} /></label><button type="submit">Готово</button></form> : <><dl className="vl-profile-fields"><div><dt>Архетип</dt><dd>{character.archetype}</dd></div><div><dt>Происхождение</dt><dd>{character.origin}</dd></div><div><dt>Описание</dt><dd>{profileDraft.description}</dd></div><div><dt>Личная цель</dt><dd>{profileDraft.goal}</dd></div></dl><button className="vl-profile-edit" onClick={() => setEditingProfile(true)}>Редактировать</button></>}</section>}
    {view !== "Знания" && view !== "Журнал" && <footer className="vl-record-footer"><span className="vl-meta">Кампания: Северный путь</span></footer>}
  </>;
  const legacy = <>
    <div className="vl-page-caption"><span className="vl-meta">ЛИЧНОЕ ДЕЛО / 014</span><span className="vl-stamp">СЕВЕР</span></div>
    <section className="vl-identity" aria-label="Персонаж"><figure><img src={portrait} alt="Портрет Mira Voss" /><figcaption>014 / MV</figcaption></figure><div className="vl-identity-text"><span className="vl-meta">ПЕРСОНАЖ</span><h1>{character.name}</h1><p>{character.archetype}</p><div className="vl-origin"><span>Происхождение</span><strong>{character.origin}</strong></div></div></section>
    <div className="vl-section-body">
      {view === "Главная" && <><section className="vl-updates"><div className="vl-heading"><h2><Sparkles size={16} />Новое</h2><span className="vl-counter">03</span></div><div className="vl-update-list">{updates.map((update,index)=>{const Icon=update.kind==="item"?KeyRound:update.kind==="knowledge"?BookOpen:Mail;return <details key={update.id} className="vl-update"><summary><span className="vl-marker"><Icon size={18}/></span><span>{update.text}</span><ChevronRight size={15}/></summary><p>{update.detail}</p><span className="vl-update-number">0{index+1}</span></details>;})}</div><button className="vl-journal-link" onClick={()=>onView("Журнал")}>Посмотреть в журнале<ArrowUpRight size={15}/></button></section><InventoryList onView={onView}/></>}
      {view === "Инвентарь" && <InventoryList onView={onView}/>}
      {view === "Знания" && <section><div className="vl-heading"><h2>Знания</h2><span>01</span></div><details className="vl-item"><summary><BookOpen size={20}/><strong>Аптекарь</strong><ChevronRight size={16}/></summary><p>Известная запись персонажа.</p></details></section>}
      {view === "Журнал" && <section><div className="vl-heading"><h2>Журнал</h2></div>{updates.map(update=><details key={update.id} className="vl-item"><summary><FileText size={18}/><strong>{update.text}</strong><ChevronRight size={16}/></summary><p>{update.detail}</p></details>)}</section>}
      {view === "Профиль" && <section><div className="vl-heading"><h2>Профиль</h2><UserRound size={18}/></div><dl className="vl-profile-fields"><div><dt>Имя</dt><dd>{character.name}</dd></div><div><dt>Архетип</dt><dd>{character.archetype}</dd></div><div><dt>Происхождение</dt><dd>{character.origin}</dd></div></dl></section>}
    </div><footer className="vl-record-footer"><span className="vl-meta">КАМПАНИЯ / СЕВЕРНЫЙ ПУТЬ</span><span className="vl-annotation">Записи в пути</span></footer>
  </>;
  return <div className={`vl-player vl-${variant.id}${archive ? " vl-b-refined" : ""}`} style={style} aria-label={`Экран игрока: ${variant.name}`}>
    <header className="vl-player-header"><span><Compass size={18}/>ProgDM</span><span className="vl-meta">{archive ? "Сессия 01" : <>СЕССИЯ 01 <i/> В ИГРЕ</>}</span></header>
    {archive ? <section className="vl-player-content" aria-label={view} inert={detailOpen || undefined}><div className="vl-player-scroll">{codexSection}</div></section> : <main className="vl-player-content">{legacy}</main>}
    <nav className="vl-player-nav" aria-label="Разделы игрока" inert={detailOpen || undefined}>{navigation.map((label,index)=>{const Icon=navigationIcons[index]!;return <button key={label} aria-current={view===label?"page":undefined} onClick={()=>onView(label)}><Icon size={19}/><span>{label}</span></button>;})}</nav>
    {detailOpen && selectedItem && <ItemDetailPanel selection={selectedItem} equippedItems={equippedItems} bagSlotsUsed={bagSlotsUsed} equipNotice={itemNotice} onEquip={equipSelectedItem} onUnequip={unequipSelectedItem} onAction={performItemAction} onClose={() => setSelectedItem(null)} />}
  </div>;
}

function CodexInventory({ bagItems, equippedItems, bagSlotsUsed, onSelect }: { bagItems: LabInventoryItem[]; equippedItems: LabEquipmentSlot[]; bagSlotsUsed: number; onSelect: (item: LabInventoryItem, source: ItemSelection["source"], slotId?: string) => void }) {
  return <div className="vl-codex-inventory">
    <div className="vl-heading vl-inventory-title"><h2>Инвентарь</h2></div>
    <section className="vl-equipped"><div className="vl-heading"><h3>Экипировано</h3></div><div className="vl-equipped-grid">{equippedItems.map(slot => { const SlotIcon = equipmentIcons[slot.icon]; const ItemIcon = slot.item && codexItemIcons[slot.item.icon]; return slot.item ? <button className={`vl-equipment-slot is-equipped vl-rarity-${slot.item.rarityKey}`} key={slot.id} onClick={() => onSelect(slot.item!, "equipment", slot.id)} aria-label={`${slot.name}: ${slot.item.name}`}>
      <span className={`vl-equipment-icon vl-rarity-${slot.item.rarityKey}`}>{ItemIcon && <ItemIcon size={22} />}</span><span className="vl-equipment-copy"><small>{slot.name}</small><strong>{slot.item.name}</strong></span><ChevronRight size={16} />
    </button> : <div className="vl-equipment-slot is-empty" key={slot.id} aria-label={`${slot.name}: пусто`}>
      <span className="vl-equipment-icon"><SlotIcon size={19} /></span><span className="vl-equipment-copy"><small>{slot.name}</small><strong>Пусто</strong></span>
    </div>; })}</div></section>
    <section className="vl-bag"><div className="vl-heading"><h3>Сумка</h3><span className="vl-capacity">{bagSlotsUsed} / {bagCapacity}</span></div><div className="vl-bag-grid" aria-label={`Сумка: занято ${bagSlotsUsed} из ${bagCapacity} слотов`}>
      {bagItems.map(item => { const Icon = codexItemIcons[item.icon]; return <button className={`vl-bag-cell is-filled vl-rarity-${item.rarityKey}${item.status ? " has-status" : ""}`} key={item.id} onClick={() => onSelect(item, "bag")} aria-label={`${item.name}, ${item.category}, ${item.rarity}${item.status ? `, ${item.status}` : ""}${item.quantity > 1 ? `, количество ${item.quantity}` : ""}`}>
        <span className="vl-item-card-art"><Icon size={27} /></span><strong>{item.name}</strong><span className="vl-item-category">{item.category}</span><span className="vl-item-card-meta">{item.status && <span className="vl-item-status"><i aria-hidden="true" />{item.status}</span>}{item.quantity > 1 && <span className="vl-item-quantity">×{item.quantity}</span>}</span>
      </button>; })}
      {Array.from({ length: Math.max(0, bagCapacity - bagSlotsUsed) }, (_, index) => <div className="vl-bag-cell is-empty" key={`empty-${index}`} aria-label="Пустой слот"><span aria-hidden="true">Пусто</span></div>)}
    </div></section>
  </div>;
}

function CodexJournal({ onView }: { onView: (view: LabView) => void }) {
  const [journalTab, setJournalTab] = useState<"chronicle" | "notes">("chronicle");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [personalNotes, setPersonalNotes] = useState<JournalNote[]>([
    { ...notes[0]!, marker: "Проверить", pinned: true },
    { ...notes[1]!, marker: "Вопрос", pinned: true },
    { id: "north-route", title: "Путь на север", detail: "Перед выходом проверить старую дорогу у каменных столбов.", marker: "Важно", pinned: false },
    { id: "dust", title: "Пыль на рукаве", detail: "У входа в северные туннели была свежая пыль.", marker: "Обычная", pinned: false },
  ]);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState({ title: "", marker: "Обычная" as NoteMarker, detail: "", pinned: false });
  const selectedEvent = chronicleGroups.flatMap(group => group.events).find(event => event.id === selectedEventId);
  const pinnedNotes = personalNotes.filter(note => note.pinned);
  const unpinnedNotes = personalNotes.filter(note => !note.pinned);
  const currentNoteIsPinned = Boolean(personalNotes.find(note => note.id === editingNoteId)?.pinned);
  const pinnedLimitReached = noteDraft.pinned && pinnedNotes.length >= 3 && !currentNoteIsPinned;
  const pinToggleDisabled = !noteDraft.pinned && pinnedNotes.length >= 3 && !currentNoteIsPinned;

  const beginNewNote = () => {
    setEditingNoteId(null);
    setNoteDraft({ title: "", marker: "Обычная", detail: "", pinned: false });
    setEditorOpen(true);
  };
  const editNote = (note: JournalNote) => {
    setEditingNoteId(note.id);
    setNoteDraft({ title: note.title, marker: note.marker, detail: note.detail, pinned: note.pinned });
    setEditorOpen(true);
  };
  const closeNoteEditor = () => {
    setEditingNoteId(null);
    setEditorOpen(false);
  };
  const saveNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = noteDraft.title.trim();
    const detail = noteDraft.detail.trim();
    if (!title || !detail || (noteDraft.pinned && !personalNotes.find(note => note.id === editingNoteId)?.pinned && pinnedNotes.length >= 3)) return;
    if (editingNoteId) {
      setPersonalNotes(current => current.map(note => note.id === editingNoteId ? { ...note, ...noteDraft, title, detail } : note));
    } else {
      setPersonalNotes(current => [...current, { ...noteDraft, id: `note-${current.length + 1}`, title, detail }]);
    }
    closeNoteEditor();
  };

  const noteRows = (entries: JournalNote[]) => entries.map(note => {
    const MarkerIcon = noteMarkerIcons[note.marker];
    return <button className="vl-note-row" key={note.id} onClick={() => editNote(note)}>
      <span className="vl-note-copy"><strong>{note.title}</strong><small>{note.detail}</small>{note.marker !== "Обычная" && <span className={`vl-note-marker vl-note-marker--${note.marker.toLocaleLowerCase("ru")}`}><MarkerIcon size={14} />{note.marker}</span>}</span>
      {note.pinned && <span className="vl-note-pin" aria-label="Закреплено" title="Закреплено"><Pin size={16} aria-hidden="true" /></span>}
      <ChevronRight className="vl-note-chevron" size={18} aria-hidden="true" />
    </button>;
  });

  return <section className="vl-journal">
    <div className="vl-heading"><h2>Журнал</h2></div>
    <div className="vl-journal-tabs" role="tablist" aria-label="Журнал">
      <button role="tab" aria-selected={journalTab === "chronicle"} onClick={() => { setJournalTab("chronicle"); setEditorOpen(false); setEditingNoteId(null); }}>Хроника</button>
      <button role="tab" aria-selected={journalTab === "notes"} onClick={() => { setJournalTab("notes"); setSelectedEventId(null); }}>Мои заметки</button>
    </div>
    {journalTab === "chronicle" && <section className="vl-chronicle" aria-label="Хроника персонажа">
      {selectedEvent ? <article className="vl-event-detail">
        <button className="vl-journal-back" onClick={() => setSelectedEventId(null)}><ChevronLeft size={18} />Хроника</button>
        <div className="vl-event-detail-heading"><span className="vl-event-icon"><IconForJournalEvent kind={selectedEvent.kind} /></span><div><h3>{selectedEvent.title}</h3><strong>{selectedEvent.linkedTitle}</strong></div></div>
        <p className="vl-event-metadata">{chronicleGroups.find(group => group.events.some(event => event.id === selectedEvent.id))?.date} · {chronicleGroups.find(group => group.events.some(event => event.id === selectedEvent.id))?.session} · {selectedEvent.time}</p>
        <p className="vl-event-description">{selectedEvent.description}</p>
        {selectedEvent.destination && <button className="vl-event-open" onClick={() => onView(selectedEvent.destination!)}><ArrowUpRight size={17} />Открыть {selectedEvent.destination === "Знания" ? "запись знания" : "предмет"}</button>}
      </article> : chronicleGroups.map(group => <section className="vl-chronicle-group" key={group.session}>
        <header><h3>{group.date}</h3><span>{group.session}</span></header>
        <div className="vl-chronicle-events">{group.events.map(event => <button className="vl-chronicle-event" key={event.id} onClick={() => setSelectedEventId(event.id)}>
          <time>{event.time}</time>
          <span className="vl-chronicle-axis"><span><IconForJournalEvent kind={event.kind} /></span></span>
          <span className="vl-event-copy"><strong>{event.title}</strong><small>{event.linkedTitle}</small></span>
          {event.destination && <ChevronRight className="vl-chronicle-chevron" size={17} aria-hidden="true" />}
        </button>)}</div>
      </section>)}
    </section>}
    {journalTab === "notes" && <section className="vl-personal-notes" aria-label="Личные заметки">
      {editorOpen ? <form className="vl-note-editor" onSubmit={saveNote}>
        <div className="vl-note-editor-heading"><h3>{editingNoteId ? noteDraft.title || "Заметка" : "Новая заметка"}</h3><button type="button" onClick={closeNoteEditor} aria-label="Закрыть редактор"><X size={18} /></button></div>
        <label>Название<input autoFocus value={noteDraft.title} onChange={event => setNoteDraft(current => ({ ...current, title: event.target.value }))} placeholder="Короткое название" /></label>
        <label>Тип заметки<select value={noteDraft.marker} onChange={event => setNoteDraft(current => ({ ...current, marker: event.target.value as NoteMarker }))}>{noteMarkers.map(marker => <option key={marker}>{marker}</option>)}</select></label>
        <label>Текст<textarea value={noteDraft.detail} onChange={event => setNoteDraft(current => ({ ...current, detail: event.target.value }))} placeholder="Личная запись" /></label>
        <label className="vl-note-pin-toggle"><input type="checkbox" checked={noteDraft.pinned} disabled={pinToggleDisabled} onChange={event => setNoteDraft(current => ({ ...current, pinned: event.target.checked }))} /><Pin size={16} />Закрепить</label>
        {pinnedLimitReached && <p className="vl-note-limit">Можно закрепить не более трёх заметок.</p>}
        <div className="vl-note-editor-actions"><button type="button" onClick={closeNoteEditor}>Отмена</button><button type="submit" disabled={!noteDraft.title.trim() || !noteDraft.detail.trim() || pinnedLimitReached}>Сохранить</button></div>
      </form> : <>
        {pinnedNotes.length > 0 && <section className="vl-note-group"><h3><Pin size={15} />Закреплено</h3>{noteRows(pinnedNotes)}</section>}
        <section className="vl-note-group"><h3>Все заметки</h3>{noteRows(unpinnedNotes)}</section>
        <button className="vl-new-note" onClick={beginNewNote}><Plus size={18} />Новая заметка</button>
      </>}
    </section>}
  </section>;
}

function IconForJournalEvent({ kind }: { kind: ChronicleEvent["kind"] }) {
  const Icon = journalEventIcons[kind];
  return <Icon size={18} strokeWidth={1.65} />;
}

function CodexKnowledge() {
  const [category, setCategory] = useState<(typeof knowledgeCategories)[number]>("Все");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedEntry = b2Knowledge.find(entry => entry.id === selectedId);
  const filteredEntries = b2Knowledge.filter(entry => {
    const matchesCategory = category === "Все" || entry.kind === category;
    const search = query.trim().toLocaleLowerCase("ru");
    const matchesQuery = !search || `${entry.name} ${entry.kind} ${entry.type}`.toLocaleLowerCase("ru").includes(search);
    return matchesCategory && matchesQuery;
  });

  useEffect(() => {
    rootRef.current?.closest(".vl-player-scroll")?.scrollTo({ top: 0 });
  }, [category, query, selectedId]);

  if (selectedEntry) {
    const Icon = knowledgeIcons[selectedEntry.kind];
    return <div className="vl-knowledge-screen" ref={rootRef}>
      <section className="vl-knowledge-detail">
        <button className="vl-knowledge-back" onClick={() => setSelectedId(null)}><ChevronLeft size={19} />Знания</button>
        <header className="vl-knowledge-detail-title"><h2>{selectedEntry.name}</h2><span>{selectedEntry.type}</span></header>
        {selectedEntry.hasImage && <div className="vl-knowledge-art vl-knowledge-art--portrait"><img src={apothecaryPortrait} alt="Аптекарь в своей лавке" /></div>}
        <section><h3>Кратко</h3><p>{selectedEntry.summary}</p></section>
        <section><h3>Что известно</h3><p>{selectedEntry.detail}</p></section>
        <div className="vl-knowledge-opened"><span>Открыто</span><strong>{selectedEntry.session}</strong></div>
      </section>
    </div>;
  }

  return <div className="vl-knowledge-screen" ref={rootRef}>
    <section className="vl-knowledge-list-screen" aria-label="Справочник персонажа">
      <div className="vl-heading vl-knowledge-heading"><h2>Знания</h2><span className="vl-knowledge-count">{b2Knowledge.length} записей</span><button className="vl-knowledge-search-toggle" aria-label={searchOpen ? "Закрыть поиск" : "Поиск по знаниям"} title={searchOpen ? "Закрыть поиск" : "Поиск по знаниям"} onClick={() => { setSearchOpen(open => !open); setQuery(""); }}>{searchOpen ? <X size={18} /> : <Search size={18} />}</button></div>
      {searchOpen && <label className="vl-knowledge-search"><Search size={17} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти запись" aria-label="Найти запись" /></label>}
      <div className="vl-knowledge-categories" role="group" aria-label="Категории знаний" onWheel={event => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { event.currentTarget.scrollLeft += event.deltaY; event.preventDefault(); } }}>{knowledgeCategories.map(item => <button key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}</div>
      <div className="vl-knowledge-entries" aria-label="Записи справочника">
        {filteredEntries.map(entry => {
          const Icon = knowledgeIcons[entry.kind];
          const isNew = Boolean(entry.isNew && !readIds.includes(entry.id));
          return <button className="vl-knowledge-row" key={entry.id} onClick={() => { setReadIds(current => current.includes(entry.id) ? current : [...current, entry.id]); setSelectedId(entry.id); }} aria-label={`${entry.name}, ${entry.type}${isNew ? ", новое" : ""}`}>
            <span className="vl-knowledge-row-icon" aria-hidden="true"><Icon size={19} strokeWidth={1.6} /></span><span className="vl-knowledge-row-copy"><strong>{entry.name}</strong><small>{entry.type}</small></span>{isNew && <span className="vl-knowledge-new">Новое</span>}<ChevronRight className="vl-knowledge-row-chevron" size={18} aria-hidden="true" />
          </button>;
        })}
        {filteredEntries.length === 0 && <p className="vl-knowledge-empty">Записей не найдено.</p>}
      </div>
    </section>
  </div>;
}

function ItemDetailPanel({ selection, equippedItems, bagSlotsUsed, equipNotice, onEquip, onUnequip, onAction, onClose }: { selection: ItemSelection; equippedItems: LabEquipmentSlot[]; bagSlotsUsed: number; equipNotice: string; onEquip: () => void; onUnequip: () => void; onAction: () => void; onClose: () => void }) {
  const { item, source, slotId } = selection;
  const Icon = codexItemIcons[item.icon];
  const equipmentSlot = source === "equipment" ? equippedItems.find(slot => slot.id === slotId) : undefined;
  const canUnequip = canFitInBag(bagSlotsUsed, item.slots);
  const replaced = item.equipSlot ? equippedItems.find(slot => slot.name === item.equipSlot)?.item : null;
  const canEquip = source === "bag" && (!replaced || canFitInBag(bagSlotsUsed - item.slots, replaced.slots));
  return <div className="vl-item-detail-overlay"><button className="vl-item-detail-backdrop" onClick={onClose} aria-label="Закрыть сведения о предмете" />
    <section className="vl-item-detail" role="dialog" aria-modal="true" aria-labelledby="vl-item-detail-title">
      <div className="vl-detail-heading"><div><span className={`vl-detail-icon vl-rarity-${item.rarityKey}`}><Icon size={28} /></span><div><h3 id="vl-item-detail-title">{item.name}</h3><span className="vl-detail-category">{item.category}</span></div></div><button autoFocus className="vl-detail-close" onClick={onClose} aria-label="Закрыть" title="Закрыть"><X size={20} /></button></div>
      <div className="vl-detail-markers"><span className={`vl-rarity-label vl-rarity-${item.rarityKey}`}><i className="vl-rarity-mark" />Редкость: {item.rarity}</span>{item.status && <span className="vl-item-status vl-item-status-detail"><i aria-hidden="true" />Статус: {item.status}</span>}</div>
      <p className="vl-detail-description">{item.description}</p>
      <dl className="vl-detail-facts"><div><dt>Количество</dt><dd>×{item.quantity}</dd></div><div><dt>Занимает</dt><dd>{item.slots} {item.slots === 1 ? "слот" : "слота"}</dd></div>{source === "equipment" && equipmentSlot && <div><dt>Сейчас экипировано</dt><dd>{equipmentSlot.name}</dd></div>}</dl>
      {source === "equipment" && <button className="vl-detail-equip" onClick={onUnequip} disabled={!canUnequip}><Check size={18} />Снять</button>}
      {source === "bag" && item.equipSlot && <button className="vl-detail-equip" onClick={onEquip} disabled={!canEquip}><Check size={18} />{replaced ? `Заменить в слоте ${item.equipSlot}` : `Экипировать как ${item.equipSlot.toLowerCase()}`}</button>}
      {source === "bag" && item.action && <button className="vl-detail-equip" onClick={onAction}><ArrowUpRight size={18} />{item.action}</button>}
      {source === "equipment" && !canUnequip && <p className="vl-equip-notice" role="status">Сумка заполнена. Освободите место перед снятием предмета.</p>}
      {equipNotice && <p className="vl-equip-notice" role="status">{equipNotice}</p>}
    </section>
  </div>;
}

function InventoryList({ compact = false, onView, codex = false }: { compact?: boolean; onView: (view: LabView) => void; codex?: boolean }) {
  return <section className="vl-inventory"><div className="vl-heading"><h2>Инвентарь</h2>{compact ? <button onClick={() => onView("Инвентарь")} aria-label="Открыть инвентарь" title="Открыть инвентарь"><ArrowUpRight size={18} /></button> : <span className="vl-counter">{codex ? "3" : "03"}</span>}</div>
    {inventory.map((item, index) => { const Icon = itemIcons[index]!; return <details className="vl-item" key={item.id}><summary><span className="vl-item-icon"><Icon size={19} /></span><strong>{item.name}</strong><span className="vl-quantity">{codex ? "×1" : "01"}</span><ChevronRight size={15} /></summary><p>{item.detail}</p></details>; })}
  </section>;
}

export default function VisualLab() {
  const [selection, setSelection] = useState("all");
  const [preview, setPreview] = useState<"mobile" | "desktop">("mobile");
  const [view, setView] = useState<LabView>("Главная");
  const [refined, setRefined] = useState(true);
  const visibleVariants = variants.filter(variant => selection === "all" || variant.id === selection);
  return <div className="visual-lab">
    <header className="vl-toolbar">
      <div className="vl-lab-brand"><Compass size={24} /><div><strong>ProgDM</strong><span>Визуальная лаборатория</span></div></div>
      <div className="vl-controls">
        <div className="vl-segment" role="group" aria-label="Визуальный вариант">
          {variants.map(variant => <button key={variant.id} aria-pressed={selection === variant.id} onClick={() => setSelection(variant.id)} title={variant.name}>{variant.id.toUpperCase()}<span>{variant.name}</span></button>)}
          <button aria-pressed={selection === "all"} onClick={() => setSelection("all")} title="Сравнить все варианты"><LayoutGrid size={17} /><span>Сравнение</span></button>
        </div>
        <div className="vl-segment" role="group" aria-label="Размер экрана">
          <button aria-pressed={preview === "mobile"} onClick={() => setPreview("mobile")} title="Телефон"><Smartphone size={17} /><span>Телефон</span></button>
          <button aria-pressed={preview === "desktop"} onClick={() => setPreview("desktop")} title="Десктоп"><Monitor size={17} /><span>Десктоп</span></button>
        </div>
      </div>
    </header>
    <main className={`vl-stage vl-preview-${preview} ${selection === "all" ? "vl-comparison" : "vl-single"}`}>
      {visibleVariants.map(originalVariant => {
        const variant = originalVariant.id === "b" && refined ? refinedArchive : originalVariant;
        return <section className="vl-variant" key={variant.id} aria-label={`Вариант ${variant.id.toUpperCase()}: ${variant.name}`}>
        <header className="vl-variant-title"><span>{variant.id.toUpperCase()}</span><h2>{variant.name}</h2><span className="vl-size">{preview === "mobile" ? "390 px" : "Десктоп"}</span></header>
        <PlayerPreview variant={variant} view={view} onView={setView} refined={refined} />
        {variant.id === "b" && <div className="vl-archive-version vl-segment" role="group" aria-label="Версия Field Archive"><button aria-pressed={!refined} onClick={() => setRefined(false)}>B1 Исходный</button><button aria-pressed={refined} onClick={() => setRefined(true)}>B2 Доработанный</button></div>}
        <VisualTokens variant={variant} />
        {variant.id === "b" && refined && <section className="vl-codex-atmosphere" aria-label="Основа и атмосфера"><h3>Основа интерфейса</h3><p>Композиция · типографика · навигация</p><h3>Атмосфера кампании</h3><div>{[["Бордовый", "#783e3c"], ["Зелёный", "#3e6550"], ["Янтарный", "#805b26"], ["Синий", "#435e7d"], ["Фиолетовый", "#665079"], ["Терракотовый", "#8a4b30"]].map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div></section>}
      </section>; })}
    </main>
  </div>;
}
