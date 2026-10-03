import { useEffect, useState, type FormEvent } from "react";
import { Pencil, UserRound } from "lucide-react";
import type { PlayerState } from "@progdm/shared";
import { characterInitials } from "./model";

export function ProfilePage({ player, busy, onSave }: {
  player: PlayerState;
  busy: boolean;
  onSave: (fields: { shortDescription: string; personalGoal: string }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(player.profile?.shortDescription ?? "");
  const [goal, setGoal] = useState(player.profile?.personalGoal ?? "");

  useEffect(() => {
    setDescription(player.profile?.shortDescription ?? "");
    setGoal(player.profile?.personalGoal ?? "");
  }, [player.profile?.shortDescription, player.profile?.personalGoal]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSave({ shortDescription: description, personalGoal: goal })) setEditing(false);
  }

  const name = player.characterName ?? player.displayName;
  return <div className="prod-page prod-profile">
    <article className="prod-profile-card">
      <header className="prod-profile-identity">
        <span className="prod-avatar prod-avatar-large" aria-hidden="true">{characterInitials(player.characterName, player.displayName) || <UserRound />}</span>
        <div><h1>{name}</h1>
          {player.profile?.archetype && <p>{player.profile.archetype}</p>}
          {player.profile?.origin && <span>{player.profile.origin}</span>}
        </div>
      </header>

      {player.profile?.shortDescription && <section className="prod-profile-section"><h2>О персонаже</h2><p>{player.profile.shortDescription}</p></section>}
      {player.profile?.personalGoal && <section className="prod-profile-section prod-profile-goal"><h2>Личная цель</h2><p>{player.profile.personalGoal}</p></section>}

      {player.canEdit && !editing && <button className="prod-secondary prod-edit-profile" type="button" onClick={() => setEditing(true)}><Pencil aria-hidden="true" />Редактировать</button>}
      {editing && player.canEdit && <form className="prod-profile-editor" onSubmit={(event) => void submit(event)}>
        <h2>Мои записи в профиле</h2>
        <label htmlFor="prod-profile-description">О персонаже</label>
        <textarea id="prod-profile-description" value={description} maxLength={500} rows={4} disabled={busy} onChange={(event) => setDescription(event.target.value)} />
        <label htmlFor="prod-profile-goal">Личная цель</label>
        <textarea id="prod-profile-goal" value={goal} maxLength={500} rows={3} disabled={busy} onChange={(event) => setGoal(event.target.value)} />
        <div className="prod-actions"><button className="prod-secondary" type="button" disabled={busy} onClick={() => setEditing(false)}>Отмена</button><button className="prod-primary" type="submit" disabled={busy}>Сохранить</button></div>
      </form>}
    </article>
  </div>;
}
