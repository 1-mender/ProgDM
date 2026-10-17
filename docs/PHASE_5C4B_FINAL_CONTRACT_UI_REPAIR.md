# Phase 5C.4B: Final Contract & UI Repair

Дата: 2026-10-17. Baseline и HEAD после работы:
`8ed1f2b2699120dbba1632b4b07ce174eb90863f`.

Перед началом `HEAD == main == origin/main`, рабочее дерево чистое.
[CI #38](https://github.com/1-mender/ProgDM/actions/runs/39019092485)
проверен через GitHub API: `completed / success`, SHA совпал с baseline.

## Закрытие findings

| Finding Final System Audit | Результат |
|---|---|
| F1-F4 | Исправлены Phase 5C.4A; существующие regression tests проходят, semantics сохранены |
| F5 | Notes editor сохраняет draft, но блокирует mutations после потери canEdit/target |
| F6 | Пользовательские текстовые лимиты DB/import/health согласованы с JSON Schema по Unicode code points |
| F7 | Journal local-date fixtures не зависят от timezone; проверены UTC, UTC+14 и America/Adak |

Исторический `CODE_AUDIT_2026-10-08_FINAL.md` и отчёт 5C.4A не переписывались.
Findings F1-F7 адресованы; перечисленные в историческом аудите отдельные
Needs investigation не объявляются автоматически закрытыми.

## F5: разрешения редактора заметок

Состояние draft не синхронизируется с canonical note при смене прав и не
удаляется автоматически. `editorCanEdit` зависит от текущего `canEdit` и наличия
target note в актуальном списке; для нового draft target существует локально.

- При `canEdit=false` input/select/textarea и pin checkbox отключены, Save
  disabled; submit дополнительно проверяет права, target и busy до onSave.
- Показывается короткое сообщение о недоступности редактирования и сохранении
  текста на этом экране. Обещания persistence после reload нет.
- Начало Create/Edit защищено проверкой текущих прав. Pin actions в read-only
  режиме не показываются. Backend authorization не менялась.
- Cancel/Close остаются доступны, когда нет выполняющейся операции; они не
  отправляют mutation.
- Возврат прав в том же mounted component разрешает продолжить прежний draft,
  если существующая note всё ещё доступна. Canonical polling его не заменяет.
- Если note исчезла, draft остаётся виден read-only с сообщением; submit не
  делает update даже при `canEdit=true`.
- Для нового draft сохраняется creation UUID из Phase 5C.4A. Временная потеря
  прав не создаёт новую identity и не отправляет create.

Добавлены 6 executable component tests: existing draft loss/return, отдельные
Cancel/Close, initial read-only state, new-note permission transition и missing
target. Проверяются значения всех draft fields, disabled controls, отсутствие
вызовов onSave и сохранение creation UUID.

## F6: Unicode contract

Внутренний helper `unicodeLength(value) = Array.from(value).length` считает
Unicode code points, как JSON Schema maxLength. Это не UTF-8 bytes и не
grapheme clusters: составной визуальный символ может включать несколько points.

Переведены пользовательские лимиты:

| Область | Лимит code points |
|---|---|
| Campaign/Session/Character/Catalog name, Knowledge title | 120 |
| Player displayName | 60 |
| Knowledge description, Fact body, Notes body, Catalog description | 2000 |
| Notes title | 120 |
| Profile shortDescription/origin/personalGoal, profile field value | 500 |
| Profile archetype | 120 |
| Profile dmNotes | 2000 |
| Trait | 40, по-прежнему максимум 8 нормализованных traits |
| Appearance / quote | 1000 / 300 |
| Campaign profile field label | 60 |

Те же limits используются в import. Строковые названия в Activity payload
проверяются по code points, иначе допустимое новое имя могло бы ломать export.
Согласованы JS-проверки Data Health для profiles/traits/field definitions:
SQL `length()` уже считает code points. Поэтому staged restore из 5C.4A не
отклоняет валидный supplementary profile.

Trim policy сохранена: validators, которые раньше применяли trim, делают это
до проверки длины; поля без trim не получили новую нормализацию. Пустые и
whitespace-only значения остаются запрещены/разрешены по прежним правилам.
Raw import transport/field bounds остаются отдельной проверкой до дальнейшей
нормализации. UTF-8 archive/body budgets, UUID/token regex и технические
operation IDs не изменены; сериализованный Activity payload budget не расширен.

### Классификация ошибок

`DomainValidationError` обозначает ошибки пользовательского текстового input
из соответствующих validators и экспортируется database package для server
boundary. Public/Player и DM error handlers возвращают для него безопасный 400.
Внутренние Error/TypeError и database failures не переклассифицированы в 400:
они остаются 500 без SQL/parser/stack details в ответе. Stored-data corruption
не становится пользовательской validation ошибкой автоматически.

### Проверенные boundaries

- HTTP имена: 120 supplementary code points принимаются, 121 получает 400;
  Campaign, Session, Character и Catalog проверены.
- Player join/settings: 60 принимается, 61 получает 400.
- Notes title/body: 120/2000 принимаются, +1 и запрещённый whitespace получают 400.
- Player/DM Profile, traits, appearance, quote, dmNotes, Knowledge/Fact,
  Catalog description и campaign profile fields проверены на limit/+1.
- Direct DB validators, v11 export/import и Data Health проверены отдельно для
  ASCII, кириллицы и supplementary Unicode; malformed import остаётся atomic.
- Supplementary profile прошёл backup/restore и staged health validation,
  исходные backup bytes не изменились.
- Typed validation, внутренние ошибки и SQL-like failures исполнялись через
  настоящие HTTP handlers: 400 только для validation, 500 для внутренних ошибок,
  ни один ответ не содержит тестовый secret/SQL/internal diagnostics.

HTML maxLength в production UI намеренно сохранён: его UTF-16 ограничение для
supplementary символов может быть строже API. Это разрешённое conservative
поведение этой фазы, не новый form framework. Server validation остаётся
обязательной независимо от browser controls.

## F7: локальные даты журнала

Production `JournalPage` и функции date grouping в model не изменялись.
Три fixture timestamps теперь создаются из local Date constructor, например
`new Date(2026, 9, 4, 17, 14, 12).toISOString()`, а не hard-coded UTC timestamp.
Assertion по 4 октября не ослаблен.

Добавлен behavior test: local 23:59 4 октября и local 00:01 5 октября в одной
сессии образуют две date groups с правильными событиями/подписями.

Оба целевых Journal tests отдельно выполнены в дочерних Node processes:

| TZ | Результат |
|---|---|
| UTC | 2/2 PASS |
| Pacific/Kiritimati | 2/2 PASS |
| America/Adak | 2/2 PASS |

## Проверки и границы

Добавлено 16 tests: database 4, server 5, web 7. Существующие 228 сохранены.

- `pnpm typecheck`: PASS.
- `pnpm test`: **244/244**, database **80**, server **49**, web **115**.
- `pnpm build`: PASS; сборка запущена с разрешением доступа, необходимым esbuild
  в текущей sandbox-среде.
- `git diff --check`: PASS; новые файлы дополнительно проверены на whitespace.
- F1-F4, Join, inventory intents, profile draft, Chronicle refresh, Knowledge
  safety, cleanup, export/import и legacy backup restore tests остаются зелёными.

Новой migration/0017 нет; последняя по-прежнему 0016. Archive остаётся v11.
Новых dependencies, autosave, persistent draft storage, Notes delete или Media
не добавлено. UI проверен существующим hooks/runtime harness, не физическим
телефоном или полноценным ReactDOM/browser renderer. Draft существует только
на открытом экране и может быть утрачен при его закрытии/reload.

## Изменённые файлы

- `packages/database/src/validation.ts` (новый)
- `packages/database/src/index.ts`
- `packages/database/test/database.test.mjs`
- `apps/server/src/app.ts`
- `apps/server/test/app.test.mjs`
- `apps/web/src/player/PersonalNotesPage.tsx`
- `apps/web/test/final-contract-ui-repair.test.mjs` (новый)
- `apps/web/test/production-player.test.mjs`
- `docs/PHASE_5C4B_FINAL_CONTRACT_UI_REPAIR.md` (этот отчёт)

HEAD после работы: `8ed1f2b2699120dbba1632b4b07ce174eb90863f`.
`data/game.db` не читалась/не изменялась; DB/API проверки выполнялись только на
изолированных TEMP/memory данных. Commit не создан, push не выполнен.
После Phase 5C.4B работа остановлена; следующая фаза и Media не начинались.
