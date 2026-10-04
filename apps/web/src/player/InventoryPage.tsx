import { useEffect, useRef, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import type { EquipmentSlot, PlayerInventoryItem, PlayerState } from "@progdm/shared";
import {
  canEquipInventoryItem, canUnequipInventoryItem, EQUIPMENT_SLOT_ICONS, EQUIPMENT_SLOT_LABELS, EQUIPMENT_SLOT_ORDER,
  INVENTORY_CATEGORY_ICONS, INVENTORY_CATEGORY_LABELS, INVENTORY_RARITY_LABELS, inventoryBagSlotsUsed
} from "./model";

const MAX_EMPTY_CELLS = 12;

export function InventoryPage({ player, busy, onEquip, onUnequip }: {
  player: PlayerState;
  busy: boolean;
  onEquip: (itemId: string) => Promise<boolean>;
  onUnequip: (itemId: string) => Promise<boolean>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bag = player.inventory.filter((item) => item.equippedSlot === null);
  const equipped = player.inventory.filter((item) => item.equippedSlot !== null);
  const bagSlotsUsed = inventoryBagSlotsUsed(player.inventory);
  const capacity = player.inventoryCapacity;
  const freeSlots = capacity === null ? 0 : Math.max(0, capacity - bagSlotsUsed);
  const emptyCells = Math.min(freeSlots, MAX_EMPTY_CELLS);
  const selectedItem = selectedId ? player.inventory.find((item) => item.id === selectedId) ?? null : null;

  useEffect(() => {
    if (!selectedItem) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedItem]);

  const runMutation = async (action: (itemId: string) => Promise<boolean>) => {
    if (!selectedItem) return;
    if (await action(selectedItem.id)) setSelectedId(null);
  };

  return <section className="prod-page prod-inventory-page">
    <h1>Инвентарь</h1>
    <section className="prod-inventory-section" aria-labelledby="equipment-heading">
      <h2 id="equipment-heading">Экипировано</h2>
      <div className="prod-equipment-grid">
        {EQUIPMENT_SLOT_ORDER.map((slot) => {
          const item = equipped.find((entry) => entry.equippedSlot === slot);
          const SlotIcon = EQUIPMENT_SLOT_ICONS[slot];
          return item
            ? <button key={slot} type="button" className={`prod-equipment-slot is-filled${item.rarity ? ` rarity-${item.rarity}` : ""}`}
                onClick={() => setSelectedId(item.id)} aria-label={`${EQUIPMENT_SLOT_LABELS[slot]}: ${item.name}`}>
                <span className="prod-equipment-icon"><ItemIcon item={item} /></span>
                <span className="prod-equipment-copy"><small>{EQUIPMENT_SLOT_LABELS[slot]}</small><strong>{item.name}</strong></span>
                <ChevronRight aria-hidden="true" />
              </button>
            : <div key={slot} className="prod-equipment-slot is-empty" aria-label={`${EQUIPMENT_SLOT_LABELS[slot]}: пусто`}>
                <span className="prod-equipment-icon"><SlotIcon aria-hidden="true" /></span>
                <span className="prod-equipment-copy"><small>{EQUIPMENT_SLOT_LABELS[slot]}</small><strong>Пусто</strong></span>
              </div>;
        })}
      </div>
    </section>

    <section className="prod-inventory-section" aria-labelledby="bag-heading">
      <div className="prod-inventory-section-heading">
        <h2 id="bag-heading">Сумка</h2>
        <span className="prod-capacity">{capacity === null ? "—" : `${bagSlotsUsed} / ${capacity}`}</span>
      </div>
      {bag.length || freeSlots > 0
        ? <div className="prod-bag-grid" aria-label={capacity === null ? "Сумка" : `Сумка: занято ${bagSlotsUsed} из ${capacity} слотов`}>
            {bag.map((item) => <InventoryCell key={item.id} item={item} onSelect={() => setSelectedId(item.id)} />)}
            {Array.from({ length: emptyCells }, (_, index) => <div key={`empty-${index}`} className="prod-bag-cell is-empty" aria-label="Пустой слот"><span>Пусто</span></div>)}
            {freeSlots > MAX_EMPTY_CELLS && <p className="prod-free-slots">+ {freeSlots - MAX_EMPTY_CELLS} свободных слотов</p>}
          </div>
        : <p className="prod-empty">В сумке пока нет предметов.</p>}
    </section>

    {selectedItem && <div className="prod-item-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}>
      <section className="prod-item-sheet" role="dialog" aria-modal="true" aria-labelledby="item-detail-title">
        <header className="prod-item-sheet-header">
          <span className="prod-item-sheet-handle" aria-hidden="true" />
          <button ref={closeRef} className="prod-icon-button" type="button" aria-label="Закрыть" title="Закрыть" onClick={() => setSelectedId(null)}><X aria-hidden="true" /></button>
        </header>
        <ItemDetails item={selectedItem} player={player} inventory={player.inventory} capacity={capacity} busy={busy}
          onEquip={() => runMutation(onEquip)} onUnequip={() => runMutation(onUnequip)} />
      </section>
    </div>}
  </section>;
}

function InventoryCell({ item, onSelect }: { item: PlayerInventoryItem; onSelect: () => void }) {
  return <button type="button" className={`prod-bag-cell is-filled${item.rarity ? ` rarity-${item.rarity}` : ""}`} onClick={onSelect}
    aria-label={`${item.name}, ${INVENTORY_CATEGORY_LABELS[item.category]}${item.quantity > 1 ? `, количество ${item.quantity}` : ""}`}>
    <span className="prod-bag-art"><ItemIcon item={item} /></span>
    <strong>{item.name}</strong>
    <span className="prod-bag-category">{INVENTORY_CATEGORY_LABELS[item.category]}</span>
    {item.quantity > 1 && <span className="prod-bag-quantity">×{item.quantity}</span>}
  </button>;
}

function ItemIcon({ item }: { item: PlayerInventoryItem }) {
  const Icon = INVENTORY_CATEGORY_ICONS[item.category];
  return <Icon aria-hidden="true" />;
}

function ItemDetails({ item, player, inventory, capacity, busy, onEquip, onUnequip }: {
  item: PlayerInventoryItem;
  player: PlayerState;
  inventory: PlayerInventoryItem[];
  capacity: number | null;
  busy: boolean;
  onEquip: () => void;
  onUnequip: () => void;
}) {
  const bagItem = item.equippedSlot === null;
  const occupiedItem = item.equipmentSlot ? inventory.find((entry) => entry.equippedSlot === item.equipmentSlot) : undefined;
  const stackNeedsSplit = item.quantity > 1;
  const canEquip = canEquipInventoryItem(inventory, item, player.canEdit, capacity);
  const canUnequip = player.canEdit && !bagItem && canUnequipInventoryItem(inventory, capacity, item);
  const unequipBlockedByCapacity = player.canEdit && !bagItem && !canUnequip;

  return <div className="prod-item-details">
    <div className={`prod-item-art${item.rarity ? ` rarity-${item.rarity}` : ""}`}><ItemIcon item={item} /></div>
    <h2 id="item-detail-title">{item.name}</h2>
    <div className="prod-item-meta"><span>{INVENTORY_CATEGORY_LABELS[item.category]}</span>
      {item.rarity && <span className={`prod-rarity rarity-${item.rarity}`}><i aria-hidden="true" />{INVENTORY_RARITY_LABELS[item.rarity]}</span>}
    </div>
    {item.description && <p className="prod-item-description">{item.description}</p>}
    <dl className="prod-item-facts">
      <div><dt>Количество</dt><dd>{item.quantity > 1 ? `×${item.quantity}` : "1"}</dd></div>
      {item.equipmentSlot && <div><dt>Подходит для</dt><dd>{EQUIPMENT_SLOT_LABELS[item.equipmentSlot]}</dd></div>}
      {item.equippedSlot && <div><dt>Сейчас экипировано</dt><dd>{EQUIPMENT_SLOT_LABELS[item.equippedSlot]}</dd></div>}
    </dl>
    {bagItem && player.canEdit && item.equipmentSlot && <>
      <button type="button" className="prod-primary prod-item-action" disabled={busy || !canEquip} onClick={onEquip}>Экипировать: {EQUIPMENT_SLOT_LABELS[item.equipmentSlot]}</button>
      {stackNeedsSplit && <p className="prod-item-hint">Стопки больше одной единицы пока нельзя экипировать.</p>}
      {!stackNeedsSplit && occupiedItem && <p className="prod-item-hint">Слот «{EQUIPMENT_SLOT_LABELS[item.equipmentSlot]}» уже занят. Сначала снимите текущий предмет.</p>}
    </>}
    {!bagItem && player.canEdit && <>
      <button type="button" className="prod-secondary prod-item-action" disabled={busy || !canUnequip} onClick={onUnequip}>Снять</button>
      {unequipBlockedByCapacity && <p className="prod-item-hint">Сумка заполнена. Освободите место перед снятием предмета.</p>}
    </>}
  </div>;
}
