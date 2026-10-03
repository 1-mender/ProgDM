import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/visual-lab/model.ts", import.meta.url), "utf8");
const visualSource = readFileSync(new URL("../src/visual-lab/VisualLab.tsx", import.meta.url), "utf8");
const visualCss = readFileSync(new URL("../src/visual-lab/field-archive.css", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { variants, refinedArchive, codexInventory, equipmentSlots, bagCapacity, canFitInBag } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

test("refined archive is a separate B palette; original comparison palettes stay unchanged", () => {
  assert.equal(refinedArchive.id, "b");
  assert.equal(refinedArchive.name, variants[1].name);
  assert.equal(refinedArchive.heading, "Georgia");
  assert.equal(refinedArchive.body, "Arial");
  assert.notEqual(refinedArchive, variants[1]);
  assert.deepEqual(variants.map(({ background, surface, accent }) => ({ background, surface, accent })), [
    { background: "#17191b", surface: "#202326", accent: "#c7ad77" },
    { background: "#292b2b", surface: "#efede5", accent: "#7c3936" },
    { background: "#141a18", surface: "#202824", accent: "#a5cfab" },
  ]);
});

test("refined archive paper retains readable primary, secondary and accent text", () => {
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const foreground of [refinedArchive.text, refinedArchive.muted, refinedArchive.accent]) {
    const levels = [luminance(foreground), luminance(refinedArchive.surface)].sort((a, b) => b - a);
    assert.ok((levels[0] + 0.05) / (levels[1] + 0.05) >= 4.5, `${foreground} contrast on paper`);
  }
});

test("B2 inventory starts with eight one-slot bag stacks and separate universal equipment", () => {
  assert.equal(bagCapacity, 12);
  assert.deepEqual(codexInventory.map(item => item.name), [
    "Старинный ключ", "Записная книжка", "Фляга", "Письмо", "Аптечка", "Компас", "Фонарик", "Верёвка",
  ]);
  assert.equal(codexInventory.reduce((total, item) => total + item.slots, 0), 8);
  assert.ok([...codexInventory, ...equipmentSlots.flatMap(slot => slot.item ? [slot.item] : [])].every(item => item.slots === 1));
  assert.equal(codexInventory.find(item => item.id === "medkit").quantity, 2);
  assert.equal(codexInventory.find(item => item.id === "medkit").slots, 1);
  assert.deepEqual(equipmentSlots.map(slot => slot.name), ["Основное", "Вторичное", "Защита", "Аксессуар", "Инструмент", "Особое"]);
  assert.equal(equipmentSlots.find(slot => slot.id === "accessory").item.name, "Амулет");
  assert.equal(equipmentSlots.find(slot => slot.id === "accessory").item.rarity, "Редкий");
  assert.ok(!codexInventory.some(item => item.id === "amulet"));
  assert.deepEqual(new Set(codexInventory.map(item => item.rarity)), new Set(["Обычный", "Необычный"]));
  assert.equal(codexInventory.find(item => item.id === "key").status, "Ключевой");
  assert.equal(codexInventory.find(item => item.id === "letter").status, "Сюжетный");
});

test("B2 inventory keeps capacity on the bag and moves mock items between bag and equipment", () => {
  assert.match(visualSource, /const bagSlotsUsed = bagItems\.reduce\(\(total, item\) => total \+ item\.slots, 0\)/);
  assert.match(visualSource, /setBagItems\(current => \[\.\.\.current\.filter\(item => item\.id !== selectedItem\.item\.id\), \.\.\.\(replaced \? \[replaced\] : \[\]\)\]\)/);
  assert.match(visualSource, /setBagItems\(current => \[\.\.\.current, selectedItem\.item\]\)/);
  assert.match(visualSource, /inert=\{detailOpen \|\| undefined\}/);
  assert.match(visualSource, /Снять/);
});

test("B2 inventory refuses to return equipped items when the bag has no free slots", () => {
  assert.equal(canFitInBag(11, 1), true);
  assert.equal(canFitInBag(12, 1), false);
  assert.equal(canFitInBag(10, 2), true);
  assert.equal(canFitInBag(11, 2), false);
});

test("B2 item detail supports mock transfer, stack merging and drop confirmation", () => {
  const itemFlow = visualSource.match(/function QuantityStepper[\s\S]*?\n}\n\nfunction InventoryList/)?.[0];
  assert.ok(itemFlow);
  assert.match(visualSource, /type ItemPanelMode = "detail" \| "transfer" \| "drop"/);
  assert.match(visualSource, /name: "Rowan", initials: "R", slotsUsed: 5, capacity: 12, stacks: \{ medkit: 1 \}/);
  assert.match(visualSource, /name: "Victor", initials: "V", slotsUsed: 12, capacity: 12, stacks: \{\}/);
  assert.match(visualSource, /name: "Elena", initials: "E", slotsUsed: 7, capacity: 12, stacks: \{\}/);
  assert.match(visualSource, /const merges = Boolean\(recipient\.stacks\[item\.id\]\)/);
  assert.match(visualSource, /canFitInBag\(recipient\.slotsUsed, item\.slots, recipient\.capacity\)/);
  assert.match(visualSource, /slotsUsed: entry\.slotsUsed \+ \(merges \? 0 : item\.slots\)/);
  assert.match(visualSource, /const updateBagQuantity = \(item: LabInventoryItem, quantityToRemove: number\)/);
  assert.match(visualSource, /const mockDropRestrictions: Record<string, string> = \{ key: "Этот предмет нельзя выбросить\." \}/);
  assert.match(visualSource, /setSelectedItem\(null\)/);
  assert.match(visualSource, /vl-inventory-toast" role="status"/);
  assert.match(itemFlow, /Передать предмет/);
  assert.match(itemFlow, /Сумка \{recipient\.slotsUsed\} \/ \{recipient\.capacity\}/);
  assert.match(itemFlow, /disabled=\{full\}/);
  assert.match(itemFlow, /Уже есть/);
  assert.match(itemFlow, /Предмет добавится к имеющейся стопке; новый слот не нужен\./);
  assert.match(itemFlow, /В будущем передача появится в хронике обеих сторон\./);
  assert.match(itemFlow, /Выбросить предмет\?/);
  assert.match(itemFlow, /Предмет исчезнет из инвентаря персонажа\./);
  assert.match(itemFlow, /item\.quantity > 1 && <QuantityStepper label="Сколько выбросить\?"/);
  assert.match(itemFlow, /disabled=\{source === "equipment" \|\| Boolean\(dropRestriction\)\}/);
  assert.match(itemFlow, /disabled=\{source === "equipment"\}/);
  assert.match(itemFlow, /Сначала снимите предмет\./);
  assert.match(itemFlow, /className="vl-item-detail-overlay"/);
  assert.match(visualCss, /\.vl-quantity-stepper button \{ width:44px; height:44px; min-height:44px/);
  assert.match(visualCss, /\.vl-detail-action--danger, \.vl-action-danger \{ border-color:#c6aaa4; color:#783e3c/);
  assert.match(visualCss, /\.vl-recipient-row\.is-disabled \{ cursor:not-allowed; opacity:\.58/);
  assert.doesNotMatch(itemFlow, /вес|килограмм|кг|\blb\b|encumbrance/i);
});

test("B2 applies the Relic surface and keeps rarity tint inside the item art", () => {
  const cardMarkup = visualSource.match(/bagItems\.map\(item => \{[\s\S]*?<\/button>; \}\)/)?.[0];
  assert.ok(cardMarkup);
  assert.match(cardMarkup, /vl-item-card-art/);
  assert.match(cardMarkup, /vl-item-category/);
  assert.match(cardMarkup, /vl-item-status/);
  assert.doesNotMatch(cardMarkup, /vl-rarity-label/);
  assert.match(cardMarkup, /item\.quantity > 1/);
  assert.match(visualCss, /button\.vl-bag-cell\.is-filled[\s\S]*?box-shadow: inset 0 0 0 2px #f4f0e5,inset 0 0 0 3px #e3ddce/);
  assert.match(visualCss, /\.vl-item-card-art::after[\s\S]*?background: var\(--vl-rarity-film,transparent\); mix-blend-mode: multiply/);
  assert.match(visualCss, /\.vl-rarity-common \{ --vl-rarity-film: linear-gradient\(145deg,rgba\(128,125,112,\.045\)/);
  assert.match(visualCss, /\.vl-rarity-uncommon \{ --vl-rarity-film: linear-gradient\(145deg,rgba\(110,132,91,\.17\)/);
  assert.match(visualCss, /\.vl-rarity-rare \{ --vl-rarity-film: linear-gradient\(145deg,rgba\(96,124,151,\.18\)/);
  assert.match(visualCss, /\.vl-rarity-unique \{ --vl-rarity-film: linear-gradient\(145deg,rgba\(132,108,145,\.18\)/);
  assert.doesNotMatch(visualCss, /\.vl-bag-cell\.vl-rarity-(?:uncommon|rare|unique)::(?:before|after)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-item-status[\s\S]*?clip-path:/);
  assert.match(visualSource, /Редкость: \{item\.rarity\}/);
  assert.match(visualSource, /vl-rarity-\$\{slot\.item\.rarityKey\}/);
  assert.match(visualCss, /\.vl-b-refined \.vl-equipment-slot \{[\s\S]*?box-shadow: inset 0 0 0 2px #f4f0e5,inset 0 0 0 3px #e3ddce/);
  assert.match(visualCss, /\.vl-detail-icon[\s\S]*?background: var\(--vl-rarity-film,linear-gradient\(transparent,transparent\)\),#e5dfd1/);
});

test("B2 uses one integrated card style without comparison lab blocks", () => {
  assert.doesNotMatch(visualSource, /ItemCardLab|LabItemCard|item-card-lab\.css|CODEX CARD|SPECIMEN \/ TAG/);
  assert.doesNotMatch(visualCss, /icl-card--(?:codex|relic|specimen)|icl-rarity-comparison/);
  assert.match(visualSource, /function CodexInventory/);
  assert.deepEqual(equipmentSlots.map(slot => slot.name), ["Основное", "Вторичное", "Защита", "Аксессуар", "Инструмент", "Особое"]);
  assert.match(visualCss, /grid-template-columns: repeat\(3,minmax\(0,1fr\)\); grid-auto-rows: 146px/);
  assert.match(visualSource, /Редкость: \{item\.rarity\}/);
  assert.match(source, /status: "Ключевой"/);
  assert.match(source, /status: "Сюжетный"/);
  assert.match(visualSource, /Занимает/);
  assert.match(visualSource, /Снять/);
});

test("B2 home is a compact actionable digest with shared pinned notes", () => {
  const homeMarkup = visualSource.match(/const codexSection = <>[\s\S]*?\n  <\/>;\n  const legacy/)?.[0];
  assert.ok(homeMarkup);
  assert.match(visualSource, /className="vl-identity vl-home-hero"[\s\S]*?navigateToView\("Профиль"\)/);
  assert.match(visualSource, /className="vl-home-archetype"/);
  assert.match(visualSource, /className="vl-home-origin">\{character\.origin\}/);
  assert.doesNotMatch(homeMarkup, /Происхождение|profile\.description|profile\.goal|InventoryList/);
  assert.match(visualSource, /updates\.filter\(update => !readHomeUpdateIds\.includes\(update\.id\)\)\.slice\(0, 3\)/);
  assert.match(homeMarkup, /Пока ничего нового\./);
  assert.match(homeMarkup, /className="vl-home-update"[\s\S]*?openHomeUpdate\(update\)/);
  assert.match(homeMarkup, /Открыть журнал/);
  assert.match(visualSource, /personalNotes\.filter\(note => note\.pinned\)\.slice\(0, 2\)/);
  assert.match(visualSource, /className="vl-home-section vl-home-pinned"/);
  assert.match(visualSource, /setJournalHomeRequest\(\{ tab: "notes", eventId: null \}\)/);
  assert.match(visualSource, /setKnowledgeHomeEntryId\(update\.id\)/);
  assert.match(visualSource, /setJournalHomeRequest\(\{ tab: "chronicle", eventId: update\.id \}\)/);
  assert.match(visualSource, /const \[personalNotes, setPersonalNotes\] = useState<JournalNote\[]>/);
  assert.match(visualSource, /initialTab=\{journalHomeRequest\?\.tab\} initialEventId=\{journalHomeRequest\?\.eventId\} personalNotes=\{personalNotes\}/);
  assert.match(visualSource, /function CodexJournal\(\{ onView, initialTab = "chronicle", initialEventId = null, personalNotes, onPersonalNotesChange: setPersonalNotes \}/);
  assert.match(visualSource, /function CodexKnowledge\(\{ initialEntryId = null \}/);
  assert.doesNotMatch(homeMarkup, /vl-record-footer|Кампания:/);
  assert.match(visualSource, /aria-current=\{view===label\?"page":undefined\} onClick=\{\(\)=>navigateToView\(label\)\}/);
  assert.match(visualCss, /\.vl-b-refined \.vl-home-hero \{ width: 100%; grid-template-columns: 74px minmax\(0,1fr\) 18px/);
  assert.match(visualCss, /\.vl-b-refined \.vl-home-update \{ display: grid; grid-template-columns: 34px minmax\(0,1fr\) 18px/);
  assert.match(visualCss, /\.vl-b-refined \.vl-home-note \{ min-height: 68px/);
  assert.match(visualCss, /@media\(max-width:620px\)[\s\S]*?\.vl-b-refined \.vl-home-hero \{ grid-template-columns: 68px/);
  assert.match(visualCss, /--vl-page-background: var\(--vl-bg\);[\s\S]*?--vl-focus-ring:/);
  assert.match(visualCss, /--vl-accent-destructive: #783e3c;[\s\S]*?--vl-disabled-text: #6b665b/);
  assert.match(visualCss, /\.vl-b-refined \.vl-player-header \{ flex: 0 0 52px; min-height: 52px/);
  assert.match(visualCss, /\.vl-b-refined \.vl-player-nav \{ flex-basis: 66px; min-height: 66px/);
  assert.match(visualCss, /\.vl-b-refined \.vl-player-scroll \{ flex: 1 1 auto/);
  assert.match(visualCss, /\.vl-b-refined \.vl-sheet-actions button[\s\S]*?min-height: var\(--vl-touch-target\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-note-editor label input[^\{]*\{[\s\S]*?background-color: var\(--vl-control-surface\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-player-nav button\[aria-current="page"\][\s\S]*?inset 0 2px var\(--vl-accent\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-player-scroll button:focus-visible[\s\S]*?outline: 2px solid var\(--vl-focus-ring\)/);
  assert.match(visualSource, /function VisualTokens[\s\S]*?<details className="vl-tokens">/);
  assert.match(visualSource, /const \[selection, setSelection\] = useState\("b"\)/);
  assert.match(visualSource, /<details className="vl-codex-atmosphere">/);
  assert.doesNotMatch(visualSource.match(/<details className="vl-codex-atmosphere">[\s\S]*?<\/details>/)?.[0], /<details className="vl-codex-atmosphere" open/);
});

test("B2 knowledge uses local universal filters, new markers and a separate detail view", () => {
  const knowledgeMarkup = visualSource.match(/function CodexKnowledge\([\s\S]*?\n}\n\nfunction QuantityStepper/)?.[0];
  assert.ok(knowledgeMarkup);
  for (const title of ["Аптекарь", "Северные туннели", "Странный символ", "Чёрный пёс", "Сломанный медальон", "Исчезновение каравана"]) {
    assert.match(visualSource, new RegExp(title));
  }
  for (const category of ["Все", "Персонажи", "Места", "Существа", "Предметы", "События", "Факты"]) {
    assert.match(visualSource, new RegExp(`"${category}"`));
  }
  assert.match(knowledgeMarkup, /role="group" aria-label="Категории знаний"/);
  assert.match(knowledgeMarkup, /aria-pressed=\{category === item\}/);
  assert.match(knowledgeMarkup, /entry\.isNew && !readIds\.includes\(entry\.id\)/);
  assert.match(knowledgeMarkup, /setReadIds\(current => current\.includes\(entry\.id\) \? current : \[\.\.\.current, entry\.id\]\)/);
  assert.match(knowledgeMarkup, /<h3>Кратко<\/h3>/);
  assert.match(knowledgeMarkup, /<h3>Что известно<\/h3>/);
  assert.match(knowledgeMarkup, /<span>Открыто<\/span>/);
  assert.match(visualSource, /hasImage\?: boolean/);
  assert.match(visualSource, /import apothecaryPortrait from "\.\/assets\/apothecary\.png"/);
  assert.match(visualSource, /session: "Сессия 3", hasImage: true/);
  assert.match(knowledgeMarkup, /selectedEntry\.hasImage && <div className="vl-knowledge-art vl-knowledge-art--portrait"><img src=\{apothecaryPortrait\} alt="Аптекарь в своей лавке" \/><\/div>/);
  assert.match(visualSource, /id: "caravan", name: "Исчезновение каравана"[\s\S]*?isNew: true/);
  assert.doesNotMatch(knowledgeMarkup, /Портрет персонажа|Условный портрет/);
  assert.doesNotMatch(knowledgeMarkup, /Изображение не добавлено/);
  assert.match(knowledgeMarkup, /\$\{entry\.name\} \$\{entry\.kind\} \$\{entry\.type\}/);
  assert.doesNotMatch(knowledgeMarkup, /entry\.summary \}\} \$\{entry\.detail/);
  assert.match(knowledgeMarkup, /autoFocus value=\{query\}/);
  assert.match(knowledgeMarkup, /setSearchOpen\(open => !open\); setQuery\(""\)/);
  assert.match(knowledgeMarkup, /\{b2Knowledge\.length\} записей/);
  assert.match(visualCss, /\.vl-knowledge-count \{ flex: 0 0 auto; color: var\(--vl-muted\); font: 13px\/1\.3 Arial,sans-serif; white-space: nowrap; \}/);
  assert.doesNotMatch(knowledgeMarkup, /Кампания: Северный путь|vl-record-footer/);
  assert.match(visualCss, /\.vl-knowledge-categories \{ display: flex; gap: 8px; overflow-x: auto/);
  assert.match(visualCss, /scrollbar-width: none; -ms-overflow-style: none/);
  assert.match(visualCss, /\.vl-knowledge-categories::\-webkit-scrollbar \{ display: none/);
  assert.match(visualCss, /\.vl-knowledge-categories button \{ flex: 0 0 auto; min-height: 44px/);
  assert.match(visualCss, /button\[aria-pressed=true\] \{ border-bottom-color: var\(--vl-accent\)/);
  assert.match(visualCss, /\.vl-knowledge-row \{ display: flex;[\s\S]*?min-height: 72px/);
  assert.match(visualCss, /\.vl-knowledge-art--portrait \{ position: relative; min-height: 140px; max-height: 176px; aspect-ratio: 2 \/ 1/);
  assert.match(visualCss, /\.vl-knowledge-art--portrait img \{ position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover/);
  assert.match(visualCss, /\.vl-knowledge-back \{[\s\S]*?margin: -6px 0 8px -6px/);
  assert.match(visualCss, /\.vl-knowledge-opened \{[\s\S]*?font: 12px\/1\.4 Arial,sans-serif/);
  assert.match(visualCss, /\.vl-knowledge-detail > section p \{[\s\S]*?font: 15px\/1\.6 Arial/);
  assert.doesNotMatch(knowledgeMarkup, /vl-identity|vl-bag-cell/);
});

test("B2 journal separates session history from editable personal notes", () => {
  const journalMarkup = visualSource.match(/function CodexJournal\([\s\S]*?\n}\n\nfunction IconForJournalEvent/)?.[0];
  assert.ok(journalMarkup);
  assert.match(journalMarkup, /role="tablist" aria-label="Журнал"/);
  assert.match(journalMarkup, /Хроника/);
  assert.match(journalMarkup, /Мои заметки/);
  for (const group of ["18 сентября", "17 сентября", "Сессия 3", "Сессия 2"]) assert.match(visualSource, new RegExp(group));
  for (const kind of ["item", "knowledge", "message", "important", "interactive"]) assert.match(visualSource, new RegExp(`kind: "${kind}"`));
  for (const event of ["Получен предмет", "Открыто знание", "Получено письмо", "Интерактив завершён", "Сейф открыт"]) assert.match(visualSource, new RegExp(event));
  assert.match(journalMarkup, /setSelectedEventId\(event\.id\)/);
  assert.match(visualSource, /noteMarkerIcons = \{ Обычная: CircleDot, Важно: Flag, Проверить: Crosshair, Вопрос: CircleHelp \}/);
  assert.match(journalMarkup, /<time>\{event\.time\}<\/time>[\s\S]*?vl-chronicle-axis[\s\S]*?vl-event-copy/);
  assert.match(journalMarkup, /event\.destination && <ChevronRight className="vl-chronicle-chevron"/);
  assert.match(journalMarkup, /note\.marker !== "Обычная" && <span className=\{`vl-note-marker/);
  assert.match(journalMarkup, /<span className="vl-note-copy"><strong>\{note\.title\}<\/strong><small>\{note\.detail\}<\/small>/);
  assert.match(journalMarkup, /Открыть \{selectedEvent\.destination === "Знания" \? "запись знания" : "предмет"\}/);
  for (const marker of ["Обычная", "Важно", "Проверить", "Вопрос"]) assert.match(visualSource, new RegExp(`"${marker}"`));
  assert.match(journalMarkup, /Закреплено/);
  assert.match(journalMarkup, /Все заметки/);
  assert.match(journalMarkup, /Закрепить/);
  assert.match(journalMarkup, /Можно закрепить не более трёх заметок/);
  assert.match(journalMarkup, /Название<input/);
  assert.match(journalMarkup, /Тип заметки<select/);
  assert.match(journalMarkup, /Текст<textarea/);
  assert.match(journalMarkup, /Сохранить/);
  assert.doesNotMatch(journalMarkup, /vl-record-footer/);
  assert.doesNotMatch(journalMarkup, /Кампания: Северный путь/);
  assert.match(visualCss, /\.vl-b-refined \.vl-chronicle-events::before \{[\s\S]*?border-left: 1px solid var\(--vl-border\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-chronicle-event \{ position: relative; display: grid; grid-template-columns: 38px 18px minmax\(0,1fr\) 17px;[\s\S]*?min-height: 60px/);
  assert.match(visualCss, /\.vl-b-refined \.vl-chronicle-event time \{[\s\S]*?font-variant-numeric: tabular-nums/);
  assert.match(visualCss, /\.vl-b-refined \.vl-chronicle-axis svg \{ width: 14px; height: 14px/);
  assert.match(visualCss, /\.vl-b-refined \.vl-event-icon \{[\s\S]*?background: var\(--vl-surface\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-note-row \{ display: grid;[\s\S]*?min-height: 68px/);
  assert.match(visualCss, /\.vl-b-refined \.vl-note-row \{ display: grid; grid-template-columns: minmax\(0,1fr\) 16px 18px/);
  assert.match(visualCss, /\.vl-b-refined \.vl-note-pin \{[\s\S]*?opacity: \.58/);
  assert.match(visualCss, /\.vl-b-refined \.vl-note-editor-actions button \{ min-height: 44px/);
  assert.match(visualCss, /\.vl-note-editor label input:not\(\[type=checkbox\]\)/);
  assert.match(visualCss, /\.vl-note-pin-toggle input \{ flex: 0 0 18px; width: 18px; height: 18px; min-height: 18px/);
});

test("B3 profile uses the shared B2 visual system with a distinct character composition", () => {
  const profileMarkup = visualSource.match(/function CodexUnifiedProfile\([\s\S]*?\n}\n\nfunction IconForJournalEvent/)?.[0];
  assert.ok(profileMarkup);
  assert.doesNotMatch(profileMarkup, /B3 UNIFIED PROFILE|Тёмный кодекс|Гибридный кодекс|profile-skin-switch|Редактировать|<form|Только чтение|Ведущий|Кампания:/);
  for (const content of ["Mira Voss", "Следопыт", "Северный округ"]) assert.match(source, new RegExp(content));
  for (const content of ["О персонаже", "Наблюдательная", "Осторожная", "Упрямая", "Личная цель", "Орден Серого Пламени", "Позывной", "Север", "Родной город", "Вейр", "Внешность", "Высокая, короткие тёмные волосы, шрам над левой бровью.", "Цитата", "Я не ищу неприятности. Просто обычно знаю, где они находятся."]) assert.match(profileMarkup, new RegExp(content));
  assert.match(profileMarkup, /profile\.description/);
  assert.match(profileMarkup, /profile\.goal/);
  assert.match(profileMarkup, /className="vl-unified-profile" aria-label="Профиль персонажа"/);
  assert.match(visualSource, /unifiedProfileActive \? ` vl-b-profile-unified\$\{desktopPreview/);
  assert.doesNotMatch(visualSource.match(/const codexSection = <>[\s\S]*?\n  <\/>;\n  const legacy/)?.[0], /Кампания: Северный путь|vl-record-footer/);
  assert.match(visualSource, /view !== "Профиль" && <details className="vl-codex-atmosphere"/);
  assert.match(visualSource, /!\(variant\.id === "b" && refined && view === "Профиль"\) && <VisualTokens/);
  assert.match(visualCss, /\.vl-b-refined \.vl-profile-page \{ color:var\(--vl-text\); \}/);
  assert.match(visualCss, /\.vl-b-refined \.vl-unified-identity h1 \{[\s\S]*?color:var\(--vl-text\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-unified-sections h2 \{[\s\S]*?color:var\(--vl-muted\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-unified-goal \{[\s\S]*?border-left:2px solid var\(--vl-accent\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-unified-facts dl > div \{[\s\S]*?border-bottom:1px solid var\(--vl-border\)/);
  assert.doesNotMatch(visualCss, /vl-profile-skin|vl-profile-theme|profile-bg:#/);
  assert.match(visualCss, /\.vl-preview-desktop\.vl-single \.vl-b-refined\.vl-b-profile-unified-desktop \{ width:min\(100%,900px\)/);
  assert.match(visualCss, /\.vl-b-refined\.vl-b-profile-unified-desktop \.vl-unified-sections \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(visualCss, /\.vl-b-refined \.vl-unified-traits > div \{ display:flex; flex-wrap:wrap/);
  assert.match(visualCss, /\.vl-b-refined \.vl-unified-facts dd \{[\s\S]*?overflow-wrap:anywhere/);
  assert.match(visualCss, /@media\(max-width:620px\)[\s\S]*?\.vl-b-refined \.vl-unified-identity \{ grid-template-columns:92px/);
});
