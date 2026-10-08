# Phase 5C.2: UI State Correctness

Дата: 2026-10-08.

Baseline и HEAD после работы: `a7ae286e3a4f3ca8b2e65f549668fbe6a08aedf6`.
Перед изменениями рабочее дерево было чистым, `main == origin/main`.
[CI #35](https://github.com/1-mender/ProgDM/actions/runs/37774543791)
проверен через GitHub API: completed/success на baseline SHA.

## Закрытие аудита

| Finding | Результат |
| --- | --- |
| F1, F2, F3, F4, F7 | Исправлены в Phase 5C.1; semantics не менялись, regression tests проходят |
| F5 | Черновик Profile изолирован от polling, Edit/Cancel/Save корректны |
| F6 | Открытая Chronicle тихо обновляет голову и сохраняет pagination; stale Knowledge не отображается |
| F8 | Повторный restore возвращает normalized Character, не raw DB row |

Все F1-F8 исходного audit snapshot адресованы. Исторические документы
`CODE_AUDIT_2026-10-05.md` и `PHASE_5C1_NETWORK_DATA_SAFETY.md` не переписаны.

## F5: Profile

- Canonical state — текущий `player.profile`. Editor — отдельный локальный draft.
- `resetDraftFromPlayer()` инициализирует все поля из актуальных props и очищает
  `traitDraft`. Traits копируются в отдельный массив.
- Edit вызывает reset явно, затем открывает форму; это не зависит от того,
  когда последний раз сработал synchronization effect.
- Пока `editing == true`, polling не изменяет description, goal, traits,
  traitDraft, appearance или quote.
- Cancel отбрасывает draft, восстанавливает последние canonical values,
  очищает незавершённый trait input и закрывает форму.
- Save использует существующие mutation + refresh. Confirmed success закрывает
  editor; synchronization effect использует актуальный canonical state.
  Failed save сохраняет editor и весь draft для повтора.
- V1 conflict semantics намеренно простые: canonical change во время edit
  не переписывает draft; Save отправляет текущий draft, Cancel получает последнюю
  серверную версию. Conflict dialog и optimistic canonical state не добавлялись.

## F6: Chronicle

- Сигнал обновления — стабильная signature IDs `recentActivity` плюс безопасного
  Knowledge context: entry ID/title, summary visibility, Fact IDs.
  Весь Player object и `newActivity` не используются как trigger.
- Initial open и изменение назначенного Character сохраняют отдельную initial
  загрузку. Background head refresh не очищает список, не включает full loading,
  не сбрасывает scroll и не закрывает доступный selected detail.
- Page merge дедуплицируется по ID, входящая запись обновляет кешированную,
  порядок детерминирован: `(createdAt DESC, id DESC)`.
- Старые загруженные страницы сохраняются. Пока загружена только page one,
  nextCursor можно обновить; после loadMore сохраняется cursor последнего tail.
  Если все кешированные события стали скрытыми, новый head cursor снова
  позволяет загрузить актуальную историю вместо сохранения исчерпанного tail.
- Если между polling пришло больше одной страницы новых событий, head refresh
  дочитывает промежуток до прежней видимой головы. Это предотвращает пропуск
  событий между новой page one и уже загруженным tail.
- Head и tail могут обновляться параллельно. Lifecycle generations отбрасывают
  late responses после смены Character/tab; отдельный head ticket отбрасывает
  более старое обновление головы. Параллельные loadMore блокируются ref guard.
- Derived safe projection удаляет Knowledge events без доступной entry,
  summary events без summary access и Fact events без доступных Facts.
  Название берётся из текущей safe Knowledge entry, а не из stale cache.
  Скрытые body/title не показываются; поздний ответ не обходит этот фильтр.
- Если selected event остался safe, detail сохраняется. Если исчез из safe
  projection, detail закрывается и возвращается список.
- Mark-seen меняет badges, но не перезагружает Chronicle при прежней signature.
- Background failure оставляет список/detail/cursor и показывает небольшое
  сообщение с тихим retry. Initial/loadMore errors сохраняют свои прежние сценарии.
- WebSocket, notifications, новые API или Activity types не добавлялись.

## F8: Character normalization

Точная правка idempotent ветки:

```ts
if (!character.archivedAt) return characterRecord(character);
```

Первое и повторное восстановление возвращают одинаковый Character shape,
`traits: string[]`, `archivedAt: null`. Повтор не меняет данные и не создаёт
дополнительный `character_restored` event.

Проверены createCharacter, archiveCharacter (включая повтор), listCharacters,
getCharacterOverview, updateCharacterProfile, player profile update и capacity
update. Они уже используют normalization. Отдельного публичного getCharacter
в текущем DB API нет; single-character чтение идёт через overview. Других
случаев raw serialized traits в проверенных публичных returns не найдено.

## Тесты

Добавлено **19 executable tests**:

- 4 Profile component tests: все draft fields при polling, Cancel/reopen,
  failed Save, confirmed Save/refresh и canonical read mode.
- 13 Chronicle component tests: quiet head merge, dedup/order, older pages,
  cursors, safe detail/revoke, unchanged polling/mark-seen, failed head retry,
  late responses, burst bridging, head/loadMore races, polling during initial
  load, tab cleanup и скрытие всех кешированных событий.
- 1 DB test: normalized Character returns, traits/nonempty и empty,
  repeated archive/restore, list/overview, отсутствие второго restore event.
- 1 server test: первый/повторный HTTP restore имеют одинаковый JSON shape,
  включая empty traits, и один restore event.

Hooks harness получил rerender/unmount и effect cleanup. Он исполняет реальные
компоненты, но не является React DOM renderer. Браузерный layout, физическая
LAN и точное пиксельное сохранение scroll anchor не проверялись.

Существующие тесты не удалялись и не ослаблялись. Весь набор:
**206 tests — database 72, server 39, web 95**.

Проверки: `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check` — успешно.

## Изменённые файлы

- `apps/web/src/player/ProfilePage.tsx`
- `apps/web/src/player/JournalPage.tsx`
- `apps/web/test/helpers/runtime.mjs`
- `apps/web/test/ui-state-correctness.test.mjs` (новый)
- `packages/database/src/index.ts`
- `packages/database/test/database.test.mjs`
- `apps/server/test/app.test.mjs`
- `docs/PHASE_5C2_UI_STATE_CORRECTNESS.md` (этот отчёт)

## Границы

- Последняя миграция остаётся 0016, новая migration не создавалась.
  Archive v11, schema, API authorization и backup architecture не менялись.
- Historical token read semantics не расширены; Chronicle использует прежний
  защищённый Player Journal endpoint и safe projections.
- Profile conflict resolution остаётся v1 last submitted draft wins.
  Head error повторяется явно или при новом signal, а не дополнительным таймером.
- Ограничения Phase 5C.1 (сохранность localStorage, отсутствие cross-tab mutex,
  конечный archive budget и synchronous import) остаются без изменений.
- `data/game.db` не читалась и не изменялась; DB/API tests изолированы.
- Commit не создан, push не выполнен. Media и новые продуктовые фазы не начинались.
