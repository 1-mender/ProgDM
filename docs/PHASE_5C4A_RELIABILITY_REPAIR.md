# Phase 5C.4A: Reliability Repair

Дата: 2026-10-17. Baseline и HEAD после работы:
`539e0f5f860e7995d27fbc06289b7dc2740b9a2a`.

Перед началом `HEAD == main == origin/main`, рабочее дерево чистое.
[CI #37](https://github.com/1-mender/ProgDM/actions/runs/39018125851)
проверен через GitHub API: `completed / success`, SHA совпал с baseline.

## Границы

Исправлены только F1-F4 из `CODE_AUDIT_2026-10-08_FINAL.md`. Исторический
audit-документ не изменён. F5/F6/F7, Media и Phase 5C.4B не начинались.
Схема, migration 0016, archive v11 и shared domain types не изменены.
Новых зависимостей нет. `data/game.db` не читалась и не изменялась.
Commit/push не выполнялись.

| Finding | Результат |
|---|---|
| F1 | Общие read-only DB-domain checks выполняются на staged backup до ATTACH/live replacement |
| F2 | Ошибки чтения successful body и неверная форма критичных ответов больше не становятся `{}` success |
| F3 | Один открытый create editor использует стабильный UUID заметки; retry не добавляет второй note/event |
| F4 | Global background refresh сериализован; stale token/unmount/mutation ответы не применяются |

## F1: staged restore

`collectDomainIntegrityChecks(database)` принимает произвольное SQLite
connection после migrations. Это внутренний read-only helper database layer:
он не открывает другие БД, не проверяет пути, не создаёт каталоги и не пишет
данные. Существующие SQL и JS domain checks Data Health перенесены без
добавления новых продуктовых правил.

Один набор проверок используется в `checkDataHealth()` и `restoreBackupFile()`:

- согласованность Session/Player/Character assignment и Campaign;
- Knowledge categories, персональные targets, Facts ownership и reveal refs;
- bag capacity, catalog enums/flags, inventory campaign и equipment compatibility;
- active approved assignments и archived Characters;
- read-state/event references и campaign Activity relations;
- transfer/discard provenance, существующие JSON/UUID проверки;
- Notes representation и profile traits/appearance/quote;
- campaign profile field definitions, ordering и value relations;
- removed/released timestamps, lifecycle consistency, duplicate assignments/names.

После staged migration выполняются migration-history, integrity/FK и полная
schema-signature проверки, затем shared domain checks. Только после их успеха
выполняется ATTACH и транзакционная замена live tables. Ошибка domain check,
включая невозможность выполнить проверку, отклоняет копию с внутренней ошибкой
`Backup contains invalid domain references.`

Server mapping возвращает безопасный 409:
«Копия повреждена или создана несовместимой версией приложения.»
SQL и filesystem paths в ответ не попадают.

Три TEMP fixtures имеют clean `integrity_check`/`foreign_key_check`, но содержат
cross-campaign Inventory/Catalog, assignment или персональное Knowledge target.
Все отклоняются. Tests сравнивают байты live SQLite и source backup, весь
campaign state без свежего export timestamp, uploads sentinel, наличие safety
copy и отсутствие staged `.migrate-restore-*`/`uploads.restore-*` файлов.

Нормальный restore, safety-copy поведение и existing legacy staged migration
tests остаются зелёными. Общая архитектура DB/uploads rollback не переписана.

## F2: Player HTTP responses

- Non-2xx: JSON error body читается по возможности. При TypeError/SyntaxError/
  AbortError чтения используется безопасное сообщение; возвращается
  `PlayerApiError` с исходным HTTP status. Статус не теряется.
- 2xx: body обязан прочитаться как JSON. TypeError/AbortError дают безопасный
  `PlayerNetworkError`; SyntaxError и неверная форма ответа дают
  `PlayerResponseError`, наследующий тот же network-style error.
- Parser diagnostics не показываются пользователю. Нормальный object JSON
  возвращается без изменения. Существующий конечный timeout и finally cleanup
  сохранены.
- Без runtime-schema framework добавлены проверки контейнеров и основных
  потребляемых полей для `/me`, `/journal` и `/transfer-targets`. `{}`/null/
  primitive или отсутствующий массив не принимаются как валидный typed state.
  Это защитная граница, не полная повторная реализация всех server schemas.

Unreadable 2xx mutation остаётся ambiguous, а не definite 4xx failure.
Inventory registry сохраняет operationId; успешный retry завершает исходный
intent. Join credential-retention tests проходят без изменения Join semantics.
Runtime transfer test использует настоящий Workspace callback, API helper и
InventoryPage: список targets остаётся массивом, ошибка показывается, реальный
render дочернего TransferDetails больше не падает.

## F3: Personal Note create identity

При `startCreate` генерируется UUID через существующий LAN-compatible
`createOperationUuid`. Он хранится в состоянии открытого редактора и передаётся
через Journal/Workspace как `noteId` в существующий POST `/api/player/notes`.
Polling, failed save и retry того же editor не генерируют новый ID.

Database transaction сначала проверяет active approved controller, затем:

1. Проверяет UUID и нормализует existing note fields.
2. Если ID отсутствует, вставляет note с этим PK и один `personal_note_created`.
3. Если ID уже принадлежит тому же Character и payload совпадает, возвращает
   существующую note с прежними timestamps без второго Activity.
4. Если Character или payload отличается, возвращает safe conflict 409.
   Create никогда не обновляет существующую строку.

Дедупликации по тексту нет: одинаковое содержимое с другим UUID создаёт другую
легитимную заметку. Проверки прав не обходятся idempotent веткой.
Update endpoint не принимает `noteId` в body.

Для существующих клиентов/body-only DB callers `noteId` остаётся optional;
server-generated UUID сохраняет прежнюю совместимость. Production editor
всегда отправляет стабильный ID. Legacy caller без ID не получает новую
retry-гарантию автоматически.

Три executable API/UI сценария моделируют commit + потерю ответа, commit +
нечитаемый 2xx body и successful POST + failed refresh. После первой попытки
draft остаётся, retry отправляет тот же ID. После retry: **одна note, один
personal_note_created**; подтверждённый save закрывает editor. Новое намеренное
создание того же текста получает другой ID и вторую note.

### Ограничения reconciliation

- Persistent storage несохранённого draft не добавлен. При remount editor
  отбрасывается; уже committed note доступна в следующем PlayerState.
- Изменённый payload ambiguous create или последующее редактирование уже
  созданной note дают conflict при retry исходного create, а не overwrite.
  Отдельного immutable request receipt без schema change не добавлялось.
- Автоматическое закрытие editor по polling/reconciliation не добавлено;
  пользовательский retry подтверждает результат через прежний endpoint.

## F4: DM polling

`refreshInFlight` хранит ticket текущего global request batch. Silent refresh
не стартует, пока initial/background/explicit refresh выполняется. Tick
пропускается, после completion следующий tick снова разрешён. Сброс в finally
выполняется только владельцем ticket: старый request не освобождает новый.

`loadId` остаётся отдельной защитой актуальности. Token change/unmount
инвалидируют старый request и очищают контекст in-flight; 401 текущего запроса
по-прежнему удаляет ключ. Начало mutation инвалидирует старый background
response; явный post-mutation refresh может стартовать и применить новый state.
Busy polling не конкурирует с mutation. Overview/history polling не менялись.

Deferred-response tests моделируют tick на t=3s и успешный initial response
на t=4s без реального ожидания и зависимости от скорости CI. Дополнительно
проверены repeated ticks при незавершённом batch, следующий tick после success,
fast polling, token change, unmount и оба порядка старого background completion
относительно mutation/post-mutation refresh.

## Проверки

Добавлены 22 executable tests: database 4, server 5, web 13.
Существующие 206 тестов сохранены. В одном старом web timeout test fake `/me`
response заменён валидным PlayerState; source assertion редактора обновлена
под третий аргумент creationId, без ослабления условия закрытия после success.
F7 timezone assertion намеренно не менялась.

- `pnpm typecheck`: PASS.
- `pnpm test`: **228/228**, database **76**, server **44**, web **108**.
- `pnpm build`: PASS. Первый sandbox-запуск esbuild получил filesystem Access
  denied; повтор той же команды с разрешением доступа завершился успешно.
- `git diff --check`: PASS; новые untracked файлы дополнительно проверены.

DB/API tests используют TEMP files или memory DB. Hooks harness исполняет
настоящие handlers/effects, но не является ReactDOM/browser renderer. Real-device,
exact viewport и filesystem fault-injection не выполнялись. Это не изменение
исторических read rights, Inventory/Knowledge semantics или media architecture.

## Изменённые файлы

- `packages/database/src/index.ts`
- `packages/database/test/database.test.mjs`
- `apps/server/src/app.ts`
- `apps/server/test/app.test.mjs`
- `apps/web/src/App.tsx`
- `apps/web/src/player/api.ts`
- `apps/web/src/player/PersonalNotesPage.tsx`
- `apps/web/src/player/JournalPage.tsx`
- `apps/web/src/player/PlayerWorkspace.tsx`
- `apps/web/test/production-player.test.mjs`
- `apps/web/test/reliability-repair.test.mjs` (новый)
- `docs/PHASE_5C4A_RELIABILITY_REPAIR.md` (этот отчёт)

HEAD после работы совпадает с baseline. Новая migration не создана, archive
format остался v11. `data/game.db` не читалась/не изменялась. Commit не создан,
push не выполнен. Работа останавливается до отдельной команды на Phase 5C.4B.
