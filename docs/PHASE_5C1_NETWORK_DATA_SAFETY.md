# Phase 5C.1: Network & Data Safety

Дата: 2026-10-08. Baseline и HEAD после работы:
`eca1bf657a3cf79af51523d356811ca930e52c36`.

Перед изменениями рабочее дерево было чистым; `main` совпадал с `origin/main`.
[CI #34](https://github.com/1-mender/ProgDM/actions/runs/37668004651)
проверен через GitHub API: `completed / success`, SHA совпал с baseline.

Исправлены F1, F2, F3, F4, F7. Исторический
`docs/CODE_AUDIT_2026-10-05.md` не переписывался. F5, F6, F8 не исправлялись.
Новых игровых функций, зависимостей, migrations или изменений archive schema нет.
Последняя миграция остаётся 0016, формат архива — v11.

## F1: подключение игрока

- Используется прежний invitation-scoped ключ
  `progdm.playerToken:<invitation>`.
- Небольшой `JoinIntent` сохраняет токен и маркер неопределённого запроса
  `progdm.playerJoinPending:<invitation>` до POST; React credential обновляется
  до отправки. Маркер содержит только `1`, не дополнительную копию секрета.
- Retry и reload сохраняют тот же токен. Existing server semantics уже возвращает
  существующего Player при повторе с тем же token hash: новая запись не создаётся.
- Ранний 401 во время POST или при сохранённом pending intent не удаляет credential.
  В таком состоянии можно перечитать invitation и повторить исходную заявку.
- Успешный `/me` или подтверждённый POST снимает pending marker. Для уже
  подтверждённого credential прежняя обработка окончательного 401 сохраняется.
- При 409 клиент пробует восстановить `/me` и не заменяет токен.
  Определённый 400/404 при POST позволяет очистить незавершённый credential.
- Historical approved read semantics и server authorization не расширены.

## F2: inventory intents

- `InventoryIntents` хранится в localStorage по ключу
  `progdm.inventoryPending:<credential>`, отдельно для каждого credential.
  Значение содержит type, inventoryItemId, operationId, quantity и optional
  recipientCharacterId; DM key и секреты не добавляются в payloads/exports/activity.
- Registry не принадлежит InventoryPage. Закрытие sheet, смена вкладки,
  remount и reload не уничтожают ID неопределённого запроса.
- Один intent определяется type/item/quantity/recipient. Повтор использует
  прежний ID; изменение параметров создаёт новый, сохраняя прежний pending intent.
- API success плюс успешное обновление snapshot удаляют только соответствующий ID.
  Network/timeout/5xx, HTTP 408 и ошибка refresh сохраняют его.
  Определённый 4xx до подтверждения mutation удаляет только соответствующую запись.
- Максимум 20 pending intents на credential. Новые действия при достижении
  предела блокируются с понятной ошибкой; существующие можно повторять.
  FIFO eviction и автоматического expiry нет.
- Ошибка storage, quota или повреждённый JSON запрещает отправку нового
  destructive request: нельзя незаметно заменить потерянный ID новым.
- Сообщение «Есть неподтверждённые действия с инвентарём» и действие
  «Проверить результат» повторяют сохранённые requests с исходными IDs.
  Это работает даже при исчезнувшей inventory row, без восстановления sheet.
  Backend возвращает прежний результат; новых item/activity changes не возникает.
- Проверка результата выполняется явно, а не через автоматические мутации
  при polling. Player permissions по-прежнему проверяются сервером.

## F3: transport policy

- Обычный JSON: `JSON_BODY_LIMIT = 64 KiB`. Этого достаточно для максимальных
  bounded schemas, включая кириллицу и 20 значений полей профиля.
- Facts reorder имеет потенциально длинный список IDs без schema maxItems;
  для него отдельно применяется большой, но конечный предел 64 MiB.
- В public/player и DM error handlers 413 возвращает
  «Запрос слишком большой.» без технической информации.
- Ограничения длины полей, enums, additionalProperties и остальные
  schema/domain проверки не ослаблены. Limit +1 остаётся validation 400.

## F4: archive round-trip

- Общая константа `CAMPAIGN_ARCHIVE_MAX_BYTES = 64 MiB` в shared.
  Server `CAMPAIGN_IMPORT_BODY_LIMIT` использует ту же константу.
- DB import и DB export проверяют размер сериализованного JSON в UTF-8.
  Direct DB call также ограничен, а не только HTTP route.
- Общий произвольный cap 10000 строк удалён. Array.isArray, record validation,
  remapping, reference checks и transaction atomicity сохранены.
- История не обрезается. Кампания выше byte budget не экспортируется как
  поддерживаемый download: сервер возвращает понятный 413.
- HTTP дополнительно ограничивает фактические bytes запроса; пробелы и иное
  форматирование внешнего JSON также входят в transport budget.
- Формат v11 и поддержка прежних версий не изменены. Resource policy не
  требует новой версии архива или миграции базы.

## F7: скачивание и busy

- `dm-download.ts` выделяет существующий download boundary без переноса
  остальной DM architecture. ApiError сохраняет статус и серверное сообщение.
- Export timeout 30 секунд, backup download — 60 секунд. AbortController
  покрывает headers и blob; deadline race завершает promise даже при
  зависшем транспортном mock, не реагирующем на abort.
- Network/abort сообщает: «Нет связи с сервером. Попробуйте скачать файл ещё раз.»
  Никакого бесконечного ожидания workspace busy; mutate освобождает его в finally.
- Download network failure не переводит готовое рабочее место в заблокированную
  error phase, поэтому скачивание можно повторить.
- После создания backup его строка и выбранный ID обновляются до скачивания.
  Retry через существующую кнопку скачивания выбранной копии не создаёт ещё один файл.

## Проверки и покрытие

Новые executable tests используют фактические TS helpers, обработчики и эффекты
TSX-компонентов, а не только regex. Минимальный hooks harness не является React DOM
renderer: layout, реальный браузер и физическая LAN в этой фазе не проверялись.

Добавлены 22 теста: database 2, server 5, web 15.
Существующие 165 тестов сохранены. Две source assertions inventory обновлены
под новое расположение registry; поведение теперь дополнительно проверяется
исполнением компонентов и реального API.

- Join: lost response, retry/reload, early 401, definite invalid invitation,
  доступ к исходному Player, отсутствие второй записи и второго request event.
- Inventory: transfer/discard remount/reload, изменённые параметры, cleanup,
  network/5xx/refresh failure, cap/storage corruption, реальный API replay,
  ровно один effect/activity, full discard и replay исчезнувшей row.
- Payloads: максимальные кириллические profile/note/knowledge/DM fields,
  limit +1, сохранение текста в DB и русский 413.
- Archives: 10002 реальных DB events, remapping, точное сохранение истории,
  atomic rejection повреждённых ссылок; HTTP round-trip файла больше 10 MiB
  с 10002 events и 2500 notes; проверки общего byte budget для DB и HTTP.
- Downloads: зависание headers/body, abort, successful retry, ApiError,
  actual DM busy release и скачивание созданной копии без повторного POST.

Итоговый набор: **187 тестов — database 71, server 38, web 78**.
Команды завершились успешно: `pnpm typecheck`, `pnpm test`, `pnpm build`,
`git diff --check`.

## Изменённые файлы

- `apps/server/src/app.ts`
- `apps/server/test/app.test.mjs`
- `apps/web/src/App.tsx`
- `apps/web/src/JoinPage.tsx`
- `apps/web/src/dm-download.ts` (новый)
- `apps/web/src/player/InventoryPage.tsx`
- `apps/web/src/player/PlayerWorkspace.tsx`
- `apps/web/src/player/inventory-intents.ts` (новый)
- `apps/web/src/player/join-intent.ts` (новый)
- `apps/web/src/sync.ts`
- `apps/web/test/helpers/runtime.mjs` (новый)
- `apps/web/test/network-safety.test.mjs` (новый)
- `apps/web/test/player-inventory.test.mjs`
- `packages/database/src/index.ts`
- `packages/database/test/database.test.mjs`
- `packages/shared/src/index.ts`
- `docs/PHASE_5C1_NETWORK_DATA_SAFETY.md` (этот отчёт)

## Границы и оставшийся долг

- Надёжность повторов требует сохранения localStorage. Ручное удаление браузерных
  данных уничтожает локальный intent; резервная копия SQLite его не восстанавливает.
- Registry не имеет межвкладочного mutex. Одновременное начало нового одинакового
  действия в разных браузерных вкладках не покрывается этой фазой; каждый явно
  новый ID остаётся отдельной backend operation. Обычный retry/remount/reload покрыт.
- Неопределённые intents не удаляются по времени. После отзыва прав их нельзя
  исполнять; прежняя security policy важнее клиентской reconciliation.
- 64 MiB — явный предел архива, а не безлимитное хранение/streaming import.
  Сериализация и импорт больших архивов остаются синхронными и расходуют память;
  отдельный streaming/performance refactor не выполнялся.
- F5/F6/F8 остаются задачами следующей фазы. Исторический audit snapshot не изменён.
- `data/game.db` не читалась и не изменялась. Все DB/API scenarios изолированы.
  Схема/миграции/backup architecture не менялись.
- Commit не создан, push не выполнен. Phase 5C.2 и Media не начинались.
