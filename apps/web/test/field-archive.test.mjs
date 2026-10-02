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

test("B2 knowledge uses local universal filters, new markers and a separate detail view", () => {
  const knowledgeMarkup = visualSource.match(/function CodexKnowledge\(\)[\s\S]*?\n}\n\nfunction ItemDetailPanel/)?.[0];
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
  assert.match(visualSource, /view !== "Знания" && <footer className="vl-record-footer"/);
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
