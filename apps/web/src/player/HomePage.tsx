import { ArrowRight, Check, Pin, Sparkles } from "lucide-react";
import type { PlayerState } from "@progdm/shared";
import { characterInitials, homeActivityDigest, homeActivityIcon, homeActivityLabel, personalNoteDisplayTitle, pinnedHomeNotes } from "./model";

export function HomePage({ player, busy, onProfile, onJournal, onPinnedNotes, onMarkSeen }: {
  player: PlayerState;
  busy: boolean;
  onProfile: () => void;
  onJournal: () => void;
  onPinnedNotes: () => void;
  onMarkSeen: (eventId: string) => void;
}) {
  const activity = homeActivityDigest(player.newActivity);
  const pinnedNotes = pinnedHomeNotes(player.notes);
  const latest = activity[0];
  const name = player.characterName ?? "Персонаж ещё не назначен";

  return <div className="prod-page prod-home">
    <button className="prod-character-hero" type="button" onClick={onProfile} aria-label="Открыть профиль персонажа">
      <span className="prod-avatar" aria-hidden="true">{characterInitials(player.characterName, player.displayName) || "?"}</span>
      <span className="prod-hero-copy">
        <strong>{name}</strong>
        {player.profile?.archetype && <span>{player.profile.archetype}</span>}
        {player.profile?.origin && <small>{player.profile.origin}</small>}
      </span>
      <ArrowRight className="prod-hero-arrow" aria-hidden="true" />
    </button>

    <section className="prod-section" aria-labelledby="prod-home-new">
      <div className="prod-section-heading"><h1 id="prod-home-new"><Sparkles aria-hidden="true" />Новое</h1>{activity.length > 0 && <span className="prod-count">{activity.length}</span>}</div>
      {activity.length > 0 ? <>
        <ul className="prod-activity-list">{activity.map((event) => {
          const Icon = homeActivityIcon(event);
          return <li key={event.id}>
            <span className="prod-row-icon" aria-hidden="true"><Icon /></span>
            <span>{homeActivityLabel(event)}</span>
          </li>;
        })}</ul>
        <div className="prod-actions">
          <button className="prod-secondary" type="button" onClick={onJournal}>Открыть журнал →</button>
          {latest && <button className="prod-primary" type="button" disabled={busy || !player.canEdit} onClick={() => onMarkSeen(latest.id)}><Check aria-hidden="true" />Отметить просмотренным</button>}
        </div>
      </> : <p className="prod-empty">Пока ничего нового.</p>}
    </section>
    {pinnedNotes.length > 0 && <section className="prod-section prod-home-pinned" aria-labelledby="prod-home-pinned">
      <div className="prod-section-heading"><h2 id="prod-home-pinned"><Pin aria-hidden="true" />Закреплено</h2></div>
      <ul className="prod-pinned-note-list">{pinnedNotes.map((note) => <li key={note.id}>
        <button type="button" onClick={onPinnedNotes} aria-label={`Открыть заметки: ${personalNoteDisplayTitle(note)}`}>
          <Pin aria-hidden="true" /><span>{personalNoteDisplayTitle(note)}</span><ArrowRight aria-hidden="true" />
        </button>
      </li>)}</ul>
    </section>}
  </div>;
}
