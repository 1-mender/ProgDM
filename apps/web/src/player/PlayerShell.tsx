import type { ReactNode } from "react";
import { BookOpen, Settings } from "lucide-react";
import { PLAYER_NAVIGATION, type PlayerView } from "./model";

export function PlayerShell({ sessionName, view, onNavigate, onSettings, children }: {
  sessionName: string;
  view: PlayerView;
  onNavigate: (view: Exclude<PlayerView, "settings">) => void;
  onSettings: () => void;
  children: ReactNode;
}) {
  return <div className="prod-player">
    <header className="prod-player-header">
      <div className="prod-player-brand"><BookOpen aria-hidden="true" /><strong>ProgDM</strong></div>
      <div className="prod-player-session"><span>Текущая сессия</span><strong>{sessionName}</strong></div>
      <button className="prod-player-settings" type="button" onClick={onSettings} aria-label="Настройки" title="Настройки"><Settings aria-hidden="true" /></button>
    </header>
    <main className="prod-player-main">{children}</main>
    <nav className="prod-player-nav" aria-label="Разделы игрока">
      {PLAYER_NAVIGATION.map(({ id, label, icon: Icon }) => <button
        key={id}
        type="button"
        className={view === id ? "is-selected" : ""}
        aria-current={view === id ? "page" : undefined}
        onClick={() => onNavigate(id)}
      ><Icon aria-hidden="true" /><span>{label}</span></button>)}
    </nav>
  </div>;
}
