# ProgDM: инструкции проекта

## Продукт и ограничения

ProgDM — локальный помощник ведущего и общая память настольной RPG. Сервер работает на ноутбуке ведущего, игроки подключаются браузером по LAN-ссылке или QR. Проект автономный: не требуются облако, аккаунты, интернет, Docker или внешняя БД. Боёвка и связанные механики (HP, урон, лечение, инициатива) исключены. Не добавляй их без явного пересмотра решения пользователем. Загрузки изображений и media-модель отложены.

Интерфейс, включая подписи, ошибки и доступные названия, должен быть на русском. Не создавай коммиты и не публикуй изменения без явного запроса: commit/push выполняет пользователь.

## Архитектура

- `apps/web` — React/Vite, ведущий и Player workspace.
- `apps/server` — Fastify API и авторизация.
- `packages/shared` — общие типы предметной области.
- `packages/database` — SQLite, Drizzle, миграции и операции.
- `packages/game-engine` — независимые от UI операции кампаний/сессий.

Данные по умолчанию: `data/game.db`, `data/uploads/*`, `data/backups`; путь БД можно задать `PROGDM_DATABASE_FILE`. Не читай и не меняй рабочую БД ради тестов: `pnpm test` использует изолированные временные базы. Не применяй разрушительный reset. Изменения схемы — только новой Drizzle migration, после проверки SQL и legacy/restore сценариев.

## Текущая модель

- `Character` и его профиль, инвентарь, знания, заметки и read-state принадлежат Campaign и переживают Sessions.
- `Player` относится к одной Session; связь хранится в `session_character_assignments`. Исторические назначения остаются.
- Изменения игрока разрешены только одобренному Player с назначением в текущей активной сессии и соответствующим разрешением. Исторический одобренный token сохраняет прежнее чтение доступного ему базового состояния, но не может выполнять новые мутации; не расширяй и не меняй эту семантику случайно.
- DM API требует отдельный Bearer key. Не раскрывай токены, их хеши или DM key в API, логах, событиях и экспортах.

Основные Player-разделы: **Главная / Инвентарь / Знания / Журнал / Профиль**. Player API возвращает безопасный projection, а не полный campaign activity или DM-поля.

### Знания и история

Текущая универсальная таксономия Knowledge: `character`, `place`, `creature`, `item`, `event`, `fact`. Простое summary управляется `hidden / party / character`. Knowledge Facts имеют отдельные grants для `party` или `character`; party grant является общим для кампании и переживает смену сессий. Player projection включает только доступные summary/facts. Журнал игрока формируется отдельным безопасным projection релевантных событий; не отдавай игроку `campaign_activity` напрямую.

Personal Notes принадлежат Character: `title`, `body`, `marker` (`normal / important / check / question`), `pinned`, timestamps. DM может читать заметки; игрок-редактор должен быть текущим контроллером активной сессии. На Главной показываются не более двух закреплённых заметок.

B3 Profile хранит универсальные `traits`, `appearance`, `quote` наряду с базовыми полями. Campaign-defined profile fields хранятся отдельно и имеют определения/порядок на Campaign. Игроку не выдавать `dmNotes`.

### Player Inventory (Phase 4B)

Инвентарь и экипировка принадлежат Character. Production Player UI показывает Equipment 2×3 и 3-колоночную сумку. `inventoryCapacity` — число слотов сумки (по умолчанию 12); одна неэкипированная stack-строка занимает один слот независимо от quantity, экипированные строки не занимают слот. Каталог содержит `description`, `category`, `rarity`, `equipmentSlot`, `transferAllowed`, `discardAllowed`; Inventory Item хранит `equippedSlot`. PlayerState проецирует только inventory rows персонажа и метаданные каталога из той же Campaign; legacy/missing/foreign catalog references получают безопасный fallback. У Player API есть `POST /api/player/inventory/:id/equip` и `/unequip` с пустым body: сервер сам находит Character через текущий активный approved assignment. History token читает inventory/equipment/capacity, но не может экипировать или снимать. Экипировка требует quantity=1 и свободного совместимого слота; автоматической замены и разделения stack нет. Снятие требует свободный slot либо объединяет строку в совместимый catalog stack с запасом до 9999. Equip/unequip не создают Activity. Выдачи DM объединяются по `catalogItemId`, не по имени. Веса/encumbrance, Transfer и Discard не реализованы.

Последняя миграция — `0014`; campaign archive format — v9. Backup/restore должен мигрировать поддерживаемые старые базы на staged-копии, проверять целостность и не менять оригинал. Player Inventory UI/equip/unequip не меняют схему, backup или export v9.

## Разработка

Ориентируйся на текущий код/схему, а не на исторические audit snapshots в `docs/`. Не удаляй несвязанные пользовательские изменения. Предпочитай малые правки в существующих границах и проверяй API, права доступа, миграции/перенос и UI соразмерно риску. Не добавляй зависимости и инфраструктуру без необходимости.

Основные проверки: `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check`. Для визуальной ручной проверки используй изолированный `apps/server/test/serve-ui.mjs`; не подключай его к рабочей базе.
