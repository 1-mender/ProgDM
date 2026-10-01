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

export function mergeProfileDraft<T extends { id: string; name: string; shortDescription: string; archetype: string; origin: string; personalGoal: string; dmNotes: string }>(draft: T | null, previous: T | null, current: T): T {
  if (!draft || !previous || draft.id !== current.id) return current;
  const merged = { ...current };
  for (const field of ["name", "shortDescription", "archetype", "origin", "personalGoal", "dmNotes"] as const) {
    if (draft[field] !== previous[field]) merged[field] = draft[field];
  }
  return merged;
}
