import { createOperationUuid } from "../sync";
import { PlayerApiError } from "./api";

export type InventoryIntent = { type: "transfer" | "discard"; inventoryItemId: string; quantity: number; recipientCharacterId?: string };
type PendingIntent = InventoryIntent & { operationId: string };
type IntentStorage = Pick<Storage, "getItem" | "setItem">;
const LIMIT = 20;
const storageError = "Не удалось сохранить незавершённые действия. Проверьте доступ к локальному хранилищу.";

function identity(intent: InventoryIntent) {
  return JSON.stringify([intent.type, intent.inventoryItemId, intent.quantity, intent.recipientCharacterId ?? null]);
}

export class InventoryIntents {
  readonly key: string;
  constructor(credential: string, private readonly storage: IntentStorage, private readonly createId = createOperationUuid) {
    this.key = "progdm.inventoryPending:" + credential;
  }
  private read(): PendingIntent[] {
    try {
      const entries: unknown = JSON.parse(this.storage.getItem(this.key) ?? "[]");
      if (!Array.isArray(entries) || entries.length > LIMIT || entries.some((entry) =>
        !entry || !["transfer", "discard"].includes(entry.type) || typeof entry.inventoryItemId !== "string" ||
        !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 9999 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.operationId) ||
        (entry.type === "transfer" ? typeof entry.recipientCharacterId !== "string" : entry.recipientCharacterId !== undefined))) {
        throw new Error(storageError);
      }
      return entries;
    } catch { throw new Error(storageError); }
  }
  private write(entries: PendingIntent[]) {
    try { this.storage.setItem(this.key, JSON.stringify(entries)); }
    catch { throw new Error(storageError); }
  }
  getOrCreate(intent: InventoryIntent) {
    const entries = this.read();
    const existing = entries.find((entry) => identity(entry) === identity(intent));
    if (existing) return existing.operationId;
    if (entries.length >= LIMIT) throw new Error("Есть 20 неподтверждённых действий. Повторите незавершённые действия перед новым.");
    const operationId = this.createId();
    this.write([...entries, { ...intent, operationId }]);
    return operationId;
  }
  complete(operationId: string) { this.write(this.read().filter((entry) => entry.operationId !== operationId)); }
  pending() { return this.read().map((entry) => ({ ...entry })); }
  async execute(intent: InventoryIntent, send: (operationId: string) => Promise<unknown>, refresh: () => Promise<void>) {
    const operationId = this.getOrCreate(intent);
    let committed = false;
    try {
      await send(operationId);
      committed = true;
      await refresh();
      this.complete(operationId);
    } catch (error) {
      if (!committed && error instanceof PlayerApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        this.complete(operationId);
      }
      throw error;
    }
  }
}
