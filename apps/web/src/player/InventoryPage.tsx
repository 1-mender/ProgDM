import { useEffect, useRef, useState } from "react";
import { ChevronRight, Minus, Plus, X } from "lucide-react";
import type { PlayerInventoryTransferTarget, PlayerInventoryItem, PlayerState } from "@progdm/shared";
import {
  canEquipInventoryItem, canUnequipInventoryItem, EQUIPMENT_SLOT_ICONS, EQUIPMENT_SLOT_LABELS, EQUIPMENT_SLOT_ORDER,
  INVENTORY_CATEGORY_ICONS, INVENTORY_CATEGORY_LABELS, INVENTORY_RARITY_LABELS, bagPlaceholderCount, bagUnrenderedFreeSlots,
  characterInitials, inventoryBagSlotsUsed
} from "./model";

export function InventoryPage({ player, busy, actionError, onEquip, onUnequip, onLoadTransferTargets, onTransfer, onDiscard }: {
  player: PlayerState;
  busy: boolean;
  actionError: string;
  onEquip: (itemId: string) => Promise<boolean>;
  onUnequip: (itemId: string) => Promise<boolean>;
  onLoadTransferTargets: (itemId: string) => Promise<PlayerInventoryTransferTarget[]>;
  onTransfer: (itemId: string, recipientId: string, quantity: number) => Promise<"success" | "ambiguous" | "failed">;
  onDiscard: (itemId: string, quantity: number) => Promise<"success" | "ambiguous" | "failed">;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetMode, setSheetMode] = useState<"detail" | "transfer" | "discard">("detail");
  const [targets, setTargets] = useState<PlayerInventoryTransferTarget[]>([]);
  const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(null);
  const [actionQuantity, setActionQuantity] = useState(1);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [sheetError, setSheetError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const bag = player.inventory.filter((item) => item.equippedSlot === null);
  const equipped = player.inventory.filter((item) => item.equippedSlot !== null);
  const bagSlotsUsed = inventoryBagSlotsUsed(player.inventory);
  const capacity = player.inventoryCapacity;
  const freeSlots = capacity === null ? 0 : Math.max(0, capacity - bagSlotsUsed);
  const emptyCells = bagPlaceholderCount(freeSlots);
  const hiddenFreeSlots = bagUnrenderedFreeSlots(freeSlots);
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
  const closeSheet = () => { setSelectedId(null); setSheetMode("detail"); setSheetError(""); };
  const beginTransfer = async () => {
    if (!selectedItem) return;
    setSheetMode("transfer");
    setActionQuantity(1);
    setSelectedRecipientId(null);
    setSheetError("");
    setTargets([]);
    setLoadingTargets(true);
    try { setTargets(await onLoadTransferTargets(selectedItem.id)); }
    catch (failure) { setSheetError(failure instanceof Error ? failure.message : "Не удалось загрузить список персонажей."); }
    finally { setLoadingTargets(false); }
  };
  const submitTransfer = async () => {
    if (!selectedItem || !selectedRecipientId) return;
    const target = targets.find((entry) => entry.characterId === selectedRecipientId);
    if (!target || target.maxQuantity < actionQuantity) return;
    const outcome = await onTransfer(selectedItem.id, selectedRecipientId, actionQuantity);
    if (outcome === "success") closeSheet();
  };
  const submitDiscard = async () => {
    if (!selectedItem) return;
    const outcome = await onDiscard(selectedItem.id, actionQuantity);
    if (outcome === "success") closeSheet();
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
            {hiddenFreeSlots > 0 && <p className="prod-free-slots">+ {hiddenFreeSlots} свободных слотов</p>}
          </div>
        : <p className="prod-empty">В сумке пока нет предметов.</p>}
    </section>

    {selectedItem && <div className="prod-item-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSheet(); }}>
      <section className="prod-item-sheet" role="dialog" aria-modal="true" aria-labelledby="item-detail-title">
        <header className="prod-item-sheet-header">
          <span className="prod-item-sheet-handle" aria-hidden="true" />
          <button ref={closeRef} className="prod-icon-button" type="button" aria-label="Закрыть" title="Закрыть" onClick={closeSheet}><X aria-hidden="true" /></button>
        </header>
        {sheetMode === "detail" && <ItemDetails item={selectedItem} player={player} inventory={player.inventory} capacity={capacity} busy={busy}
          onEquip={() => runMutation(onEquip)} onUnequip={() => runMutation(onUnequip)} onTransfer={beginTransfer}
          onDiscard={() => { setActionQuantity(1); setSheetError(""); setSheetMode("discard"); }} />}
        {sheetMode === "transfer" && <TransferDetails item={selectedItem} targets={targets} selectedRecipientId={selectedRecipientId}
          onSelectRecipient={setSelectedRecipientId} quantity={actionQuantity} onQuantityChange={setActionQuantity}
          loading={loadingTargets} busy={busy} error={sheetError || actionError} onBack={() => setSheetMode("detail")} onSubmit={submitTransfer} />}
        {sheetMode === "discard" && <DiscardDetails item={selectedItem} quantity={actionQuantity} onQuantityChange={setActionQuantity}
          busy={busy} error={actionError} onCancel={() => setSheetMode("detail")} onSubmit={submitDiscard} />}
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

function ItemDetails({ item, player, inventory, capacity, busy, onEquip, onUnequip, onTransfer, onDiscard }: {
  item: PlayerInventoryItem;
  player: PlayerState;
  inventory: PlayerInventoryItem[];
  capacity: number | null;
  busy: boolean;
  onEquip: () => void;
  onUnequip: () => void;
  onTransfer: () => void;
  onDiscard: () => void;
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
      <p className="prod-item-hint">Сначала снимите предмет, чтобы передать или выбросить его.</p>
    </>}
    {bagItem && player.canEdit && <div className="prod-item-destructive-actions">
      {item.transferAllowed
        ? <button type="button" className="prod-secondary prod-item-action" disabled={busy} onClick={onTransfer}>Передать</button>
        : <p className="prod-item-hint">Этот предмет нельзя передавать.</p>}
      {item.discardAllowed
        ? <button type="button" className="prod-danger prod-item-action" disabled={busy} onClick={onDiscard}>Выбросить</button>
        : <p className="prod-item-hint">Этот предмет нельзя выбросить.</p>}
    </div>}
  </div>;
}

function QuantityStepper({ value, max, disabled, onChange }: { value: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
  return <div className="prod-quantity-stepper" aria-label="Количество предметов">
    <button type="button" aria-label="Уменьшить количество" disabled={disabled || value <= 1} onClick={() => onChange(value - 1)}><Minus aria-hidden="true" /></button>
    <output aria-live="polite">{value}</output>
    <button type="button" aria-label="Увеличить количество" disabled={disabled || value >= max} onClick={() => onChange(value + 1)}><Plus aria-hidden="true" /></button>
    <span>Доступно: {max}</span>
  </div>;
}

function TransferDetails({ item, targets, selectedRecipientId, onSelectRecipient, quantity, onQuantityChange, loading, busy, error, onBack, onSubmit }: {
  item: PlayerInventoryItem;
  targets: PlayerInventoryTransferTarget[];
  selectedRecipientId: string | null;
  onSelectRecipient: (id: string) => void;
  quantity: number;
  onQuantityChange: (value: number) => void;
  loading: boolean;
  busy: boolean;
  error: string;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const target = targets.find((entry) => entry.characterId === selectedRecipientId);
  const canSubmit = !!target && target.maxQuantity >= quantity && !busy && !loading;
  return <div className="prod-item-details prod-transfer-details">
    <button type="button" className="prod-sheet-back" onClick={onBack} disabled={busy}>Назад к предмету</button>
    <h2 id="item-detail-title">Передать предмет</h2>
    <div className="prod-transfer-item"><span className="prod-item-art"><ItemIcon item={item} /></span><span><strong>{item.name}</strong><small>{INVENTORY_CATEGORY_LABELS[item.category]} · Количество: {item.quantity}</small></span></div>
    <h3>Кому</h3>
    {loading && <p className="prod-empty" role="status">Загружаем персонажей…</p>}
    {!loading && !error && targets.length === 0 && <p className="prod-empty">Сейчас некому передать предмет.</p>}
    {!loading && targets.length > 0 && <div className="prod-transfer-targets" role="radiogroup" aria-label="Получатель">
      {targets.map((entry) => {
        const full = entry.maxQuantity === 0;
        return <button key={entry.characterId} type="button" role="radio" aria-checked={selectedRecipientId === entry.characterId}
          className="prod-transfer-target" disabled={busy || full} onClick={() => onSelectRecipient(entry.characterId)}>
          <span className="prod-target-avatar" aria-hidden="true">{characterInitials(entry.characterName, "?")}</span>
          <span className="prod-target-copy"><strong>{entry.characterName}</strong><small>Сумка {entry.bagSlotsUsed} / {entry.inventoryCapacity}</small></span>
          <span className="prod-target-state">{full ? (entry.willMerge ? "Стопка заполнена" : "Нет места") : entry.willMerge ? "Уже есть" : ""}</span>
        </button>;
      })}
    </div>}
    {item.quantity > 1 && targets.length > 0 && <QuantityStepper value={quantity} max={item.quantity} disabled={busy} onChange={onQuantityChange} />}
    {target && target.maxQuantity < quantity && <p className="prod-item-hint" role="status">Можно передать этому персонажу не более {target.maxQuantity}.</p>}
    {error && <p className="prod-feedback is-error" role="alert">{error}</p>}
    <div className="prod-item-sheet-actions"><button type="button" className="prod-secondary" disabled={busy} onClick={onBack}>Отмена</button>
      <button type="button" className="prod-primary" disabled={!canSubmit} onClick={onSubmit}>Передать</button></div>
  </div>;
}

function DiscardDetails({ item, quantity, onQuantityChange, busy, error, onCancel, onSubmit }: {
  item: PlayerInventoryItem;
  quantity: number;
  onQuantityChange: (value: number) => void;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return <div className="prod-item-details prod-discard-details">
    <h2 id="item-detail-title">Выбросить предмет?</h2>
    <div className="prod-transfer-item"><span className="prod-item-art"><ItemIcon item={item} /></span><span><strong>{item.name}</strong><small>{INVENTORY_CATEGORY_LABELS[item.category]}</small></span></div>
    {item.quantity > 1 && <><h3>Сколько выбросить?</h3><QuantityStepper value={quantity} max={item.quantity} disabled={busy} onChange={onQuantityChange} /></>}
    <p className="prod-discard-warning">Предмет исчезнет из инвентаря персонажа.</p>
    {error && <p className="prod-feedback is-error" role="alert">{error}</p>}
    <div className="prod-item-sheet-actions"><button type="button" className="prod-secondary" disabled={busy} onClick={onCancel}>Отмена</button>
      <button type="button" className="prod-danger" disabled={busy} onClick={onSubmit}>Выбросить</button></div>
  </div>;
}
