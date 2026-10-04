import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dm = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const playerWorkspace = readFileSync(new URL("../src/player/PlayerWorkspace.tsx", import.meta.url), "utf8");

test("Session cleanup is secondary, disabled for active sessions, and previews before confirmation", () => {
  assert.match(dm, /className="cleanup-action" disabled=\{locked \|\| session\.status === "active"\}/);
  assert.match(dm, /Сначала завершите сессию\./);
  assert.match(dm, /\/sessions\/\$\{session\.id\}\/cleanup-preview/);
  assert.match(dm, /Сессия не содержит сохраняемой игровой истории и будет удалена полностью\./);
  assert.match(dm, /Сессия исчезнет из рабочего списка\. Хроника и история кампании сохранятся\./);
  assert.match(dm, /expectedDisposition: intent\.disposition/);
  assert.match(dm, /setNotice\(isSession \? "Сессия удалена\." : "Игрок удалён\."\)/);
});

test("Player cleanup is available for pending, approved, and rejected rows with status-appropriate copy", () => {
  assert.match(dm, /pendingPlayers\.map\(\(player\) =>/);
  assert.match(dm, /approvedPlayers\.map\(\(player\) =>/);
  assert.match(dm, /Отклонённые заявки/);
  assert.match(dm, /rejectedPlayers\.map\(\(player\) =>/);
  assert.match(dm, /\/players\/\$\{player\.id\}\/cleanup-preview/);
  assert.match(dm, /Заявка будет удалена\./);
  assert.match(dm, /Игрок потеряет доступ\. Его прошлые действия останутся в истории кампании\./);
  assert.match(dm, /Игрок исчезнет из рабочего списка\. История кампании сохранится\./);
  assert.match(dm, /Персонаж станет свободен для нового назначения\./);
  assert.match(dm, /await refreshOverview\(true\)/);
  assert.match(dm, /expectedDisposition: intent\.disposition/);
});

test("Cleanup confirmation is accessible, stale previews are not retried, and errors stay user-facing", () => {
  assert.match(dm, /role="dialog" aria-modal="true" aria-labelledby="dialog-title"/);
  assert.match(dm, /onCancel=\{\(event\) => \{ event\.preventDefault\(\); if \(!busy\) close\(\); \}\}/);
  assert.match(dm, /closeOnBackdrop/);
  assert.match(dm, /setConfirmation\(null\); setCleanupConfirmation\(null\)/);
  assert.match(dm, /Состояние изменилось\. Проверьте удаление ещё раз\./);
  assert.match(dm, /Запись больше недоступна\./);
  assert.doesNotMatch(dm, /tombstone|soft delete|Activity blocker|FK/i);
});

test("Cleanup remains DM-only and no restore or removed-entity controls are exposed", () => {
  assert.doesNotMatch(playerWorkspace, /cleanup-preview|expectedDisposition|Удалить игрока|Удалить сессию/);
  assert.doesNotMatch(dm, /Восстановить игрока|Восстановить сессию|Корзина|Удалённая сессия|Удалённый игрок/);
});
