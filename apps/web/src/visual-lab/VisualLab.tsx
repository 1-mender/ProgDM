import { useState, type CSSProperties } from "react";
import { ArrowUpRight, Backpack, BookOpen, BriefcaseMedical, Check, ChevronRight, CircleDot, Compass, Crosshair, Diamond, FileText, Flashlight, FlaskConical, House, KeyRound, LayoutGrid, Mail, Monitor, NotebookPen, Plus, Shield, Smartphone, Sparkles, UserRound, Wrench, X } from "lucide-react";
import { bagCapacity, character, codexInventory, equipmentSlots, inventory, knowledge, navigation, notes, profile, updates, variants, refinedArchive, type LabView, type Variant } from "./model";
import portrait from "./assets/mira.png";
import "./visual-lab.css";
import "./field-archive.css";

const navigationIcons = [House, Backpack, BookOpen, NotebookPen, UserRound];
const itemIcons = [KeyRound, NotebookPen, Compass];
const codexItemIcons = { key: KeyRound, book: BookOpen, amulet: Diamond, flask: FlaskConical, letter: Mail, medical: BriefcaseMedical, compass: Compass, flashlight: Flashlight };
const equipmentIcons = { primary: Crosshair, secondary: CircleDot, protection: Shield, accessory: Diamond, tool: Wrench, special: Sparkles };
type ItemDetail = { name: string; description: string; quantity: number; slots: number; equipSlot?: string; equipped?: boolean; empty?: boolean };

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
  const [journalTab, setJournalTab] = useState<"chronicle" | "notes">("chronicle");
  const [editingProfile, setEditingProfile] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [personalNotes, setPersonalNotes] = useState([...notes]);
  const [profileDraft, setProfileDraft] = useState<{ description: string; goal: string }>({ ...profile });
  const [selectedItem, setSelectedItem] = useState<ItemDetail | null>(null);
  const [equipNotice, setEquipNotice] = useState("");
  const style = {
    "--vl-bg": variant.background, "--vl-surface": variant.surface, "--vl-text": variant.text,
    "--vl-accent": variant.accent, "--vl-border": variant.border, "--vl-muted": variant.muted,
    "--vl-heading": variant.heading, "--vl-body": variant.body,
  } as CSSProperties;
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
    {view === "Инвентарь" && <CodexInventory onSelect={item => { setSelectedItem(item); setEquipNotice(""); }} onSelectSlot={slot => { setSelectedItem({ name: slot.item ?? slot.name, description: slot.description, quantity: 1, slots: 1, equipped: Boolean(slot.item), empty: !slot.item }); setEquipNotice(""); }} />}
    {view === "Знания" && <section><div className="vl-heading"><h2>Знания</h2><span className="vl-counter">{knowledge.length}</span></div>{knowledge.map(entry => <details className="vl-item vl-codex-entry" key={entry.id}><summary><strong>{entry.name}<small>{entry.category}</small></strong><ChevronRight size={18} /></summary><p>{entry.detail}</p></details>)}</section>}
    {view === "Журнал" && <section className="vl-journal"><div className="vl-heading"><h2>Журнал</h2></div><div className="vl-journal-tabs" role="tablist" aria-label="Журнал"><button role="tab" aria-selected={journalTab === "chronicle"} onClick={() => { setJournalTab("chronicle"); setShowNoteForm(false); }}>Хроника</button><button role="tab" aria-selected={journalTab === "notes"} onClick={() => setJournalTab("notes")}>Мои заметки</button></div>
      {journalTab === "chronicle" ? <section className="vl-chronicle"><h3>18 сентября</h3>{updates.map(update => <details key={update.id} className="vl-item vl-codex-entry"><summary><strong>{update.text}<small>{update.detail}</small></strong><ChevronRight size={18} /></summary><p>{update.detail}</p></details>)}</section> : <section className="vl-personal-notes">{personalNotes.map(note => <details className="vl-item vl-codex-entry" key={note.id}><summary><strong>{note.title}<small>{note.detail}</small></strong><ChevronRight size={18} /></summary><p>{note.detail}</p></details>)}
        {showNoteForm ? <form onSubmit={event => { event.preventDefault(); if (noteDraft.trim()) { setPersonalNotes(current => [...current, { id: `note-${current.length}`, title: noteDraft.trim(), detail: noteDraft.trim() }]); setNoteDraft(""); setShowNoteForm(false); } }}><label htmlFor="vl-note-draft">Новая заметка</label><textarea id="vl-note-draft" value={noteDraft} onChange={event => setNoteDraft(event.target.value)} placeholder="Текст заметки" /><button type="submit">Сохранить заметку</button></form> : <button className="vl-new-note" onClick={() => setShowNoteForm(true)}><Plus size={18} />Новая заметка</button>}
      </section>}</section>}
    {view === "Профиль" && <section className="vl-codex-profile">{hero}{editingProfile ? <form onSubmit={event => { event.preventDefault(); setEditingProfile(false); }}><label>Архетип<input value={character.archetype} readOnly /></label><label>Происхождение<input value={character.origin} readOnly /></label><label>Описание<textarea value={profileDraft.description} onChange={event => setProfileDraft(current => ({ ...current, description: event.target.value }))} /></label><label>Личная цель<textarea value={profileDraft.goal} onChange={event => setProfileDraft(current => ({ ...current, goal: event.target.value }))} /></label><button type="submit">Готово</button></form> : <><dl className="vl-profile-fields"><div><dt>Архетип</dt><dd>{character.archetype}</dd></div><div><dt>Происхождение</dt><dd>{character.origin}</dd></div><div><dt>Описание</dt><dd>{profileDraft.description}</dd></div><div><dt>Личная цель</dt><dd>{profileDraft.goal}</dd></div></dl><button className="vl-profile-edit" onClick={() => setEditingProfile(true)}>Редактировать</button></>}</section>}
    <footer className="vl-record-footer"><span className="vl-meta">Кампания: Северный путь</span></footer>
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
    {archive ? <section className="vl-player-content" aria-label={view}><div className="vl-player-scroll">{codexSection}</div></section> : <main className="vl-player-content">{legacy}</main>}
    <nav className="vl-player-nav" aria-label="Разделы игрока">{navigation.map((label,index)=>{const Icon=navigationIcons[index]!;return <button key={label} aria-current={view===label?"page":undefined} onClick={()=>onView(label)}><Icon size={19}/><span>{label}</span></button>;})}</nav>
    {archive && view === "Инвентарь" && selectedItem && <ItemDetailPanel item={selectedItem} equipNotice={equipNotice} onEquip={() => setEquipNotice(`Выбрано для экипировки: ${selectedItem.equipSlot}`)} onClose={() => setSelectedItem(null)} />}
  </div>;
}

function CodexInventory({ onSelect, onSelectSlot }: { onSelect: (item: ItemDetail) => void; onSelectSlot: (slot: typeof equipmentSlots[number]) => void }) {
  const occupied = codexInventory.reduce((total, item) => total + item.slots, 0);
  return <div className="vl-codex-inventory">
    <div className="vl-heading vl-inventory-title"><h2>Инвентарь</h2><span className="vl-capacity">{occupied} / {bagCapacity}</span></div>
    <section className="vl-equipped"><div className="vl-heading"><h3>Экипировано</h3></div><div className="vl-equipped-grid">{equipmentSlots.map(slot => { const Icon = equipmentIcons[slot.icon as keyof typeof equipmentIcons]; return <button className={`vl-equipment-slot${slot.item ? " is-equipped" : " is-empty"}`} key={slot.id} onClick={() => onSelectSlot(slot)} aria-label={`${slot.name}: ${slot.item ?? "пусто"}`}>
      <span className="vl-equipment-icon"><Icon size={19} /></span><span className="vl-equipment-copy"><small>{slot.name}</small><strong>{slot.item ?? "Пусто"}</strong></span><ChevronRight size={16} />
    </button>; })}</div></section>
    <section className="vl-bag"><div className="vl-heading"><h3>Сумка</h3><span className="vl-capacity">{occupied} / {bagCapacity}</span></div><div className="vl-bag-grid" aria-label={`Сумка: ${occupied} из ${bagCapacity} ячеек занято`}>
      {codexInventory.map(item => { const Icon = codexItemIcons[item.icon as keyof typeof codexItemIcons]; return <button className="vl-bag-cell is-filled" key={item.id} onClick={() => onSelect(item)} aria-label={`${item.name}, количество ${item.quantity}`}>
        <Icon size={21} /><strong>{item.name}</strong><span>×{item.quantity}</span>
      </button>; })}
      {Array.from({ length: Math.max(0, bagCapacity - occupied) }, (_, index) => <div className="vl-bag-cell is-empty" key={`empty-${index}`} aria-label="Пустая ячейка"><span aria-hidden="true">Пусто</span></div>)}
    </div></section>
  </div>;
}

function ItemDetailPanel({ item, equipNotice, onEquip, onClose }: { item: ItemDetail; equipNotice: string; onEquip: () => void; onClose: () => void }) {
  const Icon = item.empty ? CircleDot : codexItemIcons[(codexInventory.find(entry => entry.name === item.name)?.icon ?? "key") as keyof typeof codexItemIcons];
  return <div className="vl-item-detail-overlay"><button className="vl-item-detail-backdrop" onClick={onClose} aria-label="Закрыть сведения о предмете" />
    <section className="vl-item-detail" role="dialog" aria-modal="true" aria-labelledby="vl-item-detail-title">
      <div className="vl-detail-heading"><div><span className="vl-detail-icon"><Icon size={25} /></span><div><h3 id="vl-item-detail-title">{item.name}</h3>{item.equipped && <span className="vl-detail-state">Экипировано</span>}</div></div><button className="vl-detail-close" onClick={onClose} aria-label="Закрыть" title="Закрыть"><X size={20} /></button></div>
      <p className="vl-detail-description">{item.description}</p>
      <dl className="vl-detail-facts">{!item.empty && <><div><dt>Количество</dt><dd>×{item.quantity}</dd></div><div><dt>Занимает</dt><dd>{item.slots} {item.slots === 1 ? "слот" : "слота"}</dd></div></>}</dl>
      {item.equipSlot && !item.equipped && <button className="vl-detail-equip" onClick={onEquip}><Check size={18} />Экипировать</button>}
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
