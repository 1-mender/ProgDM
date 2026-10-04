# Phase 3B — Knowledge Facts & Progressive Reveal

Статус: design spike, не production-спецификация для немедленного слияния
Проверено: 2026-10-04
Ветка: `main`
Проверенный HEAD исходного аудита: `82ac15ecb8a371ab8122e40f2901703c10f5b03f`
GitHub Actions: [CI для проверенного main](https://github.com/1-mender/ProgDM/actions/runs/37168242823) — успешно.

Документ описывает модель Progressive Reveal. Изменения кода, БД, API и UI в рамках spike не выполнялись. В исходном аудите GitHub API подтвердил SHA ветки `main`; обычный `git fetch` был недоступен из-за read-only `.git/FETCH_HEAD`. Рабочая база и миграции не запускались.

## 1. Краткий вывод

Текущая запись знания — единый текст `description` с одним текущим доступом `hidden | party | character`. Этого достаточно для простого открытия целой записи, но недостаточно для независимых фрагментов, разных аудиторий, сохранения фактов между сессиями и корректной хроники отдельных раскрытий.

Рекомендуется сохранить `KnowledgeEntry` как необязательную простую запись и добавить две campaign-scoped сущности:

- `KnowledgeFact` — упорядоченный фрагмент знания, принадлежащий записи;
- `KnowledgeFactReveal` — текущая выдача доступа к одному факту всей партии либо одному постоянному персонажу.

`Player` и токены в долгосрочные знания не попадают. Открытие краткого описания и выдача фактов — независимые команды. Выдача всех фактов создаёт grants только для выбранной аудитории и не меняет `KnowledgeEntry.visibility`. Факты, добавленные позднее, автоматически не раскрываются.

### Главная неоднозначность и предлагаемое решение

Скалярное `knowledge_entries.visibility` не может одновременно представлять, например, разные факты Mira и Rowan. Не следует использовать его как общий переключатель, который неявно раскрывает или скрывает все факты.

Предлагаемая семантика:

- Запись **без фактов** сохраняет прежнее поведение: `visibility` открывает или скрывает всю простую запись.
- Запись **с фактами**: `visibility` управляет доступом к заголовку/категории/краткому описанию; факты открываются только отдельными выдачами. Если персонажу открыт факт, он получает заголовок и категорию записи, но не краткое описание, пока описание отдельно не открыто ему.
- Команды summary остаются прежними: `hidden / party / character`. Они меняют только доступ к простому Entry summary/description.
- Факты открываются отдельными действиями: «Открыть следующий факт», «Открыть выбранный факт», «Открыть все факты». В v1 нет комбинированного действия, которое одновременно меняет summary visibility и создаёт fact grants.
- «Открыть все факты персонажу» создаёт character grants для всех текущих фактов этому Character, но не меняет `visibleToCharacterId` и не открывает ему summary.
- «Скрыть описание» не отзывает fact grants. Для коррекции доступа используется отдельный «Отозвать доступ»; UI не должен называть сокрытие summary «Скрыть запись», если открытые факты останутся видны.

Это сохраняет простые записи, допускает несколько персонажей-получателей и не превращает запись в неясную смесь двух источников доступа. Альтернатива — полностью заменить текущую видимость grants-системой и мигрировать все текущие доступы в неё. Это гибче, но заметно расширяет scope; для первого шага не рекомендуется.

## 2. Проверенное состояние

- Исходный аудит выполнен на `main` `82ac15e`; этот SHA и зелёный CI подтверждены GitHub API. Настоящее уточнение продукта выполняется в текущем checkout; HEAD зафиксирован в отчёте к этой правке.
- Phase 3A добавила шесть категорий: `character`, `place`, `creature`, `item`, `event`, `fact`.
- `knowledge_entries` хранит `id`, `campaign_id`, `category`, `title`, `description`, `visibility`, `visible_to_character_id`, `created_at`. `description` ограничено 2000 символами; запись по умолчанию скрыта.
- Допустимые видимости: `hidden`, `party`, `character`. Для `character` требуется `visible_to_character_id`; для остальных он должен быть пуст.
- `characters` имеет составной unique key `(id, campaign_id)`. У `sessions` сейчас нет такого составного unique key; его потребуется добавить для строгих campaign-scoped FK на session metadata.
- Связи персонажа с игроком хранятся в `session_character_assignments`; постоянная сущность — Character, Player — сессионный.
- `campaign_activity` — append-only журнал; у него уже есть типизированные ссылки на кампанию, сессию, игрока, персонажа, предмет каталога и запись знания, а детали — JSON payload. События знания сейчас: `knowledge_created`, `knowledge_visibility_changed`.
- Player получает единый `GET /api/player/me`. Сервер фильтрует знания по партии/назначенному персонажу, не отдаёт hidden entries. Historical token сохраняет существующую read-семантику, но мутации защищаются approved + active session + assignment guard.
- DM Knowledge workspace уже имеет поиск по названию, список и панель выбранной записи. При подготовке создаётся скрытая запись; в live доступны действия «Открыть партии», «Открыть [выбранному персонажу]», «Скрыть», плюс выбор конкретного персонажа.
- Player Knowledge показывает статью и описание. Player Journal/Home получают отфильтрованный `recentActivity`/`newActivity`; строка текущего открытия знания описывает всю запись, а не отдельный фрагмент.
- Campaign export format сейчас v7, import принимает v1–v7. Knowledge и campaign activity ID remap-ятся; player token hashes и секреты не экспортируются.
- Backup использует явный список таблиц, а restore staged-копию мигрирует и проверяет целостность до замены рабочей БД. Новые таблицы нужно добавить в список backup/restore.
- Data Health проверяет SQLite/FK, миграции и некоторые межкампанийные связи. Новых фактов и выдач она пока не знает.

## 3. Предметная модель и семантика доступа

### KnowledgeEntry

Остаётся самостоятельной сущностью:

- `id`, `campaignId`, `category`, `title`, `description` (краткое описание), `visibility`, `visibleToCharacterId`, `createdAt`;
- запись без фактов продолжает работать ровно как сейчас;
- наличие нуля фактов — нормальный и поддерживаемый режим, а не ошибка.

Описание должно быть кратким контекстом «что это», а не контейнером для накопленных игровых открытий. Игроку возвращается только если текущая видимость описания разрешает это его персонажу.

### KnowledgeFact

Каждый факт — отдельный текстовый фрагмент; title не нужен для первой версии:

- `id`, `campaignId`, `knowledgeEntryId`;
- `body` — текст факта, 1–2000 символов после trim;
- `position` — целое число от 0 для порядка показа и выбора следующего факта;
- `createdAt`, `updatedAt`.

Рекомендация: вводить/редактировать факты только ведущему. Не добавлять rich text, вложения, формулы или отдельные факты игрока.

### KnowledgeFactReveal

Это текущий доступ, а не журнал и не копия факта:

- `id`, `campaignId`, `knowledgeFactId`;
- `audience`: `party | character`;
- `characterId`: null для `party`, обязательный для `character`;
- `sessionId`: ID активной сессии в момент открытия либо null при подготовке;
- `createdAt`.

Party-grant один на факт и означает campaign-shared knowledge: действует для всей кампании, переживает смену сессии и доступен персонажам, которые будут назначены в будущих сессиях. Он не связан с Player. Character-grant один на пару факт/персонаж и переживает нового Player/token и новые сессии, но виден только этому Character. Никаких `playerId`, токенов или token hashes в этой модели нет.

Grant можно отозвать как correction/admin operation; удаление grant не удаляет факт и не переписывает `campaign_activity`. Это не игровая механика забывания: уже увиденное игроком невозможно стереть из памяти или с его устройства. После reveal основной live workflow может показать короткое Undo; расширенное управление DM может содержать «Отозвать доступ». Revoke не является главным действием Knowledge UI. Если факт удалён ведущим, зависимые grants удаляются каскадно, а запись события остаётся. Порядок фактов меняется в preparation; перестановка уже открытых фактов не меняет их доступ.

### Правило выдачи Player

Для текущего назначения персонажа сервер возвращает:

1. Заголовок и категорию, если персонажу открыт Entry summary **или** ему доступен хотя бы один факт.
2. Краткое описание только при разрешённой entry visibility.
3. Только те факты, для которых есть party grant либо character grant именно назначенному Character.
4. Никаких нераскрытых текстов, количества закрытых фактов, внутренних target IDs, DM notes или чужих character grants.

Наличие раскрытого факта может сделать видимым родительский title/category, но не открывает summary или соседние факты. Ответ лучше оформить отдельной player-safe projection, например `summary: string | null`, `facts: RevealedKnowledgeFact[]`; не отдавать сырой `KnowledgeEntry` с будущими внутренними таблицами.

## 4. Действия ведущего и число кликов

### Обычный live-сценарий

1. Поиск остаётся в текущем Knowledge workspace; поиск по title можно расширить до краткого description, но это не обязательная часть domain-модели.
2. Ведущий выбирает запись. Центральная область показывает краткое описание, список фактов и их доступ.
3. Рядом с записью — одно основное действие **«Открыть следующий факт партии»**. Если запись выбрана и есть закрытые факты, один tap создаёт grant и событие. Это обычный сценарий в один клик после выбора записи.

Next определяется как первый по `(position, id)` факт, для которого у выбранной audience ещё нет grant. Для party audience наличие character grant не считается выдачей партии, поэтому такой факт может быть следующим для партии. Обратное тоже верно: наличие party grant не блокирует адресную команду для Character, но Player projection получает факт через party grant и не создаёт дублирующую character row. Повторный reveal той же audience не создаёт duplicate grant или Activity event.

### Меню «•••» / редкие действия

- «Открыть факт персонажу» → выбрать факт и Character. В подготовке доступен любой неархивный Character этой Campaign; в live быстром выборе предпочтительны Character активной Session. Хранится Character ID, не ID текущего Player.
- «Открыть все факты партии» / «персонажу» → одна транзакция создаёт fact grants выбранной audience для всех существующих фактов. Для character-аудитории нужен конкретный Character. `Entry.visibility` и summary не меняются. Комбинированная convenience-команда может быть рассмотрена позднее, но не входит в Phase 3B v1.
- «Открыть выбранный факт» → выбор партии или персонажа.
- «Отозвать доступ» → удалить выбранный grant как correction/admin operation. Исторический event сохраняется; действие не означает, что персонаж забыл факт.
- Подготовка: создать, исправить, удалить и переместить факты. Архивирование/удаление знания — отдельное решение; не добавлять сложное управление версиями.

Выдача конкретному персонажу потребует выбора адресата, если он не выбран контекстом. Удобно использовать уже выбранный Character в DM workspace; в ином случае раскрывающее меню с выбором добавляет ещё один tap. Не следует показывать неактивных/архивных персонажей для новой выдачи.

### Создание фактов и смена порядка

- Первоначальный порядок задаёт ведущий; `position` и `id` дают детерминированный tie-breaker.
- Для маленьких списков достаточно действий «Выше / Ниже»; drag-and-drop не нужен.
- Если факты открывались не по порядку, это допустимо: Player видит все доступные ему факты в текущем редакционном порядке, а отметка «Открыто» относится к каждому факту отдельно.
- После переупорядочивания «следующий» выбирает первый ещё не выданный аудитории факт по новому порядку. Уже раскрытые записи не сбрасываются.
- Удаление уже раскрытого факта необратимо убирает его текст из текущего Player state, но событие раскрытия остаётся историческим. UI подготовки должен предупреждать, что удаление не удаляет историю действия.

## 5. Сессия, журнал, «Новое» и доступ

При выдаче сервер сам берёт активную сессию кампании и пишет её ID в grant. Если активной сессии нет (подготовка), `sessionId = null`; не создавать фиктивную сессию и не подменять его будущей. Grant остаётся campaign/character scoped, поэтому доступ переживает завершение сессии.

### События

Предлагается добавить:

- `knowledge_fact_revealed` — одна команда/операция, с `knowledgeEntryId`, `characterId` только для адресной выдачи, `sessionId` активной сессии или null, количеством фактов и аудиторией в безопасном payload;
- `knowledge_fact_access_revoked` — correction/admin revoke одного или нескольких grants, без содержимого фактов. Это не событие «персонаж забыл».

Команда «Открыть все факты» записывается одним событием с `factCount` и выбранной audience, а не одним событием на каждый факт. Обычное «следующий факт» — одно событие с `factCount=1`. Revoke пишет отдельное correction-событие. В payload не писать body факта, закрытый текст, секреты, токены или hash. Не класть массив fact IDs в произвольный JSON: текущий Activity типизированно ссылается на Entry, этого достаточно для хроники и remap.

Состояние grant и Activity выполняются в одной транзакции. Event append-only; grant — текущая ACL и может быть удалён при отзыве. Для существующего `knowledge_visibility_changed` сохранить текущую семантику простых записей; не переиспользовать его для фактических раскрытий.

### Player Journal и Home

- Journal показывает только события открытия, адресованные партии или персонажу, которым сейчас управляет этот Player. Фильтрация делается на сервере до формирования Player projection.
- Простой Player-текст: «Узнали новое о [название записи]» / «Открыта новая деталь: [название записи]». Для адресного открытия — аналогично без указания чужого персонажа.
- Не показывать body скрытых/уже удалённых фактов в Chronicle; Activity остаётся журналом действий, а не копией контента.
- Несколько раскрытий одной записи за короткий промежуток агрегировать в Home digest. «Новое» показывает не более трёх digest-строк, а не по одной на каждый факт; подробные события остаются в Journal.
- `characterReadState` остаётся character-scoped. Historical tokens сохраняют существующее read-поведение, но endpoint отметки просмотра и все новые reveal mutations требуют approved player + active session + текущего assignment.
- Не слать DM-only открытия игроку и не использовать прямой campaign activity feed для Player UI.

## 6. Рекомендуемая реляционная схема

Названия ниже — предложение для миграции, не утверждение, что таблицы уже существуют.

### `knowledge_facts`

| Поле | Правило |
|---|---|
| `id` | TEXT PK |
| `campaign_id` | NOT NULL, FK campaigns |
| `knowledge_entry_id` | NOT NULL, составной FK с campaign_id на Entry |
| `body` | NOT NULL, trim length 1..2000 |
| `position` | NOT NULL integer >= 0 |
| `created_at`, `updated_at` | NOT NULL ISO timestamp |

Индексы/ограничения:

- UNIQUE `(id, campaign_id)` для дочерних составных FK;
- UNIQUE `(knowledge_entry_id, position)` для стабильного порядка в записи;
- INDEX `(knowledge_entry_id, position, id)` для выборки;
- составной FK `(knowledge_entry_id,campaign_id)` → `knowledge_entries(id,campaign_id)` с `ON DELETE CASCADE`.

Для этого потребуется добавить UNIQUE `(id,campaign_id)` к `knowledge_entries`. Это additive constraint/index и позволяет SQLite гарантировать campaign consistency без условной проверки только в приложении.

### `knowledge_fact_reveals`

| Поле | Правило |
|---|---|
| `id` | TEXT PK |
| `campaign_id` | NOT NULL, FK campaigns |
| `knowledge_fact_id` | NOT NULL, составной FK к Fact |
| `audience` | CHECK: `party | character` |
| `character_id` | null для party, required для character |
| `session_id` | nullable, composite FK session/campaign |
| `created_at` | NOT NULL |

Ограничения:

- CHECK согласованности `audience` и `character_id`;
- UNIQUE `(id,campaign_id)` если последующие таблицы будут ссылаться на reveal;
- частичный UNIQUE `(knowledge_fact_id)` для `audience='party'`;
- частичный UNIQUE `(knowledge_fact_id,character_id)` для `audience='character'`;
- составной FK `(knowledge_fact_id,campaign_id)` → `knowledge_facts(id,campaign_id)` с cascade;
- составной FK `(character_id,campaign_id)` → `characters(id,campaign_id)` с cascade;
- составной FK `(session_id,campaign_id)` → `sessions(id,campaign_id)` с `ON DELETE RESTRICT`: сессии являются историческими сущностями и не должны удаляться ради очистки ссылки. Не использовать составной `SET NULL`: SQLite обнулит также обязательный `campaign_id`. Если политика удаления сессий когда-либо изменится, отдельно спроектировать nullable session reference, не ослабляя campaign FK.

Для строгого session FK добавить UNIQUE `(id,campaign_id)` к `sessions`; в текущей схеме его нет. Даже с составным FK write API всё равно проверяет campaign/session consistency, а Health сообщает об ошибках legacy/imported data.

Partial indexes гарантируют идемпотентность. Открытие «следующего» выполняет выбор невыданного факта и insert внутри одной transaction. Конфликт уникальности интерпретируется как уже открыт, а не как ошибка; операция может безопасно повториться.

Не сохранять отдельную таблицу `PlayerKnowledgeFacts`: Player — временный адрес доставки, а не владелец знаний.

## 7. API, полномочия и конкурентность

Текущие DM-only операции остаются защищёнными Bearer DM key. Рекомендуемое расширение — существующие Knowledge routes, не параллельная подсистема:

- DM reads возвращают Entry + ordered Facts + текущие audience grants для интерфейса ведущего.
- DM mutations: CRUD/reorder фактов, reveal-next, reveal selected fact, reveal-all-to-scope, revoke reveal. Каждая проверяет DM доступ и campaign consistency.
- Player API остаётся одним safe projection `/api/player/me`; возвращает только разрешённые факты текущего Character.
- Не добавлять Player fact write endpoint.

Все Player read permissions вычисляются из существующего session assignment, а не `characterId` из запроса. Для любых будущих Player mutations (на этом этапе их нет) обязательно `approved + active session + current assignment + campaign consistency`. Historical token не может открывать/скрывать факт, менять выдачи или менять read-state.

У двух одновременных DM tabs операция next должна не создать один grant дважды и не “пропустить” два факта из-за гонки. Уникальные индексы + атомарная DB transaction — источник гарантии. HTTP response возвращает факт, фактически выданный этой операцией либо сообщает, что список уже открыт целиком.

## 8. Export/import и backup/restore

### Campaign archive

Текущий format — v7. Предлагаемый bump: v8.

Экспортировать:

- факты со стабильным порядком и временем;
- текущие факт grants (audience, Character target, раскрывающая Session, createdAt);
- типизированные новые Activity events без секретных данных.

Import v1–v7 остаётся валидным: у записи нет facts/grants, текущее `visibility` продолжает работать. При v8 импортировать сначала Campaign/Character/Session/Entry, затем Facts, затем Grants и Activity; remap всех ID по typed reference maps. `characterId`, `sessionId`, `knowledgeEntryId`, `knowledgeFactId` должны ссылаться только на remapped rows внутри импортируемой кампании. Не remap произвольный JSON рекурсивно.

Не экспортировать player token/hash, DM key или player read cursor. Если импортированная текущая сессия по существующей политике становится исторической/завершённой, факты и выдачи всё равно переносятся; продолжение знания происходит в новой сессии.

### Полный backup

SQLite backup автоматически содержит новые данные только если обе таблицы явно включены в `backupTables` и staged restore умеет мигрировать старую схему. Backup/restore должен сохранять Facts, grants и campaign activity в одном consistent snapshot. Restore старых поддерживаемых backups проходит staged migrations до установки; исходный backup остаётся неизменным.

## 9. Data Health

Добавить только проверки, которые DB constraints/миграции не гарантируют полностью:

- все Facts имеют валидные campaign/Entry связи;
- `body` trim length 1..2000, `position >= 0`, нет повторов позиции внутри Entry;
- grants ссылаются на существующий Fact того же campaign;
- `party` grant без `characterId`; `character` grant с существующим Character той же campaign;
- nullable `sessionId`, если задан, относится к той же campaign;
- уникальность grants (партия один раз на факт, персонаж один раз на факт);
- никаких grants на удалённые/несогласованные данные после export/import.

Неразрешённые проверки должны возвращать структурированное понятное сообщение, не stack trace. Health ничего не удаляет, не исправляет grants и не придумывает доступ.

## 10. Миграция и совместимость

Предварительный номер следующей Drizzle migration: **0013** (текущий последний — 0012). Это будет additive migration: новые таблицы и индексы/composite unique индексы; существующие Entry и их данные не переписываются. Фактов у старых записей нет, поэтому искусственные факты из description не создавать.

Открытые legacy записи остаются видны согласно текущему `visibility`; у них пустой список Facts. Никаких старых event задним числом не создавать. Если Entry добавляет факты позже, все новые факты закрыты по умолчанию, даже если краткое описание уже было открыто ранее.

Порядок migration должен учитывать SQLite FK, уникальные индексы и текущий staged backup migration flow. Нужны fixture до 0013, migration, проверка старых visibility/description/IDs, integrity/FK и повторная проверка staged restore.

## 11. Этапы реализации после утверждения

1. **3B1 — Domain Foundation:** migration, shared types, DB APIs, reveal semantics, export/import, backup/restore, Data Health и runtime tests.
2. **3B2 — DM Facts Preparation:** CRUD facts и изменение порядка; простые Entries без Facts продолжают работать.
3. **3B3 — DM Live Reveal:** reveal next, selected fact, all facts, party/character и correction/revoke.
4. **3B4 — Player Knowledge:** безопасная проекция summary + revealed facts и metadata.
5. **3B5 — Journal/Home integration:** безопасная проекция activity, агрегация и защита от утечки закрытого текста.

Сначала завершать каждую фазу с DB/API/integration/export/restore tests. Не смешивать всё с большим переписыванием `App.tsx` или `PlayerWorkspace.tsx`; выделять компоненты только под конкретный экран/операцию, если это нужно для узкой реализации.

## 12. Обязательные тесты до production

- Entry без Facts работает как до Phase 3B; старые visibility semantics не изменились.
- Legacy DB до 0013 мигрирует без потери Entry, description, category, visibility, target Character и event history.
- Создание/редактирование/порядок Fact сохраняются; новые Facts закрыты по умолчанию.
- Party reveal campaign-shared: доступен всем текущим и будущим Character кампании; character reveal — только этому Character, включая новую сессию с новым Player/token.
- Revealed Fact показывает заголовок/категорию, но не hidden summary; нераскрытые соседние facts никогда не входят в player state.
- Один Character не может получить grant другой кампании; несовпадающие Session/Campaign отклоняются.
- «Следующий факт» выбирает первый факт без grant именно для выбранной audience по `(position,id)`. Party grant и Character grant независимы; Player projection объединяет оба источника без дублирования факта. Повтор reveal той же audience не создаёт duplicate grant/activity.
- «Открыть все факты» атомарно создаёт недостающие grants выбранной audience и не меняет Entry summary visibility; сбой транзакции оставляет grants и Activity прежними.
- Revoke убирает grant из текущего player state, не удаляя Activity; сокрытие summary не скрывает независимо открытые facts. Проверить Undo и correction event без текста факта.
- Historical token может читать по существующей политике, но не может менять факты/grants; pending/rejected не читают новые player-private facts.
- Персональные факты другого персонажа не попадают в чужой Home/Journal; party facts доступны назначенному Character.
- Activity не содержит fact body, token/hash или нераскрытый текст; Player Journal не раскрывает DM-only events.
- Home digest агрегирует несколько открытий и остаётся в лимите 3; read-state character-scoped.
- Export v8 round-trip Facts, order, grants и activity refs; v1–v7 импортируются без Facts; все ID remap корректны; player secrets отсутствуют.
- Full backup включает обе таблицы; текущий backup round-trip; старый backup staged-migrate; исходный backup неизменён.
- Data Health ловит invalid length/position, cross-campaign IDs и повреждённые grants без auto-repair.

## 13. Риски и продуктовые решения

1. **Смысл текущего `visibility` для Fact-enabled Entry — утверждено.** Оно меняет только summary/description. Fact grants независимы. «Открыть все факты» не открывает summary; комбинированная команда в v1 отсутствует.
2. **Revoke — утверждено как correction/admin operation.** Может быть короткий Undo после reveal и расширенное DM-действие «Отозвать доступ». Это не механика забывания и не основное действие UI; Activity/history сохраняется.
3. **Party semantics — утверждено.** Party grant — общая память Campaign для текущих и будущих назначенных персонажей, а не для отдельных Player.
4. **Перемещение после раскрытия.** Рекомендация: разрешать. Порядок на Player экране — текущий редакционный порядок; события фиксируют момент открытия, но не snapshot позиции.
5. **Пределы фактов.** Предлагаются 1–2000 символов на факт и разумный верхний лимит количества (например 100 на запись) только если UX/производительность подтвердят его необходимость. Не вводить произвольный маленький лимит без продуктовой причины.
6. **Удаление факта.** Физически удалить текст и grants каскадом, сохранить агрегатное Activity событие без копии факта. Если нужен точный неизменный текст исторического факта, это отдельная versioning feature и не входит в этот scope.
7. **Контекст адресата.** Для адресного live reveal желательно заранее иметь выбранного Character; иначе вторичное действие потребует выбора персонажа. Не отправлять игроку список закрытых фактов и не раскрывать ему, кому ещё они открыты.
8. **Пустая активная сессия.** Разрешать подготовительное открытие с `sessionId=null`; явно отличать его от live reveal в DM истории, не подменять будущей сессией.

## 14. Вне scope

Квестовая система, задачи, combat/HP/инициатива, граф отношений, AI-summary, Obsidian sync, media/uploads, rich text, attachments, player-authored facts, realtime/Socket.IO, новая система уведомлений и дополнительные игры не нужны для этой модели.

## 15. Рекомендация

Продуктовые решения по независимости summary/facts, party scope и revoke подтверждены. Следующий шаг — отдельное разрешение начать Phase 3B1; этот документ сам по себе не авторизует implementation. Предложенное разделение Entry summary и audience-scoped Fact grant сохраняет простые записи, обеспечивает быстрый «следующий факт», переносит знания вместе с персонажем/кампанией и не делает временного Player владельцем постоянных знаний.
