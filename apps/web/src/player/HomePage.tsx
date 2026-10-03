import { ArrowRight, BookOpen, Check, Package, Sparkles } from "lucide-react";
import type { CampaignActivity, PlayerState } from "@progdm/shared";
import { characterInitials, homeActivityDigest } from "./model";

function activityLabel(event: CampaignActivity) {
  if (event.type === "item_granted") return `Получен предмет «${event.details.itemName ?? "Предмет"}»`;
  return `Открыто знание «${event.details.knowledgeTitle ?? "Новая запись"}»`;
}

export function HomePage({ player, busy, onProfile, onJournal, onMarkSeen }: {
  player: PlayerState;
  busy: boolean;
  onProfile: () => void;
  onJournal: () => void;
  onMarkSeen: (eventId: string) => void;
}) {
  const activity = homeActivityDigest(player.newActivity);
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
        <ul className="prod-activity-list">{activity.map((event) => <li key={event.id}>
          <span className="prod-row-icon" aria-hidden="true">{event.type === "item_granted" ? <Package /> : <BookOpen />}</span>
          <span>{activityLabel(event)}</span>
        </li>)}</ul>
        <div className="prod-actions">
          <button className="prod-secondary" type="button" onClick={onJournal}>Весь журнал</button>
          {latest && <button className="prod-primary" type="button" disabled={busy || !player.canEdit} onClick={() => onMarkSeen(latest.id)}><Check aria-hidden="true" />Отметить просмотренным</button>}
        </div>
      </> : <p className="prod-empty">Пока ничего нового.</p>}
    </section>
  </div>;
}
