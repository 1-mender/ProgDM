# Аудит разрыва между Visual Lab и production Player UI

Дата аудита: 2026-10-04\
Проверенная ветка: `main`\
HEAD: `baa08bcb11f11b51e3d360184a395523e4c15275`\
GitHub Actions: [последний запуск CI для main](https://github.com/1-mender/ProgDM/actions/runs/37160273890) — завершён успешно на том же SHA.

Это аудит и план, не спецификация немедленной реализации. Visual Lab здесь рассматривается как UX/UI-спецификация, а не production-контракт. На этом этапе не меняются схема, API, production Player UI и зависимости.

## 1. Текущее состояние

Проверены `JoinPage.tsx`, исходники `visual-lab`, серверные маршруты, `packages/shared`, схема и миграции базы, database/game-engine packages и database/server/web tests. Ветку `main` обновлено через fetch; она уже совпадала с `origin/main`. Рабочее дерево до создания этого документа было чистым. Рабочие данные и миграции не запускались и не изменялись.

Production имеет одну большую `JoinPage.tsx` с пятью основными разделами. Игрок получает единый `/api/player/me` snapshot; фоновые обновления делают данные актуальными. Есть профиль, базовый инвентарь, видимые знания, хроника из выбранных activity events, личные заметки, отметка просмотра и пять пунктов нижней навигации. Серверная проверка DM отделена от player-token. У игрока нет production API экипировки, передачи или выбрасывания предметов.

База на миграции 0008 содержит постоянных персонажей кампании, назначения на сессии, инвентарь и заметки на персонажа, read marker на персонажа, четыре legacy-категории знания и журнал `campaign_activity`. Campaign export сейчас version 3; он переносит историю, архивность, профиль, заметки, каталог/инвентарь и знания с remap ID, но намеренно не переносит token hashes, join secrets или read-state. SQLite backup включает все таблицы и uploads; restore мигрирует staged-копию до установки и проверяет integrity/FK. Data Health проверяет SQLite, миграции, стандартные каталоги, часть доменных связей и явно помечает проверку upload-ссылок как пропущенную.

Уровни приоритета: **BLOCKER** — нельзя безопасно реализовать соответствующий сценарий до закрытия; **HIGH** — существенная модель/API/безопасность gap; **MEDIUM** — нужен для полного UX, но не блокирует чтение базового экрана; **LOW** — полировка/опциональная детализация; **DEFER** — вне ближайшего переноса.

| Раздел | Visual Lab | Production UI / DB | API и доступ | Activity / перенос / Health | Тесты, работа, риск, фаза |
|---|---|---|---|---|---|
| Главная | Персонаж-hero; до нескольких новых событий с read state; закреплённые заметки | UI уже есть, но без portrait; `characterReadState` и `newActivity` строятся от текущего назначения персонажа; notes существуют только как body без pin | `GET /api/player/me`; `POST /api/player/activity/seen`; read mutation уже требует active approved assignment | read-state персонажа; export исключает, backup сохраняет; activity отбирается по персонажу и видимой записи знания | Закрепление **MEDIUM**; portrait **DEFER**; digest UI **LOW**. DB-тест текущего маркера есть. Фаза 1/2 |
| Инвентарь | Слоты снаряжения, вместимость сумки, карточки и detail; mock equip/unequip/transfer/drop | DB хранит только `name`, `quantity`, optional `catalogItemId`; каталог — только `name`; нет description/category/rarity/slots/equipment/capacity/permission flags; UI — простой список | DM: `POST /api/dm/characters/:id/items`, `POST /api/dm/campaigns/:id/items`; player только читает snapshot; мутаций игрока нет | `item_granted` уже append-only; export/import копирует базовые поля; backup автоматически включает SQLite. Health проверяет только cross-campaign каталога/владельца и orphan assignment | У equipment/capacity нет модели **BLOCKER** для полного inventory UX; доп. metadata **HIGH**; базовый read-only список можно переносить раньше. DB/API/health/export tests. Фаза 3 |
| Передача / выброс | Mock выбор количества/получателя, capacity feedback, confirm drop | Полностью отсутствуют | Нужны отдельные POST endpoints с current-session authorization | Один типизированный `item_transferred` с двумя character refs; `item_discarded`; события в export/import, DB backup; health проверяет refs. Не хранить выброшенный предмет отдельно | Текущих guards и атомарных операций нет **BLOCKER**; транзакционная реализация и auth/integration tests обязательны. Фаза 4 |
| Знания | Шесть общих категорий, поиск, статья, необязательное изображение, «Новое» | `knowledge_entries` имеет `npc/monster/note/quest`, title/description/visibility; UI раскрывает строку без детальной статьи/search/category nav | DM list/create/visibility routes; player state возвращает только hidden-исключённые party/character записи | Activity `knowledge_created`, `knowledge_visibility_changed`; export/import v3 remaps `visibleToCharacterId`; backup мигрируется; health проверяет character/campaign consistency | Категории **HIGH** для утверждённого UI, но чтение legacy можно перенести по адаптеру раньше. Миграция с сохранением ID/visibility, import old versions, API/visibility tests. Фаза 1/2 |
| Журнал | Timeline с событиями и detail; вкладки Chronicle / личные заметки; mock interactive event | Production Chronicle — последние релевантные item grants и раскрытия знания, преобразованные из campaign activity; note body и CRUD есть; history по датам пока простой список | `/api/player/me` отдаёт `recentActivity`, `/api/player/notes*`; DM читает activity/notes. Нет отдельного player endpoint | Текущие events экспортируются/remap, notes body экспортируются; read-state только backup. Transfer/drop projection отсутствует; нельзя показывать campaign-wide log напрямую | UI/grouping **MEDIUM**; projection transfer **BLOCKER** для передачи; activity-фильтрация/security tests. Фаза 2/4 |
| Личные заметки | Заголовок, текст, marker, pin, максимум три pinned | `character_personal_notes`: body, createdAt, updatedAt; нет title/marker/pinned. DB/API разрешают создание/редактирование активному игроку; DM только читает. Принадлежат Character | `/api/player/notes` и `/:id` защищены активным assignment; DM GET. DM edit сейчас нет | `personal_note_created/updated` без body; export/import version 3 переносит body; backup сохраняет всё; нет отдельной note consistency health проверки сверх FK | Поля Visual Lab **HIGH**; текущую базовую заметку можно перенести. Решить право DM редактировать отдельно; рекомендовано оставить read-only для DM в первой итерации. Фаза 2 |
| Профиль | Hero + биография, черты, цель, сведения кампании, цитата, внешность | DB содержит name, shortDescription, archetype, origin, personalGoal, dmNotes; production показывает эти поля без portrait. Traits/custom fields/quote/appearance отсутствуют | DM `POST /api/dm/characters/:id/profile`; Player `POST /api/player/profile` принимает только shortDescription/personalGoal; DM-only `dmNotes` не попадает в player profile | Export/import v3 сохраняет текущие поля; backup автоматически; health проверяет profile lengths только SQL constraints, не JSON/custom data | Базовый профиль **LOW** gap; расширенные секции **HIGH** для полного утверждённого B3. Универсальные campaign fields нужны только после решения модели. Фаза 1 |

## 2. Главная

### Уже работает

`PlayerState` берёт имя, archetype, origin, short description и personal goal у Character. Главная в production показывает имя и archetype, до трёх `newActivity` и переход в журнал. Activity для игрока собирается только из `item_granted` для назначенного персонажа и `knowledge_visibility_changed` к видимому ему знанию либо всей party. Отметка просмотра хранится в `character_read_state(characterId, lastSeenAt, lastSeenId)`, поэтому переживает смену Player/session вместе с персонажем.

Запись read marker через `/api/player/activity/seen` вызывает `requireActivePlayerCharacter`: pending/rejected и исторический token завершённой сессии не могут обновить marker. ID события проверяется по текущей видимой хронике. Это ожидаемая граница; старый токен может сохранить прежнее чтение исторического инвентаря/знаний, но не новых приватных полей, новых mutations или read marker.

### Gap и решение

- Home digest можно собирать из текущего `newActivity`, но сейчас это именно небольшой выбранный digest, не полная универсальная проекция всех типов журнала. Для новых типов сначала определить recipient/character relevance и безопасный публичный текст.
- Visual Lab pinned notes не имеют backend-поля. Предлагаемая минимальная модель: `title`, `body`, enum `marker` (`ordinary/important/check/question`), `pinned` boolean. Ограничение «не более 3» проверять транзакционно при создании/обновлении pin, чтобы параллельные запросы не обходили лимит; оно относится к персонажу. Если пользователь предпочитает не ограничивать pinning в production, исключить лимит как чисто демонстрационное правило.
- Hero portrait — отдельная media-функция и не блокирует перенос Home. Не заменять mock-картинку удалённым URL и не тащить upload subsystem в этот этап.
- В Home допустим preview закреплённых заметок, но источник данных остаётся notes, а не копия заметок или отдельная таблица.

**Приоритеты:** базовый Home/read-state **LOW**; pinned notes **MEDIUM**; portrait **DEFER**.

## 3. Инвентарь

### Production-состояние

`catalog_items` — кампания, имя, createdAt. `inventory_items` — персонаж, optional catalog ID, имя, quantity 1–9999, createdAt. Выдача предмета выполняется ведущим; присоединяет inventory row к постоянному Character и пишет `item_granted` в той же транзакции. Player snapshot показывает список и количество, без редактирования. Масса нигде не используется и не должна вводиться.

### Минимальная предлагаемая модель

- **Catalog Item:** `description` (до установленного лимита), универсальная `category`, `rarity`, positive integer `slotCost` (начально 1), nullable `equipmentSlot` из универсальных слотов, `transferAllowed`, `discardAllowed`, nullable отдельный `storyStatus` (`key/story` или более нейтральный enum). Редкость и сюжетный статус независимы. Для обычных старых строк migration defaults должны быть валидны и не менять имя/количество.
- **Inventory row:** сохранить принадлежность Character и количество; добавить nullable `equippedSlot`. Partial unique index `(character_id, equipped_slot)` для непустого слота гарантирует максимум одну вещь на слот. Экипированное не тратит слоты сумки. Альтернатива — отдельная equipment table; nullable slot в inventory проще и остаётся одним источником состояния, пока у предмета ровно одно экипированное состояние.
- **Сумка:** `characters.inventoryCapacity`, integer >= 0/1 согласно UX и default 12; DM может менять для персонажа. Это минимально и позволяет героям отличаться. Изменение вместимости ниже занятого числа слотов требует отказа либо отдельного подтверждения; нельзя автоматически выкидывать предметы. Слоты считаются как сумма `slotCost` для неэкипированных stack rows, а не количества экземпляров; equipment в capacity не входит.
- **Stacks/equipment edge case:** Visual Lab пока экипирует только quantity=1. Для первой production-версии определить явное правило: equip разрешён только для stack quantity 1 (или позже реализовать разделение stack на instance). Не менять quantity незаметно. Нельзя разрешить экипировать весь stack как одну вещь при `quantity > 1`.
- **Legacy inventory без каталога:** допускает `catalogItemId=null`; на migration такое содержимое должно получить безопасные default metadata, без потери названия и quantity. Решить, остаётся ли metadata snapshot на inventory row либо такие legacy rows получают отдельный catalog item. Предпочтительно создать campaign catalog item только если это не создаёт конфликтов одинаковых имён; иначе хранить snapshot/metadata отдельно. Это решение требуется до migration.
- **Одинаковые названия:** текущий unique index по `(character_id, lower(name))` мешает различным экземплярам одноимённых предметов. При переходе к каталогу уникальность должна быть по `(character_id, catalog_item_id)` для stack merging, а nullable legacy entries должны оставаться различимыми. Проверить миграцию индекса на реальные дубли до решения об удалении/слиянии.

`transferAllowed`/`discardAllowed` — флаги каталога, их нельзя выводить из редкости/метки «Сюжетный». DM выдача остаётся отдельным сценарием; игрокские действия не должны доверять присланным клиентом цене, slot cost, capacity или permission.

**Нужно проверить/добавить в Data Health:** quantity >= 1, slotCost >= 1, capacity неотрицательна и занятость не превышает capacity; item/catalog/character одной campaign; `equippedSlot` допустим для каталога, quantity соответствует правилу equipment; не более одного предмета в equipment slot. Health сообщает проблему, не auto-repair.

**Приоритет:** базовая read-only карточная раскладка — **MEDIUM** UI; метаданные/equipment/capacity — **HIGH**; до equip API с mutation guard — **BLOCKER** для действий.

## 4. Передача и выбрасывание

### Безопасная семантика передачи

Передаётся принадлежащий отправителю stack от Character A к Character B; Player token только подтверждает текущего контроллера Character A. Сервер сам выводит sender из токена, `characterId` отправителя не принимает как авторитетный ввод. Получатель выбирается из другого неархивного Character, назначенного approved Player в той же active Session и той же Campaign. Historical players, pending players, архивные и непривязанные персонажи не участвуют.

Обязательные проверки в одной SQLite transaction: active approved token+assignment; обе Character относятся к campaign active session; отправитель != получатель; оба не archived; item принадлежит sender; не экипирован; `transferAllowed`; целое `quantity` от 1 до принадлежащего количества; для получателя есть свободная capacity, если нет объединяемого stack; сумма quantities не превышает существующий предел. При capacity — учитываются `slotCost` всех bag stacks. Конфликты обновления количества и вставки получателя должны откатывать обе стороны.

Удобный API-контракт: `POST /api/player/inventory/:itemId/transfer` с `recipientCharacterId`, `quantity`, без sender character ID/слотов/metadata. Ответ возвращает актуальные обе стороны только в объёме, разрешённом получателю. Для UI необходим отдельный/расширенный active-session snapshot с допустимыми получателями и их capacity; не выдавать список исторических участников. Включить в ответ server-side reason (`full`, `equipped`, etc.) для понятного UX, не раскрывая закрытую информацию.

### Выбрасывание

`POST /api/player/inventory/:itemId/discard`, только active approved assigned controller. Проверить ownership, не экипирован, `discardAllowed`, валидное количество. Частичный drop уменьшает stack; полный удаляет inventory row. Земля/loot container не создаются. Transaction включает событие. Удалённое состояние восстанавливается только из истории/backup, не из отдельной таблицы.

### Activity

Рекомендуется одно событие `item_transferred` на одну атомарную передачу, с `characterId=sender`, **новым явным nullable `relatedCharacterId=recipient`**, `catalogItemId`, количеством, стабильным/человеко-читаемым названием и временем. Player projection показывает одно событие как «Передал» отправителю и «Получил» получателю. Не пытаться прятать UUID получателя в произвольном JSON: ID должен remap-иться и проверяться типизированно. `item_discarded` содержит item reference/name/count, но не token. Не дублировать запись «item_received»: одна операция — одно каноническое событие.

Equip/unequip сами по себе не меняют владение или знания. Не писать каждое такое техническое действие в Chronicle по умолчанию; при будущем требовании аудита — отдельные события, не смешивать с player digest без продуктового смысла.

**Приоритет:** оба сценария и проверка active sender/recipient — **BLOCKER** перед production transfer/drop. Требуются DB concurrency/rollback, API auth, capacity, stack merge, partial discard, history projection и export/import tests.

## 5. Знания

Player доступ к знаниям уже корректен на уровне категории доступа: `hidden` не возвращается; `party` возвращается всей партии; `character` — только если назначенный персонаж совпадает с `visibleToCharacterId`. Personal knowledge переживает сессии, потому что target — campaign Character. Migration 0006 оставляет `knowledge_migration_issues` для неразрешимых старых связей, не теряя их молча. Export/import remap target Character ID.

Но production types и SQLite CHECK ограничены `npc | monster | note | quest`; Visual Lab имеет `characters | places | creatures | items | events | facts`. Эти категории — тип справочной записи, не новая quest mechanic. Отдельный `Quest` shared type присутствует, но не используется как полноценная таблица/система.

### Рекомендуемый путь миграции категорий

Добавить новый enum/shared literal набор `character/place/creature/item/event/fact` и в новой migration перенести значения как:

| Старое значение | Новое значение | Основание / риск |
|---|---|---|
| `npc` | `character` | NPC — персонаж мира; сохраняется title/description/visibility/ID |
| `monster` | `creature` | Монстр — вид существа; правила/боёвка не добавляются |
| `note` | `fact` | Legacy note здесь — KnowledgeEntry, а не `character_personal_notes` |
| `quest` | `event` | Только справочная запись с title/description; не статусная quest mechanics |

`place`/`item` станут доступны новым записям; для старых нет автоматического предположения по названию. Перестроить SQLite CHECK/table безопасным Drizzle migration способом, сохранить entry ID, campaign ID, visibility, target Character и timestamps; export version увеличить и импортировать версии 1–3 через явный mapping. В тестах проверить все четыре legacy-категории и отсутствие потери/изменения видимости. Если понадобится временная совместимость старого API, адаптировать только boundary; не сохранять forever дублирующий enum без причины.

Knowledge UI может перейти до media: статья обязана иметь полноценный текстовый fallback. Добавить категорию в API allowlist и shared типы вместе с миграцией, иначе UI не должен отправлять пока неподдерживаемое значение.

Activity про раскрытие знания допустим в Chronicle только если событие указывает релевантный `characterId` либо party visibility и ссылка всё ещё разрешена игроку. Скрытие/редактирование ведущим не должно открывать payload/DM state. Новую activity projection покрыть тестом утечки скрытых знаний и знанием другого персонажа.

**Приоритет:** legacy taxonomy к утверждённой универсальной — **HIGH**; возможность прочитать без картинки и старые visibility rules уже есть.

## 6. Журнал / Chronicle

`campaign_activity` — канонический append-only event log, не вторая история. Сейчас есть события кампании/сессий, запросов игроков, назначения персонажа, grants, знаний, профиля, заметок, archive/import/backup. Player snapshot не отдаёт весь лог: он выбирает только grants назначенному персонажу и visibility changes, после чего Home/Journal строят короткие строки. DM routes читают campaign/session/character history.

Для Journal UI можно переносить текущие события без второй таблицы. Нужна отдельная projection-функция (shared/server-side) `activity -> player-safe Chronicle item`, потому что существующий `ActivityDetails` несёт поля разной видимости; не возвращать сырой campaign activity с будущими DM-only payload. Allowlist event types, строго разрешённые refs и text fields; не строить тексты из произвольного payload без проверки.

Передача должна отображаться от обеих сторон через `relatedCharacterId` (см. раздел 4). Drop — только владельцу предмета. `personal_note_created/updated` сейчас фиксируются без body, что правильно с точки зрения содержимого, но это технические events; по умолчанию не показывать их как значимые Chronicle entries, чтобы не захламлять журнал. Profile update аналогично можно скрыть или показывать только после явного UX решения. Interactive events — **DEFER**: Visual Lab example не обязывает строить mini-game/event subsystem сейчас.

Session/date grouping строится из `sessionId` и `createdAt`; экспорт содержит session mapping и сохраняет event order. Новые typed refs должны быть проверены при import. Порядок стабилен по `(createdAt,id)`.

**Приоритет:** базовый Journal — **MEDIUM**; безопасная projection обязательна при добавлении новых activity types (**HIGH**); передачи — **BLOCKER** для transfer UX.

## 7. Personal Notes

Notes уже принадлежат Character и переживают сессии. Player может создавать/обновлять только свои notes при active approved assignment; другой игрок не может менять чужую note (проверяется characterId); старый token после завершения Session теряет `/api/player/notes*` mutations. DM API сейчас читает, но не редактирует; DM видеть заметки — ожидаемая семантика, поэтому UI-текст не должен называть их приватными от ведущего.

Минимальное расширение: добавить `title` (можно default из body для старых строк), `marker` enum с `ordinary` default, `pinned` boolean default false. Поддержать title/body лимиты, allowlist marker в Fastify и shared types. Лимит максимум 3 закреплённых на персонажа (если продукт подтвердит) валидировать в transaction. Не хранить notes metadata в activity payload; существующие note event могут содержать только character ID и тип.

DM edit: рекомендация — **read-only в первом production переносе**. Notes остаются записями игрока, ведущий может видеть; вмешательство DM в текст не нужно для этого UX, создаёт вопросы авторства/истории. Позже можно дать отдельное DM-edit поведение, не использовать player endpoint.

Campaign export format version increment: включить title/marker/pinned и defaults для v1–v3 импорта; пересоздать note IDs как сейчас и remap только character reference. Read-state политика не меняется. Backup сохранит новые колонки целиком. Data Health добавляет enum/trim/length/pinned-limit validation только если эти constraints не выражены безопасно SQLite.

**Приоритет:** basic Journal notes уже работают; richer note card/editor — **HIGH**, но отдельные поля не блокируют перенос Chronicle.

## 8. Profile

Current model уже универсален на верхнем уровне: `name`, `shortDescription`, `archetype`, `origin`, `personalGoal`, `dmNotes`. DM редактирует все канонические поля; current active player — только `shortDescription` и `personalGoal`. Player response не раскрывает `dmNotes`; старый historical token не получает `profile`, потому что snapshot отдаёт его только для `activePlayerCharacter`. Нынешний production Profile экран прост и уже имеет основные факты.

Visual Lab расширяет поля: traits, appearance, quote, плюс организация/позывной/город в секции сведений. Не добавлять фиксированные `organization/callsign/hometown`: названия зависят от кампании и сеттинга.

**Рекомендуемая модель:** campaign-defined field schema (stable field ID, label, order, enabled) плюс character field values по этим stable IDs. Чтобы не делать произвольный универсальный form builder, хранить небольшое строго проверяемое JSON-представление definition в Campaign и значения в Character (JSON object keyed by stable IDs) — только если SQLite доступный JSON validation и API schema validation остаются понятными. Ещё более нормализованный вариант — две таблицы definitions/values — предпочтителен, если нужны уникальность, FK и надёжное удаление/переименование. Для первого переноса решить минимально: JSON-модель с schema version и лимитами (например, число полей, длина label/value, устойчивые key, порядок), а Data Health проверяет каждое значение на существующее определение. Не принимать произвольный объект с неизвестными ключами.

Traits — строковые описательные labels, не числа/характеристики/модификаторы. Quote/appearance — обычные text fields. DM-only notes остаются вне player response. Текущая правка профиля игроком не должна стать общим profile PUT, который может менять canonical fields.

Export/import должен включать definition и values, валидировать все IDs/keys и сохранять порядок; импорт remap character IDs, stable field IDs можно remap-ить тоже либо сохранить в пределах импортированной campaign при гарантии уникальности. Version поднять и читать v1–v3 через defaults. Backup автоматический; Health проверяет JSON/согласованность schema/value. Portrait — отдельный раздел media.

**Приоритет:** перенос текущих полей **LOW** gap; traits/appearance/quote/custom fields — **HIGH** для полного B3. Нужно принять решение о модели до migration/API.

## 9. Media boundary

В production schema нет portrait/image/file records и ссылок на загрузки. `data/uploads/{characters,monsters,items}` существуют как каталоги; Data Health проверяет доступность каталогов, но явно пропускает поштучную проверку, поскольку ссылок из БД пока нет. Visual Lab portrait и Knowledge image — локальные статические assets проекта, не реальные uploads.

Не внедрять media subsystem для переноса UI. Сейчас отображать без блока изображения, если image отсутствует; базовый Player UI не должен резервировать пустую область. Будущая граница: offline asset ID/reference со связью типа `character_portrait`, `knowledge_image`, `item_image`, `document_image`; хранить бинарные данные в uploads и метаданные/ID в DB. Не использовать remote URL как основной механизм. Перенести media только отдельной задачей с backup/export portability и cleanup/health semantics.

## 10. Authorization

Текущий `activePlayerCharacter(tokenHash)` объединяет token -> Player, approved status, Player.sessionId assignment, active Session и Character campaign match. `requireActivePlayerCharacter` используется profile mutation, display-name, note create/update и read marker. DM routes защищены отдельным Bearer DM key.

**Не менять существующую read semantics без отдельного решения:** historical approved token может видеть persistent inventory и знания своей старой сессии; его profile/notes/current activity пусты, а mutation guard не допускает изменений. Это проверяется server/database tests. Любой новый mutation должен идти через reusable guard и никогда не доверять `characterId` отправителя из тела запроса.

До equip/transfer/discard добавить общий DB authorization helper, возвращающий только контролируемого активного персонажа/сессию/campaign и сверяющий assignment непосредственно в нужной активной session. Получателей отдельно проверить как approved + assigned в той же active session + non-archived + same campaign. При каждом вызове также проверить owning character/inventory row/catalog campaign. Нельзя считать `X-Forwarded-*`, адрес LAN, join URL или состояние React полномочиями.

Минимальные security tests: active approved success; pending/rejected 403; historical token 403 на каждую mutation; Character подменён в request; другой campaign; старое assignment; recipient из прошлого session; archived recipient; Sender != Recipient; DM route без/с неверным ключом; никакой выдачи token/hash в state/activity/export.

## 11. Activity log

`ACTIVITY_TYPES` сейчас содержит: campaign/session lifecycle, player request/approval/rejection, character create/assignment/archive/restore, catalog create/item grant, knowledge create/visibility change, profile update, personal note create/update, campaign import, backup restore. Event хранит отдельные nullable refs (campaign/session/player/character/catalog/knowledge), timestamp, `type`, JSON details. В Player projection уже присутствует select allowlist, но новые event types требуют явного решения о player relevance.

Рекомендуемые новые player-action events: `item_transferred`, `item_discarded`. Не включать note body, токены, hashes или DM key; `item_transferred` использует typed `relatedCharacterId` для получателя. `item_equipped/unequipped` не добавлять по умолчанию: состояние видно в inventory и это не обязательно важное хроникальное событие. Не логировать каждое GET/poll.

`campaign_activity` считается append-only через обычный database API и transaction; SQLite пока не запрещает прямой SQL update/delete пользователя БД. Для продуктового кода старые события не редактировать. Export переносит всю кампанийную activity и ремапит типизированные refs; новый ref нужно включить в row schema, import validator, health relationship query и versioned export. Backup автоматически сохранит таблицу/колонку после миграции.

**Activity priorities:** safe projection — **HIGH**; typed receiver ref — **BLOCKER** для transfer; новые event types — только вместе с соответствующей функцией.

## 12. Export / Import

Текущий format `progdm-campaign` version 3. Поддерживаемые импорты v1/v2/v3; в archive есть sessions, display names/statuses players, assignments, characters (включая profile/archive), personalNotes (v3), catalogItems, inventoryItems, knowledge, activity. Идентификаторы основных сущностей пересоздаются и refs remap-ятся. Session/player secrets не экспортируются; игроки получают случайные недоступные token hashes, импортированные с историей сессии завершены, продолжение начинается в новой сессии. Read-state намеренно не экспортируется.

Следующее изменение данных требует увеличить archive version и оставить старые import paths. Экспортировать новые catalog metadata, `equippedSlot`, Character capacity, note title/marker/pinned, profile schema+values, new knowledge category, activity `relatedCharacterId`. Для transfer event remap оба Character ID и CatalogItem ID. Нельзя выполнять произвольный рекурсивный UUID remap по JSON payload: только typed fields/known schemas.

Новые import validations должны быть atomic: некорректный enum, длина, capacity/equipped uniqueness, cross-campaign reference или несовместимая slot metadata откатывает весь import. Старые v1–v3 defaults должны быть задокументированы и покрыты тестом. Read-state remains excluded by policy; backup carries it.

## 13. Backup / Restore

Backup — SQLite file plus uploads copy, поэтому новые поля/таблицы переносятся автоматически. Restore текущего и старого поддерживаемого backup выполняется через staged temporary DB; копия мигрируется, сравнивается текущая schema, проверяются `integrity_check`/`foreign_key_check`, затем только данные восстанавливаются; исходный backup не меняется. Создаётся safety backup текущего состояния; uploads staged similarly. Migration 0009+ обязана иметь сценарий restore со старой версией backup, а не только обычный запуск миграции.

После новых полей проверить table/column/index-aware schema signature и staged migration, особенно изменения существующих таблиц (не только набора таблиц). Не подменять рабочую БД при неуспехе migration или health validation. Тестировать SQLite backup с archive/new fields/activity и восстановление, сохранение safety copy и неизменность исходного backup.

## 14. Data Health

Существующие проверки: SQLite integrity, foreign key check, migration journal/hash, ожидаемые database/backups/uploads/category dirs, cross-campaign session/player/character/catalog/knowledge/activity refs, assignment consistency, active approved player assignment, archive vs active session, read marker event/date consistency. Upload file references явно `skipped`, потому что таких ссылок в DB нет. Проверка ничего не чинит.

После соответствующих migrations добавить доменные проверки:

- Inventory: `quantity` положительный, `slotCost` положительный, capacity корректна, сумма bag slot cost не выше capacity (или отдельный статус предупреждения при административном изменении), equipment slot enum/compatibility, quantity rule, уникальность слота, catalog/character campaign consistency.
- Transfer/discard history: sender/recipient/catalog/session/campaign refs согласованы; event type payload соответствует схеме; не добавлять access tokens/hashes в payload. Проверки исторических событий не должны требовать, чтобы recipient оставался активным сейчас.
- Notes: character exists (FK), marker valid, title/body length, pin limit (если продукт утвердит).
- Profile fields: schema JSON валиден, keys уникальны и values сопоставимы с definitions, ordering/field count/length допустимы.
- Knowledge: category допустима; visibility target принадлежит campaign; legacy migration issues остаются доступны для проверки, не скрываются.
- Activity projection refs: typed related character принадлежит тому же campaign.

Никакого auto-repair/удаления. Вывод — конкретные понятные ошибки ведущему; детали SQL и stack trace не показывать.

## 15. Production component plan

Не переписывать `JoinPage.tsx` целиком. Сначала сохранить текущий маршрут/состояние заявки, вынести approved-player shell небольшими шагами:

```text
apps/web/src/player/
  PlayerShell.tsx       # header, content viewport, fixed bottom nav
  HomePage.tsx
  InventoryPage.tsx
  KnowledgePage.tsx
  JournalPage.tsx
  ProfilePage.tsx
  components/
    ActivityDigest.tsx
    KnowledgeRow.tsx
    InventoryRow.tsx
    PersonalNoteEditor.tsx
    ItemDetailSheet.tsx # только после production endpoint/model
  usePlayerSnapshot.ts  # можно оставить существующий sync contract
```

`JoinPage` остаётся хозяином invite/pending/rejected flows, polling/token lifecycle и выбирает PlayerWorkspace. Каждый экран принимает типизированный `PlayerState`/callbacks, не выполняет отдельные скрытые fetch без нужды. При необходимости уменьшать diff — выносить каждый раздел при его фазе, а не создавать всю структуру заранее. Visual Lab assets/CSS/components не импортировать в production и не совмещать mock model с shared domain types.

## 16. Migration plan

Новая миграция не предлагается до одобрения аудита. Реализационная последовательность должна быть additive/transactional там, где возможно, с backfill и безопасными defaults:

1. Knowledge category CHECK/value transition, note columns, profile custom field representation (если утверждено), inventory item metadata/capacity/equipment fields and indexes; миграции не удаляют старые данные. Разбить, если безопасный rollback/restore сложен.
2. Export format versioning и import compatibility для предыдущих форматов до включения UI, чтобы migrations и portability не расходились.
3. Health invariants после появления колонок; корректные warning/error semantics для легаси данных до принудительных constraints.
4. Никакой destructive reset; restore каждого поддерживаемого старого schema backup через staged copy. Backfill map `npc→character`, `monster→creature`, `note→fact`, `quest→event` сохраняет IDs/visibility.

Перед migration проверить реальную production DB через копию/тестовую fixture на legacy inventory duplicates, quantities, null catalog IDs и campaigns. Не исследовать/менять `data/game.db` в рамках этого аудита.

## 17. Testing plan

Существующая база тестов хорошая: `packages/database/test/database.test.mjs` и `apps/server/test/app.test.mjs` проверяют migrations, legacy import, backup restore, export secrets/remap, character continuity, knowledge visibility, historical tokens, notes/profile/read state и health. Web tests сейчас преимущественно source/Visual Lab/contract-level, они не заменяют production DOM/user-flow tests.

Перед выпуском соответствующих фаз добавить:

1. **DB tests:** category backfill; defaults старых catalog/inventory/note/profile rows; equipment partial unique; stack merge; slot accounting; transactions rollback; capacity boundary; note metadata/pin constraints; profile custom field schema; archive persistence.
2. **API integration + authorization:** historical token не меняет profile/notes/read-state/equip/unequip/transfer/drop; только current approved assigned Character; нельзя подменить sender/recipient; cross-campaign, archived, old-session, equipped и `transferAllowed=false` отклоняются.
3. **Atomic transfer:** successful full/partial stack; matching merge не расходует slot; новый stack требует capacity; insufficient capacity и transaction failure не меняют обе стороны; quantity boundaries.
4. **Equipment/drop:** equip only eligible item, slot already occupied/replacement rule explicitly defined; unequip capacity; quantity >1 policy; protected discard; partial discard сохраняет row/slot, full discard освобождает slot и остаётся в activity.
5. **Continuity:** notes metadata, inventory/equipment/capacity and profile survive new session/reassignment to same Character; old Player token keeps only explicitly retained historical reads.
6. **Knowledge/API:** all six categories accepted, visible category and visibility preserved, hidden/other-character knowledge absent from Player response and activity projection.
7. **Export/import:** previous v1/v2/v3 still import; new format roundtrips every new field; remaps related sender/recipient/catalog/knowledge/profile references; no join token/token hash/DM key; malformed refs roll back.
8. **Backup/restore:** current backup roundtrip; each supported old schema migrates staged; altered-column old backup test; archive/activity/new fields preserved; original backup unchanged, safety copy preserved, damaged fixture rejected without touching working DB.
9. **Health:** isolated temp DB healthy; separately inject invalid custom profile JSON/inconsistent refs, negative/over-capacity inventory, duplicate equipment state and malformed categories; `ok=false` with understandable check label; no auto-fix.
10. **UI:** focused tests for production player screen sections/actions and data state; one minimal browser smoke (desktop shell and 360/390/430 px player widths, no horizontal overflow, bottom nav safe area, sheet focus/overlay) using an already available harness if present. Current package scripts list no dedicated Playwright/browser test dependency; do not add one without separate decision.

## 18. Recommended implementation order

1. **Production boundary and shared types (no new product behavior):** split approved player shell/sections incrementally while keeping current response contract. First migrate existing Profile/Knowledge read views and Home digest without waiting for images or inventory mechanics. This validates the production component boundary and allows UX review.
2. **Profile B3 and notes metadata:** first decide custom campaign fields schema; then migration, DM write API, Player-safe read projection, note title/marker/pin API and active-controller permissions. DM note editing remains out of scope by default.
3. **Knowledge categories/article:** additive safe migration/backfill and export vNext, shared/API allowlist, category filtering/search/detail; image remains absent/optional. Player visibility logic remains character/party; `hidden` stays hidden.
4. **Journal/Home projection:** build typed player-safe projections from existing append-only activity; add grouping/detail and pinned notes; implement mark-seen with active controller only. Test the intersection of event, recipient, and knowledge visibility.
5. **Inventory foundations:** decide legacy row/catalog snapshot strategy and duplicates; migration for metadata/capacity/equipment; export/import version; health invariants; production inventory read/card/detail. Keep base read-only display separate from actions.
6. **Equip/unequip:** add atomic endpoints, compatibility/capacity rules and DM/player permission rules; then enable UI actions.
7. **Transfer/discard:** add recipient snapshot and strict active-assignment guard, transaction code, typed `relatedCharacterId`, Chronicle projection, export remap, restore/health tests; enable UI only after server contract tests.
8. **Media later:** portrait and Knowledge/item images are independent; do not block text-first screens.

This order lets approved read-only sections move before high-risk inventory mutations. If the team prefers schema-first delivery, keep migration/export/backup tests ahead of any UI that depends on new fields. No phase introduces combat, weight, map, quests-as-mechanics, real-time transport, or cloud services.

## Ключевые gaps по приоритету

- **BLOCKER:** у inventory actions нет модели состояния/слотов/capacity и API authorization; transfer/drop/equip нельзя выпускать только на mock frontend.
- **BLOCKER:** transfer recipient нельзя безопасно адресовать в текущем Activity schema одним `characterId`; требуется typed second-character reference и import/health remap.
- **HIGH:** universal Knowledge category mismatch (4 production values vs 6 approved categories) требует миграции API/types/SQLite CHECK/export.
- **HIGH:** richer Personal Notes (title/marker/pinned) и расширенный B3 Profile отсутствуют в DB; campaign fields требуют предварительного решения модели.
- **HIGH:** новый Journal event projection должен быть allowlist-based и проверять relevance/knowledge visibility; нельзя отдавать raw campaign activity.
- **LOW / уже готово:** Home базовый digest, read marker per-character, profile base fields, visible knowledge, basic inventory list и Chronicle events `item_granted`/knowledge reveal уже доступны в production.

## Неизменяемые решения этого аудита

- Character и его Inventory/Knowledge/Notes/Profile остаются campaign-scoped; Player и assignment — session-scoped.
- Старые токены сохраняют нынешнюю read-only историческую семантику до отдельного решения; никакие новые mutation ей не доверяют.
- Weight/encumbrance, HP, combat, initiative, quest mechanics, uploads, Socket.IO/realtime и UI перенос Visual Lab в этой задаче не реализуются.
- Schema/export version, migration и UI должны развиваться согласованно; backup/restore сохраняет все состояния SQLite, campaign export исключает player secrets и read-state.
