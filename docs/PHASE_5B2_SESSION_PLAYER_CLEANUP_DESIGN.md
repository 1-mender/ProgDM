# Phase 5B.2: Session & Player Cleanup — дизайн

**Статус:** дизайн-only; production-код, схема, API, интерфейс и тесты не меняются этим документом.

**Baseline:** `3e40771815bdcb8ee37ad38177b30cae7cb9ed42` (2026-10-05). `HEAD`, `main` и `origin/main` совпали; рабочее дерево было чистым. CI #28 (`completed / success`) проверен пользователем вне этой задачи.

## 1. Проблема и решение в двух словах

Рабочие списки ведущего со временем засоряются старыми сессиями и заявками. Обычный `DELETE`, однако, может каскадно удалить игроков и назначения, на которые опирается история. В `campaign_activity` и `knowledge_fact_reveals` действуют `RESTRICT`-ссылки. Требуется различать физическое удаление действительно disposable-строк и удаление из рабочего контекста с сохранением исторической строки.

Рекомендация: добавить `sessions.removed_at` и `players.removed_at`; историю и секретные хеши не переписывать. Удалять строку физически лишь по точным условиям ниже. В обычном потоке почти все сессии и большинство заявок уже имеют Activity-ссылки, поэтому для них ожидаемое поведение — tombstone. «Удалить» остаётся пользовательским термином.

Есть ещё один важный вывод по текущему коду: при удалении одобренного Player назначение нужно **освободить**, но не стирать. Предлагается `session_character_assignments.released_at` и частичный уникальный индекс для незакрытых назначений. Это сохраняет legacy-назначения, для которых до миграции 0007 не создавалось `character_assigned` Activity.

## 2. Текущая модель и FK-карта

`Character` и его состояние постоянны для кампании. `Player` принадлежит одной `Session`; назначение связывает его с персонажем в пределах сессии. Activity — append-only история. Обычный одобренный Player из завершённой сессии по-прежнему может читать разрешённое persistent-состояние персонажа; без актуального назначения в активной сессии он не может мутировать данные.

Текущие прямые ссылки и действия SQLite:

| Ссылка | Текущий FK / действие | Значение для cleanup |
|---|---|---|
| `sessions.campaign_id -> campaigns.id` | `RESTRICT` | Кампания не удаляется в этой фазе; удалению сессии не мешает, пока кампания существует. |
| `players.session_id -> sessions.id` | `CASCADE` | Hard-delete сессии удалит её строки игроков; сами по себе строки игроков не блокируют удаление родителя. |
| `session_character_assignments.player_id -> players.id` | `CASCADE`; `player_id` — PK | Hard-delete Player удалит назначение; при tombstone его нужно сохранить, но закрыть. |
| `session_character_assignments.session_id -> sessions.id` | `CASCADE` | Назначение — значимая история участия; наличие любого назначения запрещает hard-delete Session. |
| `session_character_assignments.character_id -> characters.id` | `CASCADE` | Не удалять Character; `Character` cleanup вне scope. |
| `campaign_activity.session_id -> sessions.id` | `RESTRICT` | Любая такая строка запрещает hard-delete Session. История не удаляется и FK не обнуляется. |
| `campaign_activity.player_id -> players.id` | `RESTRICT` | Любая такая строка запрещает hard-delete Player. История не удаляется и FK не обнуляется. |
| `campaign_activity.campaign_id`, `character_id`, `related_character_id`, `catalog_item_id`, `knowledge_entry_id` | `RESTRICT` | Не являются Player/Session cleanup target, но сохраняют общую историю и её контекст. |
| `knowledge_fact_reveals.session_id -> sessions.id` (composite с campaign) | `RESTRICT` | Любой reveal из Session запрещает её hard-delete. |
| Остальные ссылки из инвентаря, Notes, profile values, read-state, Knowledge и Facts | относятся к Campaign/Character/Entry/Fact, не к Player/Session | Player removal не удаляет принадлежащее Character состояние. Session removal не затрагивает эти данные. |

`knowledge_migration_issues.legacy_player_id` — обычный текст, не FK. Текущий экспорт хранит все Session, Player, assignments, Knowledge Fact reveals и Activity; при импорте ID всех этих сущностей remap'ятся. `tokenHash` и `joinToken` в campaign archive не экспортируются.

### Фактическое ограничение hard delete

Это не только теоретический риск:

- `createSession()` всегда добавляет `session_created` с `session_id`.
- `submitPlayerRequest()` всегда добавляет `player_requested` с `session_id` и `player_id`.
- Принятие и отклонение добавляют `player_approved` / `player_rejected`; назначение записывается отдельно.

Следовательно, обычная созданная в текущей версии Session обычно уже имеет историческую ссылку и должна стать tombstone, даже если не запускалась. Обычная заявка тоже имеет Activity, поэтому pending/rejected Player часто нельзя физически удалить, сохраняя append-only Activity. Hard delete остаётся полезен для legacy/imported/неполных записей без истории, но не должен достигаться ценой удаления или редактирования Activity.

## 3. Продуктовая семантика

- «Удалить сессию» убирает её из рабочего списка. Внутри это hard delete только для disposable-сессии, иначе tombstone.
- «Удалить игрока» отзывает его доступ и убирает Player из обычного roster. Исторические строки Activity и назначение остаются.
- Tombstone не означает, что человек не участвовал, и не меняет `status` (`pending / approved / rejected`). `removedAt` — отдельное состояние жизненного цикла.
- Cleanup не генерирует Player Chronicle/Activity events. Не добавлять `session_deleted`/`player_deleted` и не изменять Activity, visibility, dedup или Player projection semantics.
- Character, инвентарь, знания, Notes, Profile и read-state остаются на месте.
- На первой версии UI восстановления нет. Tombstone технически обратим; восстановление Player с прежним активным назначением может конфликтовать, если Character уже назначен повторно, и должно будет отказать без перезаписи нового назначения.

## 4. Session lifecycle и алгоритм удаления

### Условия

1. Session должна принадлежать `campaignId` в URL; несовпадение или отсутствие возвращает 404.
2. `status = active` всегда запрещает удаление (409). Сначала DM завершает сессию. Запрет действует независимо от наличия истории.
3. Для неактивной сессии hard delete допустим **только если одновременно**:
   - нет `campaign_activity` с `session_id = S`;
   - нет `knowledge_fact_reveals` с `session_id = S`;
   - нет `session_character_assignments` с `session_id = S`;
   - среди Player этой Session нет `campaign_activity` с `player_id = P`;
   - среди Player нет `status = approved` (сам факт принятия сохраняет lifecycle history).
4. Если все условия hard delete истинны, удалить Session внутри транзакции. SQLite каскадно удалит её disposable pending/rejected Player; по условию у них нет Activity и назначений. В остальных случаях установить `removed_at`, сохранить Session/Player/assignment строки и их исходные имена/статусы.

Проверка ссылки на Activity по `player_id` включена отдельно от `session_id`, чтобы ограничение оставалось точным даже для неконсистентной legacy-строки, где у Player Activity `session_id` не совпадает или равен NULL. FK `players.session_id` обычно совпадает с родительской сессией, но алгоритм не должен полагаться на это для решения о сохранности.

Учитывая текущий `session_created`, большинство Session попадёт в ветку tombstone. Не удалять `session_created`, чтобы искусственно сделать Session «без истории».

### После tombstone

- Исключить Session из `listSessions()` и обычного `DmState.sessions`.
- Не разрешать её запускать, завершать повторно как активную, использовать для новых join requests или выдавать как доступное приглашение.
- `getCurrentSession()` должен никогда не возвращать tombstone; в БД invariant запрещает `status='active' AND removed_at IS NOT NULL`.
- Не менять `join_token` и исторические строки. `getJoinInfo()` и повторная проверка в `submitPlayerRequest()` обязаны отклонять tombstone с тем же общим 404, что и недействительное/закрытое приглашение.
- Исторический Player той же Session, если Player отдельно не удалён, сохраняет существующий read-only доступ к persistent Character. Удаление Session — уборка DM workspace, а не отзыв Player token.
- Функции просмотра Activity и Player projection должны продолжать разрешать настоящее `session.name` через сохранённую строку; не фильтровать removed Session из внутренних lookup-ов.

## 5. Player lifecycle и алгоритм удаления

### Hard delete

Player физически удаляется только если одновременно:

- его статус `pending` или `rejected` (одобренные записи не hard-delete даже без обнаруженных ссылок);
- нет ни одной `campaign_activity` строки с `player_id = P`;
- нет ни одного `session_character_assignments` для P, включая уже освобождённые назначения.

При выполнении условий hard delete является обычной уборкой без истории. В остальных случаях Player получает `removed_at`; существующие `status` и `display_name` сохраняются. Это включает типичные pending/rejected записи, потому что join/reject Activity append-only.

### Назначение при отзыве доступа

При tombstone одобренного Player транзакционно:

1. установить `players.removed_at`;
2. если есть assignment, установить его `released_at`;
3. повторно проверить, что назначение не относится к чужой Session/кампании и что Player не стал активным контроллером.

Assignment-строку не удалять. Она нужна для сохранения исторической связи, в частности у legacy assignments до Activity logging и архивов старых форматов без полного журнала. Активным считается назначение с `released_at IS NULL`. Для освобождения Character заменить текущий полный unique index `(session_id, character_id)` на partial unique index той же пары только при `released_at IS NULL`. `player_id` остаётся PK, то есть одна Player-запись всё так же может иметь максимум одну историческую assignment-строку. Новый Player в той же Session может получить Character после освобождения старой строки.

Переиспользование Assignment, когда removed Player уже не имеет доступа, не требуется. Новый участник получает новую Player-строку и новое активное назначение; данные Character остаются нетронутыми. Старые `character_assigned` Activity и старые assignment сохраняются.

### После tombstone

- Исключить Player из обычного DM roster и всех операций, перечисленных в разделе 10.
- Сохранить `status='approved'` для правдивой истории: это был одобренный Player, позднее ему отозвали доступ.
- Сохранить token hash как audit/уникальную запись, но никогда не аутентифицировать tombstone. Не экспортировать hash.
- Исключить Player из transfer targets и join/name-conflict запросов.
- Player removal никогда не удаляет Character или данные Character.

## 6. Token semantics, polling и повторное имя

Три состояния должны оставаться различимы:

| Player | GET безопасного Player state | Мутации |
|---|---|---|
| approved, не removed, historical session | Существующее read-only поведение сохраняется | запрещены без текущего active assignment |
| approved, removed | полностью запрещено | запрещены |
| pending/rejected, не removed | существующий status polling | запрещены |
| pending/rejected, removed | полностью запрещено | запрещены |

Все Player middleware/database lookup paths должны fail closed по `removed_at IS NULL`. HTTP для tombstone — такой же общий 401, как для неизвестного токена; не раскрывать, существовала ли запись, её имя или факт отзыва. В частности, один только HTTP guard insufficient: `getPlayerState()` и write-domain guards должны повторно проверять removed state, чтобы запрос, прошедший middleware до конкурентного DELETE, не вернул данные после него.

`JoinPage` хранит token локально по invitation. При 401 он удаляет старый локальный credential; следующая заявка создаёт новый случайный player token. Старый secret не должен повторно активировать tombstone. `submitPlayerRequest()` должен отвергать найденный по hash removed row, не сбрасывать `removed_at` и не переводить его назад в pending. Новый токен создаёт новую Player row.

Для имени заменить полный `players_session_name_unique` на partial unique expression index:

```sql
CREATE UNIQUE INDEX players_session_name_active_unique
ON players(session_id, lower(trim(display_name)))
WHERE removed_at IS NULL;
```

Removed row сохраняет display name, но не блокирует новую заявку с тем же именем в той же Session. Предварительная name lookup, update display name и конфликтная обработка должны использовать то же условие `removed_at IS NULL`; одного индекса недостаточно для хорошего API error. `players_token_hash_unique` остаётся полным: отозванный секрет не может быть повторно привязан к новому Player.

## 7. UI и списки ведущего

- Списки сессий исключают `removed_at != NULL`; список игроков исключает removed Player.
- Не скрывать активную Session: invariant делает такое состояние невозможным; если обнаружено повреждение, Data Health сообщает ошибку, а не маскирует его.
- Игроки из не удалённой Player-записи остаются доступными для отдельного отзыва даже после tombstone их Session. В DM roster показывать фактическое имя Session и статус, чтобы Session cleanup не стал неявным Player revoke.
- Assignment с `released_at` не отображать как текущего контроллера/занятого персонажа. Исторические Activity и экспорт сохраняют ссылку.
- Transfer target query принимает только Player без `removed_at`, одобренного и назначенного персонажу в текущей активной Session; удалённые Session и archived Character исключаются.

Подтверждение Session должно объяснить две ветки, не заставляя DM разбираться в ссылках SQLite:

- Hard delete preview: «Сессия не содержит игровой истории и будет удалена полностью. Неисторические заявки игроков этой сессии также будут удалены.»
- Tombstone preview: «Сессия исчезнет из рабочего списка. Хроника и история кампании сохранятся. Исторические игроки сохранят доступ на чтение, пока вы не удалите каждого отдельно.»
- Для активной: действие disabled; подсказка «Сначала завершите сессию.»

Удаление Player:

- «Удалить игрока» — одно название действия для pending/rejected/approved; для approved смысл подтверждения — явный отзыв доступа.
- Confirmation: «Игрок потеряет доступ. Его прошлые действия останутся в истории кампании.»
- Если есть незакрытое назначение: добавить «Персонаж станет свободен для нового назначения. Данные персонажа и инвентарь сохранятся.»
- Hard-delete disposable request может получить короткое подтверждение «Заявка будет удалена без сохранённой истории.»
- Никакой self-delete, Player-side delete или Session cleanup с Player UI.

Для точной разницы в Session confirmation предлагается возвращать из DM state поле `cleanupDisposition` (`deleted`/`removed`) либо иметь защищённый removal-preview. При DELETE disposition вычисляется заново внутри транзакции. Если UI использовал preview, передавать ожидаемую disposition и отказать 409 с просьбой обновить/подтвердить повторно при её изменении; нельзя неожиданно выполнить более разрушительную hard delete после подтверждения tombstone.

## 8. API proposal

Существующая convention использует campaign-scoped создание Session, но ID-scoped mutations для Session и Player. Для явной защиты от ошибочного выбора из другой кампании рекомендованы campaign-scoped DELETE:

- `GET /api/dm/campaigns/:campaignId/sessions/:sessionId/removal-preview`
- `DELETE /api/dm/campaigns/:campaignId/sessions/:sessionId`
- `GET /api/dm/campaigns/:campaignId/players/:playerId/removal-preview`
- `DELETE /api/dm/campaigns/:campaignId/players/:playerId`

Все требуют DM Bearer, UUID params, strict body/query и проверку, что Session принадлежит campaign, а Player принадлежит Session этой campaign. При несовпадении — одинаковый 404 «Запись не найдена». Preview — только UI-информация, не authorization и не reservation.

DELETE возвращает `200 { disposition: "deleted" | "removed" }`. Tombstone уже удалённого объекта возвращает `200 { disposition: "removed" }` без повторного изменения. Hard-deleted/unknown ID возвращает 404 на повторный вызов. Это детерминированная повторная semantics без неоднозначного частичного эффекта. Активная Session — 409. Изменившаяся с момента preview disposition — 409 и новое подтверждение. Не добавлять Player API endpoint.

## 9. Схема и migration 0016

Additive Drizzle migration `0016`:

1. `sessions.removed_at TEXT NULL`.
2. `players.removed_at TEXT NULL`.
3. `session_character_assignments.released_at TEXT NULL`.
4. Заменить полный `players_session_name_unique` на partial unique index по `(session_id, lower(trim(display_name))) WHERE removed_at IS NULL`.
5. Заменить полный `session_character_assignments_session_character_unique` на partial unique по `(session_id, character_id) WHERE released_at IS NULL`.
6. Добавить `CHECK (removed_at IS NULL OR status != 'active')` к Session (через безопасное SQLite изменение таблицы, если текущая Drizzle/SQLite генерация не может добавить constraint напрямую; никакого DB reset).
7. Рассмотреть lifecycle индексы вместо дублирующих: заменить `sessions_campaign_id_idx` на `(campaign_id, removed_at, created_at, id)` и `players_session_status_idx` на `(session_id, removed_at, status)`, только если generated SQL и тесты query plan подтверждают их пользу. Hash lookup остаётся покрыт `players_token_hash_unique`.

Миграция не переписывает существующие строки: новые даты null, все существующие assignments активны, старый индекс гарантирует отсутствие дублей при первом создании partial index. В migration tests проверить SQL отдельно; Drizzle snapshot/journal обновить. Не менять смысл старых миграций.

В `Session`/`Player` shared types и DM projections добавляются `removedAt`; assignment archive/type получает `releasedAt`. Эти поля не добавляются в player-safe projection.

## 10. Authorization и Join checklist

В будущей реализации центральный Player token lookup должен выбирать только `removed_at IS NULL`; active-controller guard должен включать тот же предикат и незакрытое назначение. Повторно закрывать доступ в domain queries, а не полагаться только на Fastify hook.

Проверить каждый текущий маршрут/путь:

- `GET /api/player/me` — tombstone даёт общий 401; удалённая Session сама по себе не отзывает read для nonremoved approved Player.
- `GET /api/player/journal` — только прежняя политика historical read / текущего активного контроллера; removed отклонён до projection.
- `POST /api/player/profile`, `/api/player/settings`, `/api/player/notes`, `/api/player/notes/:id`, `/api/player/activity/seen` — removed всегда запрещён.
- `/api/player/inventory/:id/equip`, `unequip`, `transfer-targets`, `transfer`, `discard` — removed всегда запрещён; recipient targets фильтруют removed Player.
- Join `GET /api/join/:token` и `POST /api/join/:token/request` — Session должна быть active и не removed; POST перепроверяет это атомарно.
- Polling / player state — общий недоступный credential response, без раскрытия removed-состояния.
- DM approve/reject/update player и roster — removed Player не возвращать как рабочую заявку и не принимать как target.
- Нет маршрута удаления со стороны Player.

Session soft removal оставляет Player token в силе, если сам Player не удалён. Это намеренная граница: уборка Session не является отзывом доступа.

## 11. Экспорт / импорт v11

Campaign archive повысить с v10 до v11.

- Экспортировать Session `removedAt`, Player `removedAt`, assignment `releasedAt`; включать и tombstone сущности, поскольку на них могут ссылаться Activity, reveals и assignments.
- Все ID tombstone-сущностей участвуют в обычном remap перед remap Activity/reveals/assignments. Не фильтровать их до построения ID maps.
- Не экспортировать `tokenHash`, `joinToken` или DM key; импорт генерирует новые секреты по действующей политике. Removed Player остаётся denied даже с новым случайным внутренним hash.
- Импорт v1–v10 задаёт `removedAt = null`, `releasedAt = null`; прежнюю логику безопасного завершения/перезапуска импортированной Session сохранить.
- v11 принимает nullable ISO timestamps только с реальной датой; Reject atomic при `active + removedAt`, Player с незакрытым assignment при `removedAt != null`, `releasedAt` без валидных Player/Session/Character или assignment cross-campaign, либо конфликте двух unreleased assignments на одном Character/Session.
- Имена удалённых Players не участвуют в уникальности; активные имена проверяются только для Player с `removedAt = null`.
- Physical deleted сущности отсутствуют в выгрузке; любые исторические refs к ним невозможны благодаря проверкам hard delete/FK.

## 12. Backup / restore и Data Health

SQLite backup сохраняет все поля, indexes, Activity и tombstones. Staged restore обязан:

1. принять поддерживаемый pre-0016 backup;
2. скопировать источник во временную БД и применить migration 0016;
3. проверить текущую схему, `integrity_check`, `foreign_key_check` и domain health;
4. только после успеха заменить рабочее состояние; исходный файл backup не менять;
5. при любом сбое не заменять рабочую БД и не терять страховочную копию.

Будущие Data Health checks без auto-repair:

- `removed_at` и `released_at` nullable либо валидный ISO timestamp;
- нет `sessions.status='active' AND removed_at IS NOT NULL`;
- нет unreleased assignment, принадлежащего removed Player;
- `released_at IS NOT NULL` не интерпретируется как текущий controller;
- активные display names уникальны по session + `lower(trim(name))`; повтор имени допустим только когда прежняя строка removed;
- не более одного unreleased `(session, character)` assignment;
- Player, Session, assignment, Activity и reveal сохраняют существующие same-session/same-campaign связи;
- tombstone строки, на которые ссылаются Activity/reveals, существуют.

## 13. Транзакции и конкуренция

- Оба DELETE повторно читают состояние, кампанию, status и все hard-delete blockers внутри одной SQLite transaction.
- Player removal: `removed_at + assignment.released_at` атомарны. Если любой шаг/Activity FK/domain check падает — rollback.
- Session cleanup: tombstone или hard delete целиком атомарен. Активная Session не удаляется ни по какому пути.
- Session activation проверяет `removed_at IS NULL` внутри транзакции; DB CHECK запрещает active tombstone как дополнительная защита.
- Player mutation/transfer/revoke используют serialized SQLite writes; каждый write повторно проверяет Player не removed и активное назначение. Запрос polling повторно фильтруется при чтении state после middleware, защищая гонку «middleware прошёл → DM отозвал доступ → state читается».
- Transfer target должен быть nonremoved при формировании списка и повторно проверен внутри transfer transaction.
- Duplicate DELETE: tombstone повторно даёт 200 removed; физически удалённый ID даёт 404. Preview не является блокировкой; несоответствие ожидаемого disposition отклоняется до изменения.

## 14. История, Chronicle и связанные данные

- Не удалять и не менять `campaign_activity.session_id/player_id`; строки остаются валидны из-за tombstone.
- Не обнулять FK и не добавлять generic «удалённый» name snapshot в JSON. Session/Player сохраняют фактические имена.
- Player Journal продолжает получать реальное `sessionName` через сохранённую Session строку; не должно появляться «Unknown session» или «Deleted session».
- Activity display name остаётся текущим safe payload snapshot; internal Player ID остаётся FK на tombstone.
- Fact reveal сохраняет своё `session_id`; Session tombstone не отзывает grant и не меняет party/character reveal semantics.
- Cleanup не создаёт и не меняет Player Activity projection. DM campaign history доступна прежними API.

## 15. Тестовая матрица будущей реализации

### Session

| Сценарий | Ожидаемый результат |
|---|---|
| Active Session удалить | 409, ни status, ни данные не меняются. |
| Planned/ended без Activity, reveals, assignments и approved children | hard delete; допустимые pending/rejected child rows каскадно удаляются. |
| Обычная новая Session с `session_created` | tombstone; Activity остаётся. |
| Ended Session с Activity | tombstone; Activity FK и история целы. |
| Session с Knowledge Fact Reveal | tombstone; reveal и факт доступны в истории. |
| Session с assignment, в том числе legacy assignment без Activity | tombstone; assignment сохранён. |
| Removed Session в обычном DM list / current session | отсутствует; active session никогда не removed. |
| Journal после tombstone | настоящее имя сессии отображается. |
| GET/POST join по removed session token | общий 404, новой заявки нет. |
| Removed Session + nonremoved approved Player token | прежнее историческое read поведение сохраняется; mutations запрещены как прежде. |
| Двойное DELETE / неизвестный ID | tombstone повторно стабилен; уже hard-deleted/unknown — 404. |
| Hard-delete Session с Player Activity/assignment | не каскадно удалять историю; операция переходит в tombstone. |
| Session remove конкурирует с activation | ровно один результат: active Session не становится removed. |

### Player и assignment

| Сценарий | Ожидаемый результат |
|---|---|
| Pending без Activity/assignment | hard delete. |
| Rejected без Activity/assignment | hard delete. |
| Pending/rejected с `player_requested`/`player_rejected` Activity | tombstone, Activity остаётся. |
| Approved Player, с историей или без найденного события | tombstone, никогда не hard-delete. |
| Removed token: `/api/player/me` | общий 401, нет PlayerState. |
| Removed token: Journal, Notes, Profile mutate, Activity seen, inventory/equip/transfer/discard | общий отказ; никаких прочтений/мутаций сверх safe auth response. |
| Historical approved nonremoved token | прежний read сохраняется, любые inactive mutations остаются denied. |
| Удалить assigned Player | removedAt и releasedAt атомарны; Player не controller. |
| Новый approved Player в той же active Session получает Character прежнего removed Player | успешно; старый assignment сохранён как released. |
| Removed player roster / transfer targets / active player queries | отсутствует. |
| Player removal | Character, Inventory, Knowledge, Notes, Profile и read-state сохранены. |
| Повторное имя в той же Session после removal | разрешено новым token/new Player ID; активный дубликат по-прежнему конфликтует. |
| Старый player token после removal | не реактивируется; JoinPage сбрасывает credential после 401, новая заявка создаёт новый token/row. |
| Player removal конкурирует с polling/transfer | state после отзыва не выдаётся; transfer atomic и либо завершён до removal, либо отказан после. |
| Повторное DELETE | tombstone -> 200 removed без повторного освобождения; hard-deleted -> 404. |
| Campaign scope не совпадает с Player/Session | 404, посторонняя сущность не меняется. |

### Security

- Removed Player не проходит `GET /api/player/me`, Journal, Notes, Profile mutation, Activity seen и каждый Inventory mutation/target route.
- Nonremoved historical approved Player сохраняет только существующую read-семантику.
- Нельзя удалить через Player API себя, другого Player или Session.
- DM auth обязателен; ID из другой кампании не проходит scoped DELETE.
- Join GET/POST и токен polling не раскрывают, был ли token revoked.

### Export/import, backup/restore, Health

- v11 round-trip removed Session/Player, assignments/releasedAt и remapped Activity/reveal refs.
- v1–v10 import default: оба removedAt и assignment releasedAt = null.
- Tombstones включены в export ID maps; player/join secrets отсутствуют.
- Physical deleted disposable сущности отсутствуют; импорт не создаёт висячих ссылок.
- Invalid v11 (removed active Session, removed Player с незакрытым assignment, malformed timestamp, duplicate active name/assignment) отклонён atomically.
- Current backup/restore сохраняет tombstones, released assignment и indexes; Activity refs валидны.
- Pre-0016 backup staged-migrates, defaults null, foreign_key_check clean, source bytes неизменны.
- Failed staged migration/restore не меняет production DB и не теряет safety copy.
- Data Health ловит каждый lifecycle invariant выше, но ничего не чинит автоматически.

## 16. Рекомендованный порядок реализации

**Phase 5B.2A — Domain, migration, archive, security, API.**

1. Реализовать additive 0016 на fresh и legacy fixture DB; проверить SQLite partial expression indexes и backup staged restore.
2. Ввести lifecycle predicates/domain operations и atomic cleanup; assignment release вместо удаления.
3. Обновить Session/Player query projections, Join guards, Player auth paths и recipient eligibility.
4. Добавить protected scoped preview/DELETE endpoints, disposition/error mapping и Data Health checks.
5. Поднять campaign archive до v11; проверить v1–v10 defaults, remap, secret omission и atomic invalid import.
6. Добавить database/API/security/concurrency regression suite; проверить historical read, Journal labels и export/restore.

**Phase 5B.2B — DM UI и проверка устройства.**

1. Скрыть removed rows из обычных списков; добавить «Удалить сессию» / «Удалить игрока», confirmations и понятный result notice.
2. Active session action disabled с объяснением; при удалении assigned Player показывать, что Character освобождается, а данные остаются.
3. Проверить повторный join тем же именем с новым token, отзыв старого token, assignment replacement и history на реальном телефоне/LAN.

Разделение оправдано: 5B.2A меняет safety-critical lifecycle, FK/indexes, restore и authentication; 5B.2B может затем опираться на стабильную disposition/API и проверяться отдельно. Не совмещать миграцию/безопасность с UX-рискованным изменением без отдельного review.

## 17. Открытые вопросы

1. **Формулировка «удалить» для Session.** Дизайн оставляет её в UI и показывает точный результат; если продукт предпочитает «Убрать из списка», семантика не меняется.
2. **Assignment release field.** Рекомендация — `releasedAt`, потому что мигрированные legacy assignments не всегда имеют `character_assigned` Activity. Это добавляет поле к export v11, но избегает потери исторической связи. Если до реализации будет доказано, что все существующие назначения покрыты Activity и история assignment не нужна как отдельная запись, можно пересмотреть до миграции, не после.
3. Restore UI отложен. Техническое снятие tombstone Player может быть невозможно с возвратом прежнего Character assignment, если Character уже назначен новому Player; операция должна отказать либо восстановить Player без прежнего активного assignment после отдельного решения.

Других открытых вопросов, блокирующих дизайн, нет.

## 18. Не входит в scope

Удаление/архивирование Character или Campaign, restore/recycle-bin UI, GDPR/account deletion, cloud auth/account system, realtime, Media, combat, cascade удаления исторической Activity, изменение Knowledge grants/Player projection и любое автоматическое исправление Data Health.
