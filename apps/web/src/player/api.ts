export class PlayerApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class PlayerNetworkError extends Error {
  constructor() {
    super("Нет связи с сервером. Попробуйте ещё раз.");
  }
}

export class PlayerResponseError extends PlayerNetworkError {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => typeof value[key] === "string");
}

function rows(value: unknown, valid: (row: Record<string, unknown>) => boolean) {
  return Array.isArray(value) && value.every((row) => record(row) && valid(row));
}

function activityRows(value: unknown) {
  return rows(value, (row) => strings(row, ["id", "createdAt", "kind"]));
}

function validResponse(path: string, body: unknown): boolean {
  const route = path.split("?")[0];
  if (route === "/api/player/me") {
    return record(body) && strings(body, ["displayName", "campaignName", "sessionName"]) &&
      ["pending", "approved", "rejected"].includes(String(body.status)) && typeof body.canEdit === "boolean" &&
      (body.characterId === null || typeof body.characterId === "string") &&
      (body.characterName === null || typeof body.characterName === "string") &&
      (body.inventoryCapacity === null || Number.isInteger(body.inventoryCapacity)) &&
      rows(body.inventory, (row) => strings(row, ["id", "name", "category", "description"]) && Number.isInteger(row.quantity)) &&
      rows(body.knowledge, (row) => strings(row, ["id", "title", "category"]) && typeof row.summaryVisible === "boolean" &&
        rows(row.facts, (fact) => strings(fact, ["id", "body"]))) &&
      rows(body.notes, (row) => strings(row, ["id", "title", "body", "marker"]) && typeof row.pinned === "boolean") &&
      activityRows(body.recentActivity) && activityRows(body.newActivity) &&
      (body.profile === null || (record(body.profile) && strings(body.profile,
        ["shortDescription", "archetype", "origin", "personalGoal", "appearance", "quote"]) &&
        Array.isArray(body.profile.traits) && body.profile.traits.every((trait) => typeof trait === "string") &&
        rows(body.profile.profileFields, (field) => strings(field, ["id", "label", "value"]))));
  }
  if (route === "/api/player/journal") {
    return record(body) && activityRows(body.events) && (body.nextCursor === null ||
      (record(body.nextCursor) && strings(body.nextCursor, ["beforeCreatedAt", "beforeId"])));
  }
  if (/^\/api\/player\/inventory\/[^/]+\/transfer-targets$/.test(route ?? "")) {
    return record(body) && rows(body.targets, (row) => strings(row, ["characterId", "characterName"]) &&
      [row.bagSlotsUsed, row.inventoryCapacity, row.maxQuantity].every(Number.isInteger) && typeof row.willMerge === "boolean");
  }
  return record(body);
}

export async function playerRequest<T>(path: string, init: RequestInit = {}, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw new PlayerApiError(record(body) && typeof body.message === "string"
        ? body.message : "Не удалось выполнить запрос.", response.status);
    }
    const body: unknown = await response.json();
    if (!validResponse(path, body)) throw new PlayerResponseError();
    return body as T;
  } catch (error) {
    if (error instanceof PlayerApiError) throw error;
    if (error instanceof SyntaxError) throw new PlayerResponseError();
    if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
      throw new PlayerNetworkError();
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function playerPost<T>(credential: string, path: string, body: object): Promise<T> {
  return playerRequest<T>(path, {
    method: "POST",
    headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
}

export async function playerGet<T>(credential: string, path: string): Promise<T> {
  return playerRequest<T>(path, {
    headers: { Authorization: "Bearer " + credential },
    cache: "no-store"
  });
}
