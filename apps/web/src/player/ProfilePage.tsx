import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2, UserRound } from "lucide-react";
import type { PlayerState } from "@progdm/shared";
import { characterInitials } from "./model";

type EditableProfile = { shortDescription: string; personalGoal: string; traits: string[]; appearance: string; quote: string };

export function ProfilePage({ player, busy, onSave }: {
  player: PlayerState;
  busy: boolean;
  onSave: (fields: EditableProfile) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(player.profile?.shortDescription ?? "");
  const [goal, setGoal] = useState(player.profile?.personalGoal ?? "");
  const [traits, setTraits] = useState<string[]>(player.profile?.traits ?? []);
  const [traitDraft, setTraitDraft] = useState("");
  const [appearance, setAppearance] = useState(player.profile?.appearance ?? "");
  const [quote, setQuote] = useState(player.profile?.quote ?? "");
  const traitsKey = JSON.stringify(player.profile?.traits ?? []);

  function resetDraftFromPlayer() {
    setDescription(player.profile?.shortDescription ?? "");
    setGoal(player.profile?.personalGoal ?? "");
    setTraits([...(player.profile?.traits ?? [])]);
    setTraitDraft("");
    setAppearance(player.profile?.appearance ?? "");
    setQuote(player.profile?.quote ?? "");
  }

  useEffect(() => {
    if (!editing) resetDraftFromPlayer();
  }, [editing, player.profile?.shortDescription, player.profile?.personalGoal, traitsKey, player.profile?.appearance, player.profile?.quote]);

  function addTrait() {
    const value = traitDraft.trim();
    if (!value || value.length > 40 || traits.length >= 8 || traits.includes(value)) return;
    setTraits((current) => [...current, value]);
    setTraitDraft("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSave({ shortDescription: description, personalGoal: goal, traits, appearance, quote })) setEditing(false);
  }

  const name = player.characterName ?? player.displayName;
  const profile = player.profile;
  return <div className="prod-page prod-profile">
    <article className="prod-profile-card">
      <header className="prod-profile-identity">
        <span className="prod-avatar prod-avatar-large" aria-hidden="true">{characterInitials(player.characterName, player.displayName) || <UserRound />}</span>
        <div><h1>{name}</h1>
          {profile?.archetype && <p>{profile.archetype}</p>}
          {profile?.origin && <span>{profile.origin}</span>}
        </div>
      </header>

      {profile?.shortDescription && <section className="prod-profile-section"><h2>О персонаже</h2><p>{profile.shortDescription}</p></section>}
      {!!profile?.traits.length && <section className="prod-profile-section"><h2>Черты</h2><ul className="prod-profile-traits">{profile.traits.map((trait, index) => <li key={`${trait}-${index}`}>{trait}</li>)}</ul></section>}
      {profile?.personalGoal && <section className="prod-profile-section prod-profile-goal"><h2>Личная цель</h2><p>{profile.personalGoal}</p></section>}
      {!!profile?.profileFields.length && <section className="prod-profile-section prod-profile-fields"><h2>Сведения</h2>
        <dl>{profile.profileFields.filter((field) => field.value.trim()).map((field) => <div key={field.id}>
          <dt>{field.label}</dt><dd>{field.value}</dd>
        </div>)}</dl>
      </section>}
      {profile?.appearance && <section className="prod-profile-section"><h2>Внешность</h2><p>{profile.appearance}</p></section>}
      {profile?.quote && <section className="prod-profile-section prod-profile-quote"><p>{profile.quote}</p></section>}

      {player.canEdit && !editing && <button className="prod-secondary prod-edit-profile" type="button" onClick={() => { resetDraftFromPlayer(); setEditing(true); }}><Pencil aria-hidden="true" />Редактировать</button>}
      {editing && player.canEdit && <form className="prod-profile-editor" onSubmit={(event) => void submit(event)}>
        <h2>Мои записи в профиле</h2>
        <label htmlFor="prod-profile-description">О персонаже</label>
        <textarea id="prod-profile-description" value={description} maxLength={500} rows={4} disabled={busy} onChange={(event) => setDescription(event.target.value)} />
        <fieldset className="prod-profile-trait-editor" disabled={busy}>
          <legend>Черты <span>{traits.length} / 8</span></legend>
          {traits.map((trait, index) => <div className="prod-profile-trait-row" key={`trait-${index}`}>
            <input aria-label={`Черта ${index + 1}`} value={trait} maxLength={40} onChange={(event) => setTraits((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
            <button className="prod-icon-action" type="button" aria-label={`Удалить черту ${trait}`} onClick={() => setTraits((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 aria-hidden="true" /></button>
          </div>)}
          <div className="prod-profile-trait-row">
            <input aria-label="Новая черта" value={traitDraft} maxLength={40} placeholder="Добавить черту" disabled={traits.length >= 8} onChange={(event) => setTraitDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTrait(); } }} />
            <button className="prod-icon-action" type="button" aria-label="Добавить черту" disabled={traits.length >= 8 || !traitDraft.trim() || traits.includes(traitDraft.trim())} onClick={addTrait}><Plus aria-hidden="true" /></button>
          </div>
        </fieldset>
        <label htmlFor="prod-profile-goal">Личная цель</label>
        <textarea id="prod-profile-goal" value={goal} maxLength={500} rows={3} disabled={busy} onChange={(event) => setGoal(event.target.value)} />
        <label htmlFor="prod-profile-appearance">Внешность</label>
        <textarea id="prod-profile-appearance" value={appearance} maxLength={1000} rows={4} disabled={busy} onChange={(event) => setAppearance(event.target.value)} />
        <label htmlFor="prod-profile-quote">Цитата</label>
        <textarea id="prod-profile-quote" value={quote} maxLength={300} rows={2} disabled={busy} onChange={(event) => setQuote(event.target.value)} />
        <div className="prod-actions"><button className="prod-secondary" type="button" disabled={busy} onClick={() => { resetDraftFromPlayer(); setEditing(false); }}>Отмена</button><button className="prod-primary" type="submit" disabled={busy}>Сохранить</button></div>
      </form>}
    </article>
  </div>;
}
