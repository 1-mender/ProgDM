export class LatestRequest {
  private sequence = 0;
  begin() { return ++this.sequence; }
  invalidate() { this.sequence++; }
  isCurrent(ticket: number) { return ticket === this.sequence; }
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
