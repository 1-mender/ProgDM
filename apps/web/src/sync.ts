export class LatestRequest {
  private sequence = 0;
  begin() { return ++this.sequence; }
  invalidate() { this.sequence++; }
  isCurrent(ticket: number) { return ticket === this.sequence; }
}

export function createOperationUuid(): string {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class PendingOperationIds {
  private readonly pending = new Map<string, string>();
  constructor(private readonly createId: () => string = createOperationUuid) {}
  getOrCreate(key: string): string {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const id = this.createId();
    this.pending.set(key, id);
    return id;
  }
  complete(key: string, id: string) {
    if (this.pending.get(key) === id) this.pending.delete(key);
  }
}

export async function loadJoinSnapshot<P extends { status: string }, I>(
  credential: string, readPlayer: (token: string) => Promise<P>, readInvitation: () => Promise<I>
) {
  const player = credential ? await readPlayer(credential) : null;
  // Historical approved access is independent of whether new requests are still accepted.
  const information = player?.status === "approved" ? null : await readInvitation();
  return { player, information };
}

export function joinName(draft: string | null, displayName?: string) {
  return draft ?? displayName ?? "";
}

export function approvalTarget(characterId: string, characterName: string) {
  return characterId ? { characterId } : { characterName };
}

export function mergeProfileDraft<T extends { id: string; name: string; shortDescription: string; archetype: string; origin: string; personalGoal: string; dmNotes: string; traits?: string[]; appearance?: string; quote?: string }>(draft: T | null, previous: T | null, current: T): T {
  if (!draft || !previous || draft.id !== current.id) return current;
  const merged = { ...current };
  const fields = ["name", "shortDescription", "archetype", "origin", "personalGoal", "dmNotes", "traits", "appearance", "quote"] as const;
  for (const field of fields) {
    const same = Array.isArray(draft[field]) && Array.isArray(previous[field])
      ? JSON.stringify(draft[field]) === JSON.stringify(previous[field])
      : draft[field] === previous[field];
    if (!same) Object.assign(merged, { [field]: draft[field] });
  }
  return merged;
}
