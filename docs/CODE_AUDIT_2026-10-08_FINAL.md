# ProgDM Final System Audit

## Baseline

- Фаза: 5C.3, audit-only. Проверка завершена 2026-10-17; дата в имени файла сохранена по заданию.
- HEAD до проверки: `44bab37c8485569b4b7ef38d55aff13567550b9f`.
- Локальные `HEAD`, `main`, `origin/main` совпали. До создания этого документа дерево было чистым; после запуска проверок посторонних изменений не появилось.
- CI #36: `completed / success`, тот же SHA. [GitHub Actions](https://github.com/1-mender/ProgDM/actions/runs/37777599696).
- Изучены полностью `AGENTS.md`, `README.md`, исходный аудит `CODE_AUDIT_2026-10-05.md`, cleanup-design, отчёты Phase 5C.1 и 5C.2; сопоставлены актуальные schema, миграции 0000-0016, DB operations, server routes, shared contracts, production UI и тесты.
- Рабочая `data/game.db` не открывалась и не изменялась. SQL corruption, миграции, импорт и restore выполнялись исключительно на изолированных TEMP-базах и файлах.
- Production-код, тесты, schema, миграции и зависимости не менялись. Создан только этот документ. Commit/push не выполнялись; HEAD не изменился.

Метод: чтение реализации, штатные 206 тестов и дополнительные одноразовые runtime-пробы без добавления файлов в репозиторий. DB/API-пробы исполняли собранный production-код через SQLite и Fastify `inject`; UI-пробы исполняли настоящие TSX handlers/effects через существующий `componentRuntime`. Это не ReactDOM, не браузер и не ручной тест телефона. Воспроизведения ниже не являются добавленными regression tests.

## Executive summary

Найдено **7 подтверждённых проблем: P0 = 0, P1 = 1, P2 = 3, P3 = 3**. Отдельно отмечены 3 направления расследования, не включённые в число bugs.

| ID | Severity | Краткий результат |
|---|---|---|
| F1 | P1 | Restore принимает structurally valid backup с доменно неверной cross-campaign ссылкой и заменяет здоровую рабочую БД. |
| F2 | P2 | Ошибка чтения успешного Player HTTP body превращается в `{}`; transfer detail затем падает при рендере. |
| F3 | P2 | Повтор создания заметки после потери ответа создаёт вторую постоянную заметку и второе событие. |
| F4 | P2 | Перекрывающийся DM polling отбрасывает все успешные ответы при стабильной задержке больше 3 секунд. |
| F5 | P3 | Уже открытый редактор Notes остаётся редактируемым после потери `canEdit`. Сервер mutation отклоняет. |
| F6 | P3 | HTTP schema и DB validator по-разному считают supplementary Unicode; schema-valid имя получает 500. |
| F7 | P3 | Тест локальной даты журнала падает в UTC+14 из-за жёсткого ожидания даты UTC. |

Базовые инварианты persistent Character и session-specific Player подтверждены. Во всех проверенных Player routes исторические credentials не получили mutation access, удалённые credentials отклоняются. Новых доказанных утечек hidden Knowledge, DM-only полей или секретов не найдено. Это результат проверенного набора сценариев, а не доказательство отсутствия всех возможных уязвимостей.

Полный 29-шаговый workflow, restart, поддерживаемые legacy migration paths и v11 round-trip прошли. Штатный `pnpm test` в текущем окружении: **206/206**. Зелёный baseline не покрывает F1-F7; дополнительный запуск одного теста в UTC+14 преднамеренно воспроизвёл F7.

## Confirmed findings

Нумерация F1-F7 относится только к этому документу. Это не перенумерация и не переписывание F1-F8 исторического аудита.

### F1 - Restore не проверяет полную доменную целостность staged backup

**Severity:** P1.

**Area:** backup/restore, межкампанийные связи, Data Health.

**Files:** `packages/database/src/index.ts:419-449` (`restoreBackupFile`, staged validation), `:457-475` (замена таблиц), `:483-510` (safety copy/recovery), `:852-976` (более полные Data Health checks); `packages/database/src/schema.ts:155-185` (inventory FK и ограничения).

**Reproduction:**

1. На TEMP-БД создать кампании A/B, персонажа Mira в A и каталожные предметы в обеих кампаниях; выдать Mira предмет из A.
2. Только в TEMP fixture заменить `inventory_items.catalog_item_id` на существующий предмет B. Обычный FK остаётся валидным; `integrity_check = ok`, `foreign_key_check` пуст.
3. Убедиться, что `checkDataHealth().ok === false`, и создать backup этой базы.
4. Исправить live TEMP-ссылку обратно на A, создать контрольную кампанию, проверить `checkDataHealth().ok === true`.
5. Вызвать `restoreBackup` для backup из шага 3.

**Expected:** staged domain validation отклоняет известную cross-campaign inconsistency до замены live-данных. Здоровая текущая БД и uploads остаются на месте.

**Actual:** restore завершается успешно. Контрольная live-кампания заменена содержимым backup; health восстановленной БД становится `false`, раздел «Инвентарь и экипировка» сообщает одну несогласованную запись. Байты исходного backup не изменяются.

**Root cause:** staged-копия проверяется по migration history, полной SQL schema signature, SQLite integrity/FK и ограниченному набору lifecycle-инвариантов. Остальные проверки, которые уже умеет Data Health, до restore не выполняются. FK существующего catalog item не гарантирует совпадение Campaign с Character.

**Impact:** здоровое текущее состояние заменяется доменно повреждённым без отказа и предупреждения. Это путь к восстановлению некорректных данных, но **не доказанная безвозвратная потеря**: safety backup создаётся. Player inventory projection для foreign catalog отдельно fail-closed; эта проба не доказывает обход авторизации или выдачу чужого описания игроку.

**Current test coverage:** есть проверки corruption через Data Health, schema/FK rejection, legacy staged migrations и round-trip. Нет теста, который требует отказа restore для backup с актуальной schema, валидными FK и доменно неверной cross-campaign ссылкой. Независимая контрольная проба с действительно dangling FK корректно отклонена, live-данные и source backup сохранены.

**Recommended fix:** выделить переиспользуемую read-only проверку DB-domain invariants и выполнять её на staged SQLite connection до live replacement. Не смешивать её с проверкой рабочих директорий. Добавить отрицательные restore fixtures для cross-campaign inventory/assignment/knowledge и других invariants, не выраженных FK. Сохранить текущие safety copy, staged migration и rollback.

### F2 - Failed body read успешного Player HTTP запроса маскируется под успех

**Severity:** P2.

**Area:** Player HTTP boundary, Inventory transfer UI.

**Files:** `apps/web/src/player/api.ts:18-23`; `apps/web/src/player/PlayerWorkspace.tsx:111-112`; `apps/web/src/player/InventoryPage.tsx:60-62`, `:221`.

**Reproduction:**

1. Вернуть из mock fetch успешный response с `status: 200`, но выбросить `TypeError("terminated")` из `response.json()`, моделируя разрыв соединения после headers.
2. Вызвать настоящий `playerRequest`: promise разрешается значением `{}`.
3. Открыть настоящий InventoryPage, выбрать предмет и вызвать загрузку transfer targets через настоящий `playerGet`.
4. Выполнить рендер полученного `TransferDetails` с результатом этой загрузки.

**Expected:** запрос отклоняется безопасной network/protocol ошибкой; UI сохраняет предыдущие валидные данные и показывает retry, не принимает `{}` как типизированный ответ.

**Actual:** `.targets` становится `undefined`; `TransferDetails` выбрасывает `Cannot read properties of undefined (reading 'find')`. Это проверено вызовом реального render-кода, не предположением по типам. Аналогичный пустой ответ `/me` также не является валидным `PlayerState`.

**Root cause:** fallback `{}` применяется к любому JSON/body failure, кроме AbortError, до проверки `response.ok`. Generic `T` не валидирует runtime shape; outer catch уже не видит проглоченный TypeError.

**Impact:** сетевой сбой превращается в успешный некорректный state и исключение UI вместо штатного восстановления. При mutation нельзя считать нечитаемый successful body доказательством корректной проекции ответа.

**Current test coverage:** timeout/abort, освобождение busy, retry и HTTP validation errors покрыты. Нет runtime-теста на TypeError/SyntaxError чтения body у 2xx и последующее использование этого результата компонентом.

**Recommended fix:** не подавлять ошибки body parsing для successful response; сохранить безопасный fallback сообщения отдельно для non-2xx. Проверить обязательную форму ответов на API boundary там, где отсутствие поля приводит к render crash. Не превращать 4xx в network errors.

### F3 - Ambiguous create-note retry создаёт дубликат

**Severity:** P2.

**Area:** Personal Notes, потеря ответа, non-idempotent create.

**Files:** `apps/web/src/player/PlayerWorkspace.tsx:36-55`, `:119-121`; `apps/web/src/player/PersonalNotesPage.tsx:49-58`; `packages/database/src/index.ts:1800-1812`.

**Reproduction:**

1. Текущий active approved controller открывает «Новая заметка» и вводит текст.
2. Настоящий POST `/api/player/notes` через Fastify `inject` успешно создаёт заметку; на клиентской границе после commit выбросить `PlayerNetworkError`, моделируя потерянный ответ.
3. Выполнить настоящий submit handler PersonalNotesPage, затем повторить сохранение того же оставшегося редактора.
4. Проверить DB notes и `personal_note_created` events.

**Expected:** retry подтверждает исходную заметку или выполняет согласованный reconciliation; одно пользовательское создание не порождает две строки.

**Actual:** редактор остаётся в состоянии `"new"`; второй submit снова делает create. Получены `postCount = 2`, `noteCount = 2`, `createEvents = 2`.

**Root cause:** create генерирует новый ID на сервере без request identity. Общий `run` возвращает `false` и при потере mutation response, и при ошибке последующего refresh; редактор не отличает неизвестный результат от неуспешного create.

**Impact:** постоянные дубликаты заметок и событий, неоднозначность для пользователя после обычного сетевого сбоя. Штатного delete endpoint заметок нет. Это не partial DB transaction: каждая из двух операций по отдельности атомарна.

**Current test coverage:** DB/API create/update/persistence/auth покрыты; Inventory и Join имеют отдельную retry-защиту. Нет end-to-end handler/API теста именно неоднозначного создания заметки. В audit использован настоящий notes endpoint и TSX submit, а не только mock счётчик.

**Recommended fix:** отдельно согласовать минимальную identity/reconciliation для note creation и сохранять её при ambiguous retry. Разделить подтверждённую mutation и failed refresh; не закрывать проблему catch-all success или сравнением заметок только по тексту.

### F4 - Global DM polling может бесконечно отбрасывать успешные ответы

**Severity:** P2.

**Area:** DM workspace, polling/request ordering.

**Files:** `apps/web/src/App.tsx:185-204` (`refresh`), `:268-274` (interval), `:282` (`locked`).

**Reproduction:**

1. Открыть DM workspace с сохранённым ключом; задерживать обе части refresh (`/state`, `/backups`) дольше polling interval 3000 ms, но меньше HTTP timeout 10000 ms.
2. До завершения первого batch запустить следующий interval tick; затем разрешить первый batch успешными response.
3. Повторить для второго batch. Все ответы корректны, но каждый приходит после старта следующего refresh.
4. Остановить запуск новых ticks и разрешить последний batch.

**Expected:** успешные refresh последовательно применяются; максимум один background refresh в полёте либо корректная coalescing policy.

**Actual:** каждый новый запрос увеличивает `loadId`. Ранее начатые успешные batch не применяются; при такой постоянной задержке initial state не загружается, а controls остаются locked. В runtime-пробе два успешных batch отброшены; данные появились только после паузы polling и завершения самого последнего batch.

**Root cause:** latest-request guard используется вместе с безусловным interval без `inFlight`. У overview/history polling такие guards есть, но global state/backups polling ими не защищён.

**Impact:** DM workspace может оставаться пустым/loading при работающем сервере; уже загруженный workspace перестаёт получать актуальное состояние. Конечный timeout не решает starvation успешных запросов, которые укладываются в timeout.

**Current test coverage:** DM download timeout/retry и stale selection helpers покрыты; latency > polling interval для настоящего DmWorkspace не проверяется.

**Recommended fix:** сериализовать/coalesce global background refresh и не инвалидировать полезный in-flight ответ каждым interval tick. Сохранить отмену устаревшего контекста при смене token/unmount; добавить runtime-тест медленного, но успешного API.

### F5 - Открытый редактор заметки не становится read-only при потере canEdit

**Severity:** P3.

**Area:** Player UI state, lifecycle/authorization feedback.

**Files:** `apps/web/src/player/PersonalNotesPage.tsx:49-58`, `:86-101`.

**Reproduction:** active controller открывает существующую заметку на редактирование; затем выполнить polling update props с `canEdit: false`, `busy: false`, например после завершения сессии. В component runtime дополнительно использован пустой актуальный список notes.

**Expected:** форма больше не предлагает разрешённое сохранение. Политика хранения локального несохранённого draft может быть отдельной, но mutation controls должны отражать текущие права.

**Actual:** `editorVisible = true`, `saveEnabled = true`, старый body остаётся в локальном draft. Submit проверяет наличие `editing`, но не `canEdit`.

**Root cause:** permission gate есть у кнопок начала редактирования и pin, но уже открытая ветка editor зависит только от `editing`; disabled зависит только от `busy`/пустого body.

**Impact:** вводящий в заблуждение editable UI, повторные заведомо запрещённые запросы и ощущение потери сохранения. **Backend bypass не найден:** исторический token получает 403. Сохранение уже загруженного текста в draft не доказывает чтение новых запрещённых данных.

**Current test coverage:** read-only начальное состояние и API auth покрыты; переход `canEdit: true -> false` внутри открытого Notes editor не покрыт.

**Recommended fix:** явно обработать потерю edit rights, отключить submit/controls и выбрать безопасное поведение draft. Не менять historical read policy ради UI fix.

### F6 - Unicode length mismatch между HTTP schema и domain validator

**Severity:** P3.

**Area:** server contract, validation/error mapping.

**Files:** `apps/server/src/app.ts:301-304`, `:436-439`, `:298`; `packages/database/src/index.ts:49-54`. Аналогичный unit mismatch есть у ряда других string validators.

**Reproduction:** с валидным DM key отправить POST `/api/dm/campaigns` с `name = String.fromCodePoint(0x1F9ED).repeat(120)` через настоящий Fastify app на TEMP-БД.

**Expected:** согласованная семантика лимита; schema-valid имя принимается либо отклоняется документированной validation ошибкой 400, но не ошибкой сохранения 500.

**Actual:** 120 Unicode code points имеют 240 UTF-16 code units. AJV допускает payload, `validatedName` отвергает его через `.length`; ответ 500 с безопасным русским сообщением «Не удалось сохранить изменения. Обновите данные перед повтором.»

**Root cause:** JSON schema maxLength и JS string.length измеряют разные единицы. Domain validation exception попадает в generic DM save-error fallback.

**Impact:** ограниченный, но воспроизводимый API contract mismatch для supplementary symbols. Обычная кириллица не затронута; максимальные кириллические profile/notes payloads проходят штатные тесты. SQL/stack/секреты этим ответом не раскрываются.

**Current test coverage:** максимальная кириллица и обычные invalid lengths покрыты; supplementary Unicode нет.

**Recommended fix:** согласовать единицу длины на API/domain/UI boundary и классифицировать input validation как 400. Добавить boundary tests с surrogate pairs, не увеличивать payload policy вслепую.

### F7 - Тест локальной даты журнала зависит от timezone машины

**Severity:** P3.

**Area:** test-suite portability.

**Files:** `apps/web/test/production-player.test.mjs:143-154`.

**Reproduction:** запустить `node --test --test-name-pattern="Journal timeline groups" apps/web/test/production-player.test.mjs` с `TZ=Pacific/Kiritimati` только для дочернего процесса. Тестовые файлы не менять.

**Expected:** тест local-date поведения работает в поддерживаемых часовых поясах либо явно фиксирует тестовый timezone, если проверяет конкретную дату.

**Actual:** fixture `2026-10-04T17:14:12.000Z` корректно отображается как `5 октября 2026 г.`, assertion ожидает `/4 октября 2026/`. Целевой запуск: 1 test, 0 pass, 1 fail. Обычный прогон в текущем Asia/Almaty: 206/206 pass.

**Root cause:** locale-local date formatting проверяется UTC-календарным днём без фиксации timezone.

**Impact:** ложный red при корректном production поведении у разработчика/runner с восточным timezone. Это не обнаруженная ошибка дат в UI.

**Current test coverage:** сам тест существует, но его окружение предполагает диапазон timezone; CI Ubuntu с обычным UTC эту проблему не выявляет.

**Recommended fix:** локально создавать fixture в нужном календарном дне или сравнивать с ожидаемой локальной датой; отдельно проверять переход дня под контролируемым timezone. Не менять production grouping для удовлетворения этого assertion.

## Needs investigation

Следующие **3** пункта не являются подтверждёнными findings:

1. **Filesystem faults во время upload staging/rollback.** `packages/database/src/index.ts:489-492`: `cpSync(sourceUploads, stagedUploads)` находится до основного try/catch. Следует fault-inject прерывание copy, отсутствие места и отказ rename/cleanup, проверить отсутствие частичных `.restore-*` каталогов и согласованность DB/uploads. Обычный restore и FK rejection проверены; реальный OS fault в этом audit не моделировался. Нельзя утверждать потерю рабочей БД только по расположению try.
2. **Два browser tabs с одним credential.** `apps/web/src/player/inventory-intents.ts:41-48` использует localStorage read-modify-write без межвкладочной блокировки. Повтор одного persisted intent в одной последовательности/remount проверен; cross-tab contention с двумя независимыми исполнителями требует отдельной воспроизводимой browser-пробы. Это известная граница текущей registry, не доказанный этим audit duplicate transfer.
3. **Большая длительная кампания.** `packages/database/src/index.ts:669` и `:1758` строят safe activity projection до окончательной выдачи страницы; монотонный append и DM state тоже читают историю. 10002-row archive regression проходит, но LAN latency/CPU/memory для десятков тысяч событий, нескольких игроков и активного polling не измерены. Нельзя объявлять performance defect без нагрузочного измерения.

## Regression matrix

Обозначения: S - чтение production source; T - выполненный существующий тест; R - дополнительная runtime-проба audit. PASS относится к названным сценариям, не к произвольным комбинациям.

| Pass | Проверка | Метод | Результат |
|---|---|---|---|
| 1 | FK, CHECK, unique/partial indexes, lifecycle, migration chain | S/T/R | PASS для штатных данных; F1 показывает доменную границу FK/restore. |
| 2 | planned -> active -> ended -> removed; competing active/cleanup | S/T/R | PASS; завершённую/удалённую сессию нельзя запустить повторно, активную сначала завершают. |
| 3 | Join pending/approved/rejected/removed, replay, credential retention | S/T/R | PASS; ambiguous Join сохраняет исходный credential, removal отзывает token. |
| 4 | Все 12 Player route families, пять состояний token | S/T/R | PASS, отдельная матрица ниже. |
| 5 | Persistent Character, archive/repeated restore, normalized return | S/T/R | PASS; traits не возвращаются сериализованной строкой в idempotent restore. |
| 6 | Grant, capacity, catalog/legacy stack, equip/unequip, transfer/discard | S/T/R | PASS на domain/API; F2 касается transfer UI transport failure. |
| 7 | Summary/Facts visibility, party/character grants, revoke | S/T/R | PASS проверенных safe projections; hidden sentinel отсутствует в Player JSON. |
| 8 | Journal cursor, equal timestamps, head burst, loadMore race, revoke | S/T | PASS штатных regression tests; F7 - portability самого date test. |
| 9 | Profile draft/cancel/save; Notes CRUD/pin/read-only transitions | S/T/R | Profile PASS; Notes F3/F5, validation F6. |
| 10 | Cleanup preview, stale disposition, hard-delete/tombstone, release | S/T/R | PASS; Character-owned данные и исторические references сохранены. |
| 11 | Archive v11, legacy v1-v8/v9/v10, >10000 events, secrets | S/T/R | PASS выполненных fixtures и round-trip. |
| 12 | Current/legacy backup, staged migrations, reject failed restore | S/T/R | Штатные/FK-negative PASS; domain-negative FAIL F1. |
| 13 | 64 KiB JSON, 64 MiB archive, 413, abort, lost/failed body | S/T/R | Limits/retry PASS; successful failed body FAIL F2. |
| 14 | Player polling, profile drafts, Journal detail/cursor generations | S/T/R | Проверенные F5/F6 прежнего audit regressions PASS; Notes loss of permission F5 этого audit. |
| 15 | DM selection, cleanup confirmations, downloads, global polling | S/T/R | Обычные сценарии PASS; slow-success global polling FAIL F4. |
| 16 | Shared/DB/API returns, normalized Character, forbidden fields | S/T/R | Проверенные projections PASS; Unicode contract F6. |
| 17 | Mutation + Activity rollback, idempotency receipts, import atomicity | S/T/R | Проверенные DB transactions PASS; F3 - два полных create, не half-state. |
| 18 | UUID order, local timezone, timers, source tests/harness | S/T/R | F7 воспроизведён; ограничения harness перечислены ниже. |
| 19 | Dead/legacy paths, Quest remnants, canonical vs snapshot docs | S/T | Current Quest production types отсутствуют; compatibility paths объяснимы. |
| 20 | Полный realistic workflow + restart | R | PASS 29 шагов, SQLite integrity/FK clean. |

## Database integrity

### Migration chain

Независимо собраны TEMP migration-prefix fixtures из настоящих SQL и Drizzle journal. Проверены как непосредственное открытие старой БД, так и staged restore её backup:

| Source | Target | Проверка |
|---|---|---|
| Пустая БД | 0016 | 17 migration rows (0000-0016), `integrity_check = ok`, FK violations = 0. |
| Pre-0014, применены 0000-0013 | 0016 | Direct + staged PASS; исходные IDs, profile traits/appearance/quote и inventory quantity сохранены. |
| Pre-0016, применены 0000-0015 | 0016 | Direct + staged PASS; Session/Player/assignment IDs и история сохранены. |

Legacy `removedAt`/`releasedAt` получили `null`; JSON traits сохранились как нормализованный массив в domain response. Проверены наличие partial indexes `players_session_name_unique`, `session_character_assignments_session_character_unique`, `sessions_one_active` и отсутствие нарушений после migrate/restore. Штатные tests дополнительно исполняют CHECK/uniqueness rejection и rollback неудачной активации. Байты обоих legacy source backups до/после совпали.

### Invariants и границы SQLite

- Один active Session на локальную БД обеспечивается partial unique index; active tombstone запрещён CHECK. Активация с ожидаемым previous session защищена от stale switch.
- Непомеченное removed имя Player уникально внутри Session; released assignment больше не занимает Character в этом Session. `player_id` остаётся PK назначения.
- FK Player/Session/assignment используют CASCADE для физически disposable строк, Activity и reveal references ограничивают cleanup через RESTRICT. Domain preview не выбирает hard delete при наличии истории; tombstone не стирает историю.
- Profile fields и Fact/reveal relations используют composite campaign FK в важных местах. Inventory catalog и assignment сами по себе не гарантируют все campaign-equality invariants; их проверяют DB APIs/Data Health. Наличие такого domain invariant не объявлено отдельным bug: F1 доказывает конкретный обход проверки на restore.
- Inventory CHECK ограничивает quantity и equipped representation, partial indexes запрещают два предмета в слоте и два catalog bag stack одного Character/catalog. Legacy catalog-null строки не склеиваются по имени.
- Notes/traits/profile values/read-state принадлежат Character, не временному Player. Обычного удаления Character с историей в UI/API нет.
- Activity append-only на уровне обычного API: edit endpoint нет. Это не SQLite tamper-proof журнал; прямой администратор файла может изменить таблицы. Не требовать нового event store ради этого audit.
- В проверенных DB operations state + соответствующий Activity записываются транзакционно. Forced Activity-append failures для transfer/discard в штатных tests откатывают inventory; invalid import не оставляет campaign/children.

Health проверяет миграции, SQLite/FK, data directories, lifecycle и доменные связи, inventory, Knowledge/Facts, Notes и profile serialization. Media reference subsystem отсутствует: individual missing image references в БД пока не представлены и искусственно не добавлялись.

## Authorization matrix

Реально исполнены все следующие route families на TEMP API для пяти состояний. При необходимости mutations использовали валидный собственный ресурс, чтобы не спутать 403 с not-found.

| Route | Pending | Rejected | Removed | Approved historical | Approved current |
|---|---|---|---|---|---|
| GET `/api/player/me` | 200, ограниченный state | 200, ограниченный state | 401 | 200, принятый historical projection | 200 |
| GET `/api/player/journal` | 403 | 403 | 401 | 403 | 200 |
| POST `/api/player/profile` | 403 | 403 | 401 | 403 | 200 |
| POST `/api/player/settings` | 403 | 403 | 401 | 403 | 200 |
| POST `/api/player/notes` | 403 | 403 | 401 | 403 | 200 |
| POST `/api/player/notes/:id` | 403 | 403 | 401 | 403 | 200 |
| POST `/api/player/activity/seen` | 403 | 403 | 401 | 403 | 200 |
| POST `/api/player/inventory/:id/equip` | 403 | 403 | 401 | 403 | Domain validation; valid case 200 |
| POST `/api/player/inventory/:id/unequip` | 403 | 403 | 401 | 403 | Domain validation; valid case 200 |
| GET `/api/player/inventory/:id/transfer-targets` | 403 | 403 | 401 | 403 | 200 |
| POST `/api/player/inventory/:id/transfer` | 403 | 403 | 401 | 403 | 200 |
| POST `/api/player/inventory/:id/discard` | 403 | 403 | 401 | 403 | 200 |

В матричной probe current equip stack quantity=2 и unequip неэкипированной строки закономерно вернули 409; отдельный полный workflow исполнил valid equip/unequip с 200. Это domain conflict, не auth failure.

Отдельных Player GET profile/notes/inventory routes нет: чтение входит в `/me`. DM-only metadata/capacity/cleanup routes требуют DM Bearer key; Player token не даёт этих прав. Произвольный `characterId` не выбирает mutation target: его определяет active assignment. Чужая note недоступна; Player projection не включает `dmNotes`, hash/token или DM key.

Удаление Session само по себе не отзывает approved token - это сохранённая политика historical базового чтения, не finding. Player removal отзывает token, закрывает assignment, не удаляет Character-owned данные. Проверенные ответы removed/unknown credential не позволяют получить ресурсы через mutation. Доступ к full Journal и новым read-state изменениям historical token не расширен.

## Archive/backup findings

### Campaign archive

- Текущий формат v11. Перенесены Campaign, lifecycle Sessions/Players/assignments, Character profile/traits/fields, Notes metadata, catalog/inventory/equipment, Knowledge/Facts/reveals и safe Activity details.
- Runtime round-trip проверил remap Character/assignment/Knowledge references, архивное состояние, historical removed/released timestamps, количество предметов и metadata. Activity history сохранена с remapped entity references; `campaign_imported` закономерно добавляет новое событие.
- Импортированные active Sessions и planned Sessions с игроками становятся historical ended; продолжение идёт новой Session. Старые player/join secrets не переносятся. Это защищает от недоступного случайного credential и конфликта имени при продолжении.
- Штатные выполненные fixtures покрывают v1-v8, дополнительные v9 и v10 conversions; legacy lifecycle defaults `null`. Это representative converted fixtures, не набор независимых архивов из каждой выпущенной версии приложения.
- Исторический `sourceInventoryItemId` события - opaque provenance, а не обязательный FK к существующей строке: полный discard мог её удалить. Domain entity references remap'ятся; operation receipt IDs не переносятся как действующие credentials/requests.
- Read-state не входит в campaign export по текущей политике; backup сохраняет его. Экспорт не включает token hashes, join tokens, DM key. Activity whitelist не переносит profile/note body.
- 10002-row archive DB/HTTP tests прошли без обрезания. 64 MiB policy общая для export/import; normal JSON limit 64 KiB. Invalid reference import транзакционно отклоняется без partial campaign. Исправленные reveal-ID assertions не зависят от UUID order.

### SQLite backup

- Current backup round-trip сохранил Activity, archive/lifecycle, profile, notes, inventory, Knowledge и read-state; uploads sentinel тоже восстановлен.
- Pre-0014/pre-0016 source snapshots мигрированы во временных копиях до сравнения schema, включая indexes/constraints. Оригиналы не менялись.
- FK-invalid source backup отклонён до замены healthy live state; контрольная campaign сохранилась, health остался `true`, source bytes не изменились.
- Domain-invalid source с валидными FK принят: **F1**, приоритет исправления restore boundary.
- Download timeout/retry покрыт runtime tests настоящего DM workspace: созданный backup ID сохраняется, повтор download не создаёт новый POST backup. Проверялись отдельно hanging headers/body, безопасные HTTP ошибки и освобождение busy.
- Нормальный DB restore транзакционен; между SQLite и файловыми rename нет общей атомарной транзакции. Текущий safety/rollback путь проверен в обычных сценариях, filesystem fault injection остаётся Needs investigation 1.

## UI state findings

- Phase 5C.2 Profile regression tests исполняют сохранность всех drafts/trait input при polling, cancel из newest canonical state, failed save и success save. Last submitted draft wins остаётся принятой v1 семантикой, не объявлен новой ошибкой.
- Journal merge tests исполняют pagination при равных timestamps, dedup, tail cursor, multi-page head burst, оба порядка loadMore/head completion, leaving/reopening и late response rejection.
- После Knowledge revoke текущий safe projection немедленно фильтрует старые Journal rows/detail, даже если приходит старый head response. Проверено независимое summary/fact access и current title. Нового чтения hidden body/summary/target через эти сценарии не обнаружено.
- KnowledgePage выводит detail только по записи из актуального Player-safe списка; пустые sections и media placeholders не расширяют серверную модель.
- Home digest и pinned Notes остаются ограниченными текущим безопасным state. Автоматический polling/открытие detail не двигает read-state; явный mark-seen переживает новую Session вместе с Character.
- Inventory selections основаны на актуальном item ID; если строка исчезла, detail не остаётся привязанным к несуществующему item. Persisted pending intents дают replay после full-stack disappearance/remount.
- Registry сохраняет ID при network/timeout/408/500 и failed refresh; 400/403/404/409 очищают определённо отклонённый request. В runtime-пробе повторно проверены эти шесть HTTP статусов, network+reload и fail-closed лимит 20. Штатные tests проверяют changed quantity/recipient/item, corruption и unavailable storage.
- F2/F3/F4/F5 остаются реальными UI/network-state gaps. Их нельзя считать закрытыми только потому, что source-level layout assertions зелёные.
- Exact mobile viewport, focus trap, keyboard-only overlay interaction, scroll position и real-device network не проверялись браузером в этой фазе. Hook/runtime checks не подменяют такую проверку.

## Test-suite quality findings

1. **Confirmed portability failure:** F7, локальная дата и TZ=Pacific/Kiritimati. Основной прогон зелёный; дополнительный timezone-specific запуск красный по ожидаемому воспроизведению.
2. **Order assumptions:** проверены исправленные multi-reveal assertions: server сравнивает отсортированные ID; DB corruption выбирает reveal по audience. Оставшиеся рассмотренные `[0]` в reveal fixtures относятся к единственной подходящей строке. Нового доказанного UUID-order flake не найдено.
3. **Сильное coverage:** реальные TEMP SQLite migrations/restore/import, Fastify endpoints, authorization, transaction rollback и persisted intents. Эти tests исполняют поведение, а не только source strings.
4. **Граница web harness:** `apps/web/test/helpers/runtime.mjs` честно исполняет handlers/effects, но самостоятельно моделирует hooks, batching и cleanup. Он не рендерит автоматически все дочерние компоненты, не выполняет browser constraint validation, React concurrent scheduling, DOM focus/layout/inert. Например, impact F2 потребовал отдельно вызвать render дочернего `TransferDetails`. Нельзя называть этот слой полноценным browser smoke.
5. **Source assertions:** часть Visual Lab и production layout tests проверяет regex/source/CSS. Они полезны как guardrails, но не доказывают наличие работающей формы, отсутствие horizontal overflow или корректный retry. F2-F5 демонстрируют отсутствующие behavioral cases, а не доказывают, что все такие tests «фальшивые».
6. **Timers:** в network-safety tests есть короткие реальные таймеры и ожидание 20 ms. Ложное прохождение/падение в текущем запуске не воспроизведено; для дальнейшего усиления лучше управляемые deferred responses/timers. Не включено в confirmed findings.
7. **Платформы:** текущий audit выполнен на Windows/Node 24, CI baseline зелёный на Ubuntu/Node 24. Изолированные tests используют `tmpdir`/path APIs; рабочая БД для них не нужна. Полной OS/timezone matrix и реального телефона этот audit не заменяет.
8. **Dead/contradictory paths:** production Quest/QuestStatus types отсутствуют. `quest` встречается закономерно в legacy taxonomy mapping/fixtures, не как действующая игровая механика. Null-catalog compatibility и older archive branches ещё нужны. Все зарегистрированные Activity types не обязаны быть Player-facing: DM/admin events намеренно фильтруются. Исторические design/audit snapshots не переписывались под main; актуальные решения определяют AGENTS и код.

## Full smoke result

**PASS**, дополнительный связанный workflow на TEMP SQLite/Fastify, не отдельный набор несвязанных mocks:

1. Создать Campaign и Mira/Rowan.
2. Создать и активировать Session 1.
3. Подключить A/B с разными credentials и одобрить назначения.
4. Изменить profile/traits/appearance/quote; создать pinned Personal Note.
5. Создать campaign profile field и значение Mira.
6. Создать Knowledge summary, персонально открыть summary и Fact; hidden sentinel не присутствует в Player JSON.
7. Выдать нож и stack расходника; экипировать/снять нож.
8. Передать часть stack Rowan, повторить тот же operationId без второго эффекта; частично выбросить предмет.
9. Получить Journal с limit=2, явно отметить актуальное событие просмотренным.
10. Завершить Session 1, проверить принятое historical read; удалить A, проверить 401 старого token.
11. Создать Session 2, заново подключить A с новым credential/тем же именем, назначить Mira.
12. Проверить сохранение profile, traits, fields, notes, inventory, summary/facts и read-state; `newActivity` не сброшен в непрочитанное.
13. Завершить Session 2; удалить Session 1 как tombstone, проверить historical refs.
14. Архивировать Rowan; архивировать/восстановить Mira, повторить restore и сравнить normalized Character.
15. Export/import v11: новые IDs, сохранённые исторические связи и archived state, отсутствие исходных secrets. В исходной кампании 33 события; в импортированной 34 с учётом `campaign_imported`.
16. Создать backup с TEMP uploads sentinel, изменить live state/uploads, восстановить backup; контрольная поздняя campaign исчезла как ожидаемый результат restore, файлы вернулись, source backup bytes совпали.
17. Проверить health и SQLite, закрыть app/connection, повторно открыть ту же TEMP-БД и проверить persistent Character state.

Эти группы соответствуют всем 29 действиям checklist задания; additionally выполнен restart. Финально: `integrity_check = ok`, `foreign_key_check` - 0 строк. Изолированные probe-каталоги удалены. Рабочие данные не использованы.

Сохранились Character identity/profile/traits/fields, инвентарь/экипировка, Knowledge/Facts, Notes, Activity и lifecycle. Read-state сохранился между Session и в backup, но намеренно не добавлен в campaign archive.

## Checks

| Проверка | Результат |
|---|---|
| `pnpm typecheck` | PASS, exit 0. |
| `pnpm test` | PASS, 206/206: database 72, server 39, web 95; fail 0. |
| `pnpm build` | PASS, exit 0; все workspace build targets завершены. |
| `git diff --check` | PASS, exit 0; новый untracked документ дополнительно проверен через `git diff --no-index --check` против пустого файла: whitespace diagnostics отсутствуют, exit 1 означает различие файлов в no-index режиме. |
| Lint/дополнительные validation scripts | Отдельных применимых scripts не найдено; tooling не добавлялся. `db:migrate` намеренно не запускался против рабочей БД. |
| Дополнительный TZ runtime test | EXPECTED FAIL как воспроизведение F7: 0/1 pass при UTC+14. Не скрыт за общим результатом `pnpm test`. |
| Migration probes | Empty/pre-0014/pre-0016 -> 0016 PASS; 17 migration rows, integrity ok, FK 0. |
| Archive/backup normal smoke | PASS; отдельный domain-negative restore воспроизвёл F1. |
| Product/test/schema changes | Нет. Только этот audit document. |
| HEAD после работы | `44bab37c8485569b4b7ef38d55aff13567550b9f`. |
| Commit/push | Не выполнялись. |

## Conclusion

Фундамент persistent Character, session/player cleanup, safe Knowledge/Activity projections, inventory idempotency и migration/archive compatibility выдержал выполненную регрессию. Подтверждённых новых authorization bypass, hidden Knowledge text leakage и half-written обычных domain transactions не найдено.

При этом зелёные 206 тестов не закрывают restore domain-validation gap, failed-success body parsing, duplicate note create и DM polling starvation. Есть также две ограниченные contract/UI проблемы и один воспроизводимый timezone-sensitive test. Необратимая потеря данных не доказана; F1 показывает recoverable replacement здоровой live-БД некорректным backup, F3 - постоянные дубликаты.

Рекомендуемый порядок отдельной repair-фазы: F1, F2/F3/F4, затем F5/F6/F7; каждое исправление с regression test по приведённому воспроизведению. В рамках этого audit ни одно исправление не выполнялось. К Media и другим фазам работа не переходила.
