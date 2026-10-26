# Personal Platform Backend

Мінімальний backend на Express і TypeScript з Prisma 7.10.1 для Supabase Postgres.
Потрібен Node.js 20.19+, 22.12+ або 24+ (підтримувані гілки Node.js).

## Запуск

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Сервер типово працює на `http://localhost:4000`. `GET /api/health` повертає
`{"status":"ok"}` і працює без підключення до БД.

Змінні середовища:

- `PORT` — порт сервера, типово `4000`.
- `CLIENT_ORIGIN` — дозволений CORS origin, типово `http://localhost:3000`.
- `DATABASE_URL` — PostgreSQL URL для Prisma Client (Supavisor session pooler, порт 5432).
- `DIRECT_URL` — URL для Prisma CLI та міграцій: direct connection або session pooler, порт 5432.

Скопіюйте справжні URL із Supabase Dashboard → Connect у локальний `.env`,
замінивши всі шаблонні значення. Спеціальні символи пароля мають бути URL-encoded.
Direct connection потребує IPv6 або Supabase IPv4 add-on; для IPv4 можна вказати
session pooler URL у `DIRECT_URL`. Transaction pooler на порту 6543 не використовуйте
для міграцій. `.env` і його локальні варіанти ігноруються Git; у `.env.example` лише шаблони.

## Prisma та міграції

Використано [Prisma Config](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference),
генератор `prisma-client` з CommonJS і `@prisma/adapter-pg`.
Налаштування підключення описані в [документації Supabase](https://supabase.com/docs/guides/database/prisma).
Prisma CLI читає `DIRECT_URL` з `prisma.config.ts`; клієнт читає `DATABASE_URL`
через ліниву функцію `getPrisma()` у `src/lib/prisma.ts`.

Модель `Task` зберігає статус, пріоритет, планування, причину скасування та незалежні
`archivedAt` / `deletedAt`. `TaskAction` зберігає журнал із UUID, `taskId`, `type`,
`timestamp` і JSON `metadata: { before, after }`. UUID генерує Prisma;
`updatedAt` автоматично оновлюється під час записів через Prisma Client.

Початкова міграція `20261019000000_create_task` не змінена. Попередня міграція
`20261021000000_task_lifecycle` **очищає лише наявні тестові записи `Task`**,
бо вони не мають обов'язкової тривалості та даних планування. Інші таблиці не
видаляються. Додані SQL CHECK-обмеження для додатної тривалості й причини
скасування; зміни міграції виконуються в одній SQL-транзакції.

Нова адитивна міграція `20261021010000_task_priority` додає enum `TaskPriority`
та обов'язковий `Task.priority` із default `MEDIUM`, зокрема для всіх наявних задач.
Вона не видаляє таблиць або записів `Task` / `TaskAction`. Попередні міграції не змінені.

Адитивна міграція `20261021020000_subtasks` створює таблицю `Subtask`, зв'язок із
`Task`, індекс списку та CHECK-обмеження додатної тривалості й причини скасування.
Вона додає чотири значення `SUBTASK_*` до `TaskActionType`, не очищує й не змінює
наявні записи. Міграцію підготовлено, але не застосовано.

Для ручного застосування підготовлених міграцій із кореня backend виконайте:

```powershell
npm run prisma:migrate:deploy
```

Команда використовує налаштований `DIRECT_URL`, застосовує лише ще не застосовані
міграції та не потребує shadow database. Не використовуйте `migrate reset`.
Перед застосуванням перевірте список незастосованих міграцій: команда застосовує
їх усі, включно з попередньою `task_lifecycle`, якщо її ще не застосовано.

Перевірка схеми та генерація клієнта не потребують `.env` і не змінюють БД:

```powershell
npm run prisma:validate
npm run prisma:generate
```

Згенерований клієнт у `src/generated/prisma/` ігнорується Git.
Після зміни схеми повторіть генерацію перед `npm run dev`.

## Task API

`POST /api/tasks` вимагає `title`, `dueAt` і, без підзадач або з `subtasks: []`,
`estimatedDurationMinutes`. Дати — ISO 8601 із часовим поясом (`Z` або offset),
тривалість — додатне ціле число до `2147483647`. `description` необов'язковий.
`plannedAt` необов'язковий: якщо пропущений, у БД і відповіді буде `null`;
якщо переданий — перевіряється як дата. Явний `plannedAt: null` у POST відхиляється.
Нові задачі мають статус `TODO` і пріоритет `MEDIUM`, якщо `priority` не передано.
POST і PATCH приймають `priority`: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`;
інші значення та `null` відхиляються. Всі відповіді із задачею містять `priority`.

```json
{
  "title": "Підготувати пропозицію",
  "priority": "HIGH",
  "plannedAt": "2026-10-22T09:00:00+03:00",
  "dueAt": "2026-10-23T17:00:00+03:00",
  "estimatedDurationMinutes": 45
}
```

Для створення задачі разом із підзадачами передайте непорожній `subtasks`:

```json
{
  "title": "Оновити інтерфейс",
  "dueAt": "2026-10-25T15:00:00.000Z",
  "priority": "HIGH",
  "subtasks": [
    { "title": "Оновити список задач", "estimatedDurationMinutes": 40 },
    { "title": "Перевірити на телефоні", "estimatedDurationMinutes": 20 }
  ]
}
```

Кожен елемент приймає лише `title` та `estimatedDurationMinutes` із чинними
обмеженнями підзадач: назва 1–160 символів після обрізання пробілів, тривалість —
додатне ціле число до `2147483647`. `subtasks: null` і не-масив відхиляються;
окремого обмеження кількості підзадач немає.
Для непорожнього масиву тривалість батька можна пропустити: зберігається сума
тривалостей підзадач (у прикладі — `60`). Якщо тривалість батька передано,
її тип і межі перевіряються, але зберігається саме сума. Переповнення суми
понад `2147483647` повертає `400` до відкриття транзакції та будь-яких записів.
Задача й усі вкладені підзадачі створюються зі статусом `TODO`. Для непорожнього
масиву `status` батька можна пропустити або передати `"TODO"`; інші значення
дають `400`. Без підзадач або з `[]` збережена попередня поведінка POST:
поле `status` не приймається, статус автоматично `TODO`.

Батько, підзадачі та події `CREATED` / `SUBTASK_CREATED` для кожної підзадачі
створюються в одній транзакції `Serializable` з чинними повторами конфліктів.
`CREATED.metadata.after.estimatedDurationMinutes` містить фактичну суму;
початкове створення не генерує `EDITED` чи `STATUS_CHANGED`. Помилка будь-якого
запису відкочує всю операцію. Відповідь `201` містить повний Task DTO з повними
DTO підзадач, відсортованими за `createdAt ASC`, потім `id ASC`.
Окремі CRUD-маршрути підзадач залишаються доступними. Змін Prisma-схеми та
нових міграцій для цього контракту не потрібно.

Маршрути:

| Запит | Поведінка |
| --- | --- |
| `POST /api/tasks` | Створення задачі з необов'язковими підзадачами, відповідь `201` із повним Task DTO та `subtasks` |
| `GET /api/tasks` | Неархівовані й невидалені задачі, нові спочатку |
| `GET /api/tasks?archived=true` | Лише архівовані й невидалені задачі |
| `GET /api/tasks?archived=false` | Звичайний список |
| `GET /api/tasks?view=today` | Лише задачі з обчисленим `isToday: true`, звичайний масив |
| `GET /api/tasks?view=backlog` | Задачі, що потребують нового плану: `isBacklog: true`, звичайний масив |
| `GET /api/tasks/:id` | Одна невидалена задача, включно з архівованою |
| `PATCH /api/tasks/:id` | Редагування полів, статусу та/або архіву |
| `DELETE /api/tasks/:id` | Встановлення `deletedAt`, відповідь `204` |
| `GET /api/tasks/:id/history` | Журнал невидаленої задачі, старі події спочатку |

PATCH приймає `title`, `description`, `status`, `priority`, `plannedAt`, `dueAt`,
`estimatedDurationMinutes`, `cancellationNote`, `skipNote`, `archived`. Невідомі поля та
порожній PATCH відхиляються. `description`, `plannedAt` і `dueAt` можна очистити
через `null`; при створенні задачі дати не можуть бути `null`.

Статуси: `TODO`, `IN_PROGRESS`, `PAUSED`, `POSTPONED`, `DONE`, `CANCELED`, `SKIPPED`.
`SKIPPED` доступний лише вже створеній Routine Task; контракт пропуску наведено нижче.
Переходи між ними дозволені; `CANCELED` вимагає в тому самому запиті непорожню
`cancellationNote` (пробіли по краях обрізаються). Причина зберігається в задачі
та metadata події зміни статусу; наступні зміни статусу зберігають її, крім входу в SKIPPED.
При переході в `POSTPONED` без `plannedAt` попередня дата планування очищається.
Непереданий `dueAt` зберігається, а явний `dueAt: null` очищає дедлайн.

Для сумісності кожна відповідь із задачею містить обчислений `isCompleted`,
який є `true` лише для `DONE`. Старий PATCH `{ "isCompleted": true }` переводить
у `DONE`, а `false` — у `TODO`. Одночасно передавати `status` і `isCompleted`
не можна. У БД поля `isCompleted` більше немає. Старий frontend має додати
обов'язковий `dueAt` та `estimatedDurationMinutes` до POST без підзадач; frontend у цьому етапі не змінюється.

Архівування: `PATCH { "archived": true }`; відновлення з архіву:
`PATCH { "archived": false }`. Це не змінює статус чи планування. Видалення
зберігає задачу та журнал у БД; подальші GET/PATCH/DELETE й запит історії для неї
повертають `404`. Відновлення видалених задач через API немає.

Події: `CREATED`, `EDITED`, `STATUS_CHANGED`, `ARCHIVED`, `UNARCHIVED`, `DELETED`.
Зміна пріоритету записується як `EDITED` із `metadata.before.priority` та
`metadata.after.priority` у тій самій транзакції, що й оновлення задачі.
PATCH, що змінює кілька незалежних аспектів задачі, створює відповідні події
в одній транзакції; повторне встановлення тих самих значень не створює подій.
Записи задачі й журналу атомарні. Транзакції мають ізоляцію `Serializable`;
конфлікти повторюються до трьох спроб, після чого API повертає `409`.
Помилки валідації повертають `400` з `error.message` та `error.details`,
невалідний UUID — `400`, відсутня чи видалена задача — `404`.

## Пропуск створеного виконання Routine: SKIPPED

Чинний `PATCH /api/tasks/:id` приймає `{ "status": "SKIPPED", "skipNote": "Причина" }`
лише для Task з routineOccurrence. Звичайна Task → `400`, навіть без причини.
У звичайному POST Task та POST/PATCH Subtask статус SKIPPED заборонений.
Пауза чи видалення шаблону Routine не прибирають зв'язок уже створеної Task.

skipNote — необов'язковий рядок із trim та довжиною 1–2000 символів після trim,
або null. На **новому** переході в SKIPPED пропущене поле/null означає відсутність
причини; cancellationNote очищається. Непорожній skipNote приймається лише для
результуючого статусу SKIPPED. Причину поточного пропуску можна змінити окремим
PATCH `{ "skipNote": "Нова причина" }` або очистити `{ "skipNote": null }`.
Порожній/пробільний рядок, понад 2000 символів та інші типи → `400`.

SKIPPED — окремий термінальний результат. Повні Task DTO списку (також архівного),
деталей, POST і PATCH містять nullable skipNote та обчислюваний `skippedAt: ISO UTC | null`.
skippedAt береться лише з достовірного **поточного реального** переходу в SKIPPED
у TaskAction. EDITED, updatedAt, archive і повторний same-status PATCH не задають
й не пересувають цей момент. Повторний незмінений PATCH не додає подій.
Зміна лише skipNote журналюється як EDITED; переходи в/зі SKIPPED — STATUS_CHANGED
зі snapshot статусу, cancellationNote та skipNote. Причина й статус зберігаються
атомарно з журналом; помилка події відкочує зміни.

Для SKIPPED: isCompleted=false, completedAt=null, isToday=false, isBacklog=false,
timeToCompletionSeconds=null. Task залишається у звичайному неархівованому списку:
пропуск не архівує й не видаляє її. ageSeconds зупиняється на поточному пропуску,
час у чотирьох робочих статусах під час пропуску не накопичується. Нового ключа
SKIPPED у statusDurationsSeconds немає. Спільний replay `tasks.history.ts` використовується
summary та перевіркою результату для DTO/AFTER_COMPLETION. Неповна, суперечлива чи
неоднозначна історія дає skippedAt=null і діагностику summary; generate без достовірної
основи → `409`. updatedAt не використовується як заміна.

PATCH `{ "status": "TODO" }` відкриває Task знову, очищає skipNote/skippedAt і
відновлює звичайні правила summary. Перехід DONE → SKIPPED дозволений як явна
зміна результату; SKIPPED → DONE знову використовує реальний completedAt.
Ручний пропуск не змінює дітей. Подальші мутації підзадач застосовують звичайні
правила синхронізації: вони можуть відкрити батька або перевести його в DONE;
при виході зі SKIPPED причина очищається. Нового блокування батька немає.
Архівовані Task приймають чинний Task PATCH; видалені повертають `404`.

AFTER_COMPLETION продовжується після DONE від completedAt або після SKIPPED від
skippedAt. Наступна дата — локальна дата цього instant у timezone **Routine** плюс
intervalDays календарних днів. У наступнику `basisType` дорівнює COMPLETED або SKIPPED,
`basisAt` — відповідний instant. `basisCompletedAt` збережено для сумісності:
він дорівнює basisAt лише для COMPLETED, для SKIPPED — null. Для календарних та
перших completion-виконань усі поля основи null. generation-preview адитивно повертає
basisType/basisAt/basisCompletedAt, отримані з БД або перевіреного кандидата;
клієнтські поля основи там і в generate відхиляються.

У read-only `/preview` старі completedAt + completedOccurrenceNumber збережені.
Альтернатива — **разом** skippedAt + skippedOccurrenceNumber, лише для AFTER_COMPLETION.
Змішування обох контекстів, неповна пара чи невалідні значення → `400`. Це лише
симуляція, а не запис пропуску. GET не створює Task, occurrence чи подій.

Уже створений наступник незмінний при reopen або зміні DONE ↔ SKIPPED попередника;
другий наступник не створюється. Календарна повторна генерація повертає ту саму
SKIPPED Task як existing. SKIPPED витрачає COUNT як уже створене виконання.
CANCELED/soft delete не продовжують ланцюжок; pause, DST, budgets, locks і Serializable
retry залишаються чинними.

Нова міграція `20261026120000_task_skipped` додає enum/колонки без очищення даних.
Наявним наступникам із basisCompletedAt заповнюються `basisType=COMPLETED` і
`basisAt=basisCompletedAt`; перші та календарні occurrences зберігають null.
CHECK constraints захищають Routine-only SKIPPED, заборону SKIPPED у Subtask та
узгодженість полів основи. Старі міграції не змінено.

### Postman: пропуск і наступник AFTER_COMPLETION

POST, Body → raw → JSON:

```http
POST {{baseUrl}}/api/routines
Content-Type: application/json

{
  "title": "Замінити фільтр",
  "estimatedDurationMinutes": 15,
  "timezone": "Europe/Kyiv",
  "startDate": "2026-01-01",
  "schedule": {
    "version": 1,
    "recurrence": { "type": "AFTER_COMPLETION", "intervalDays": 2 },
    "localTime": "09:00"
  },
  "endCondition": { "type": "COUNT", "count": 2 },
  "subtasks": [{ "title": "Замінити картридж", "estimatedDurationMinutes": 15 }]
}
```

Збережіть id як routineId. Створіть перше виконання й збережіть created[0].taskId як taskId:

```http
POST {{baseUrl}}/api/routines/{{routineId}}/generate
Content-Type: application/json

{ "from": "2026-01-01", "to": "2026-01-01" }
```

```http
PATCH {{baseUrl}}/api/tasks/{{taskId}}
Content-Type: application/json

{ "status": "SKIPPED", "skipNote": "  Цього разу не потрібно  " }
```

Очікується status=SKIPPED, skipNote="Цього разу не потрібно", достовірний skippedAt,
completedAt=null, isCompleted/isToday/isBacklog=false; дитина залишається TODO.
Повторіть цей PATCH, потім `{ "skipNote": "Інша причина" }`: skippedAt незмінний,
повтор без змін не створює події, зміна причини дає EDITED.

Обчисліть nextDate: локальна дата skippedAt у Europe/Kyiv + 2 календарних дні.
Наприклад, при пропуску локально 2026-10-26 nextDate=2026-10-28.
GET без body, потім POST:

```http
GET {{baseUrl}}/api/tasks/{{taskId}}
GET {{baseUrl}}/api/tasks?view=today
GET {{baseUrl}}/api/tasks?view=backlog
GET {{baseUrl}}/api/routines/{{routineId}}/generation-preview?from={{nextDate}}&to={{nextDate}}

POST {{baseUrl}}/api/routines/{{routineId}}/generate
Content-Type: application/json

{ "from": "{{nextDate}}", "to": "{{nextDate}}" }
```

Preview не записує даних; кандидат має basisType=SKIPPED, basisAt=skippedAt,
basisCompletedAt=null. POST створює одного наступника. PATCH попередника в TODO,
потім DONE і повтор generate повертають того самого наступника як existing.
Для simulation preview використайте пару skippedAt/skippedOccurrenceNumber=1;
не передавайте цю пару в generation-preview або generate.

Локальний opt-in PostgreSQL тест перевіряє міграції й backfill на даних старої схеми,
CHECK/unique/FK constraints, відкат через реальну помилку тригера журналу та конкурентні
skip/reopen/generate. Запуск — лише з окремим `ROUTINE_TEST_DATABASE_URL` на localhost,
у новій ізольованій схемі. Для перевірки використовувався тимчасовий PostgreSQL 17
із timezone UTC; DATABASE_URL/DIRECT_URL та Supabase не використовувалися.

## Підзадачі

Кожен Task у відповідях `GET /api/tasks` (зокрема архівному списку),
`GET /api/tasks/:id`, `POST /api/tasks` і `PATCH /api/tasks/:id` містить `subtasks`.
Це масив повних публічних DTO всіх невидалених підзадач незалежно від статусу,
відсортованих за `createdAt ASC`, потім `id ASC`. Без невидалених підзадач
повертається `[]`, зокрема при створенні Task без підзадач.
Підзадачі списку задач завантажуються через Prisma relation include без окремого
запиту для кожної задачі. Окремі маршрути підзадач повертають DTO підзадачі
(або їх масив для GET), а не Task.

| Запит | Поведінка |
| --- | --- |
| `GET /api/tasks/:taskId/subtasks` | Невидалені підзадачі за `createdAt ASC`, потім `id ASC`, відповідь `200` |
| `POST /api/tasks/:taskId/subtasks` | Створення, відповідь `201` із підзадачею |
| `PATCH /api/tasks/:taskId/subtasks/:subtaskId` | Редагування, відповідь `200` із підзадачею |
| `DELETE /api/tasks/:taskId/subtasks/:subtaskId` | М'яке видалення, відповідь `204` |

POST вимагає `title` (1–160 символів після обрізання пробілів) і додатне ціле
`estimatedDurationMinutes` до `2147483647`. Необов'язкові `status` (типово `TODO`)
та `cancellationNote`. PATCH приймає лише `title`, `status`,
`estimatedDurationMinutes`, `cancellationNote`; порожній PATCH і невідомі поля
відхиляються. Дозволені лише `TODO`, `IN_PROGRESS`, `PAUSED`, `POSTPONED`, `DONE`,
`CANCELED`; `SKIPPED` заборонений у POST/PATCH підзадач. Передача `status: "CANCELED"` в POST
або PATCH вимагає в тому самому запиті непорожню `cancellationNote`; причина
зберігається після наступних переходів. `plannedAt`, `dueAt`, `priority` у підзадач немає.
Відповідь містить `id`, `taskId`, `title`, `status`, `estimatedDurationMinutes`,
`cancellationNote`, `createdAt`, `updatedAt`, `deletedAt`. Поля `id` та `taskId` — UUID;
`taskId` визначається маршрутом. Дати створення й оновлення формуються сервером
і повертаються як ISO 8601; `deletedAt` у невидаленої підзадачі — `null`.
Непередана при створенні `cancellationNote` повертається як `null`; передане
значення має бути непорожнім рядком після обрізання пробілів. Явний `null`
для `cancellationNote` у POST/PATCH відхиляється. Власних `plannedAt` та `dueAt`
у підзадач немає; передавати їх у запитах не можна.

### Приклади запитів підзадач

У прикладах замініть `:taskId` UUID батьківської задачі, а `:subtaskId` — UUID
створеної підзадачі. Запити надсилаються до backend, типово `http://localhost:4000`.

Отримання списку (`200`, масив DTO або `[]`):

```http
GET /api/tasks/:taskId/subtasks
```

Створення (`201`, повний DTO зі статусом `TODO`):

```http
POST /api/tasks/:taskId/subtasks
Content-Type: application/json

{
  "title": "Зібрати вимоги",
  "estimatedDurationMinutes": 20
}
```

Редагування тривалості й статусу (`200`, оновлений DTO):

```http
PATCH /api/tasks/:taskId/subtasks/:subtaskId
Content-Type: application/json

{
  "estimatedDurationMinutes": 30,
  "status": "IN_PROGRESS"
}
```

Скасування з обов'язковою причиною (`200`, оновлений DTO):

```http
PATCH /api/tasks/:taskId/subtasks/:subtaskId
Content-Type: application/json

{
  "status": "CANCELED",
  "cancellationNote": "Вимоги вже надано"
}
```

М'яке видалення (`204`, без тіла відповіді):

```http
DELETE /api/tasks/:taskId/subtasks/:subtaskId
```

### Доступ і помилки

Невалідний UUID або дані дають `400`; відсутня чи видалена підзадача, неправильна
належність або видалена батьківська задача — `404`. Архівована задача дозволяє
читання списку, але POST/PATCH/DELETE підзадач дають `409`. Використано чинний
формат `error.message` і `error.details` для помилок валідації.

### Тривалість батьківської задачі

Поки є невидалені підзадачі, `estimatedDurationMinutes` батьківської задачі
дорівнює сумі їхніх `estimatedDurationMinutes` незалежно від статусів, включно
з `DONE` і `CANCELED`. Створення, редагування тривалості та м'яке видалення
підзадачі запускають перерахунок. Ручний PATCH тривалості задачі повертає `409`, навіть
якщо передано поточне значення. Після видалення останньої підзадачі остання сума
зберігається, а ручне редагування знову доступне. Сума понад `2147483647` дає `400`
та відкат усієї операції. Нова підзадача після цього знову визначає оцінку задачі.

### Автоматична синхронізація статусу

Після створення, зміни статусу або м'якого видалення підзадачі синхронізується
статус батьківської задачі. Поточна реалізація запускає синхронізацію також після
будь-якого іншого успішного PATCH підзадачі, зокрема редагування назви чи тривалості.
Враховуються лише невидалені підзадачі (`deletedAt: null`); `DONE` та `CANCELED`
також беруть участь. Правила застосовуються в наведеному порядку до першого збігу:

1. Невидалених підзадач немає — поточний статус батька зберігається.
2. Усі невидалені підзадачі мають статус `TODO` — батько переходить у `TODO`.
3. Усі невидалені підзадачі мають статус `DONE` — батько переходить у `DONE`.
4. Є хоча б одна невидалена підзадача `IN_PROGRESS` — батько переходить у `IN_PROGRESS`.
5. Є і `DONE`, і `TODO`, але немає `IN_PROGRESS` — поточний `PAUSED` або `POSTPONED`
   батька зберігається; для будь-якого іншого статусу встановлюється `IN_PROGRESS`.
   Це правило діє й за наявності додаткових підзадач `PAUSED`, `POSTPONED` чи `CANCELED`.
6. Для інших комбінацій поточний статус батька зберігається, зокрема для комбінацій
   із `PAUSED`, `POSTPONED` чи `CANCELED`, якщо попередні правила не спрацювали.

Ручна зміна статусу батьківської задачі, включно з `DONE` та legacy `isCompleted`,
не змінює статусів підзадач. Ручний `DONE` дозволений навіть із незавершеними
підзадачами. Подальші дії з підзадачами знову запускають автоматичну синхронізацію
за правилами вище, тому статус батька може змінитися.

### М'яке видалення та журнал

Журнал батьківської задачі містить `SUBTASK_CREATED`, `SUBTASK_EDITED`,
`SUBTASK_STATUS_CHANGED`, `SUBTASK_DELETED` із `metadata.subtaskId` і значеннями
`before`/`after`. Автоматичні зміни тривалості та статусу задачі записуються як
`EDITED` і `STATUS_CHANGED` із тим самим `subtaskId`. М'яке видалення зберігає
рядок підзадачі та журнал, встановлюючи `deletedAt`. Видалена підзадача більше
не входить до списків, суми тривалостей і синхронізації статусу; повторні PATCH
або DELETE повертають `404`. Операція, перерахунок і всі події атомарні в одній
транзакції `Serializable`; помилка будь-якого запису журналу відкочує всі зміни.

## Сфери задач (Areas)

Окремий модуль `src/modules/areas` змонтовано безпосередньо в `app.ts`.
Area DTO має `id` (UUID), `name`, `createdAt`, `updatedAt` (дати ISO 8601).
Назва обрізається по краях і має містити 1–80 символів. Однакові назви дозволені:
сфери розрізняються за ID. Сфери видаляються фізично; архівування, soft delete
і відновлення сфер відсутні. Auth, системних та користувацьких категорій сфер
на цьому етапі немає.

| Запит | Результат |
| --- | --- |
| `GET /api/areas` | `200`, масив усіх наявних сфер |
| `POST /api/areas` з `{ "name": "Робота" }` | `201`, Area DTO |
| `PATCH /api/areas/:id` з `{ "name": "Навчання" }` | `200`, Area DTO |
| `DELETE /api/areas/:id` | `204`, без тіла відповіді |

Списки впорядковано за `name ASC`, потім `id ASC` (порівняння назв визначає
collation PostgreSQL). PATCH вимагає `name`. Невідомі поля в body/query
відхиляються, як у Tasks: старий `archived` у body чи query дає `400`, включно
з `?archived=false`. Query-параметри для маршрутів Areas не передбачені;
DELETE приймає відсутнє або порожнє JSON-тіло. Невалідні ID, body, query
дають `400`, відсутня сфера при PATCH, DELETE чи призначенні — `404`. Використовується
чинний формат `error.message` / `error.details` і той самий request logger.

Видалення сфери зберігає всі задачі та підзадачі. У кожної пов'язаної задачі,
включно з архівованими й м'яко видаленими, очищається `areaId`, оновлюється
`updatedAt` і створюється `AREA_CHANGED` зі snapshot назви. Статус, планування,
тривалості, `archivedAt`, `deletedAt` задач та підзадачі не змінюються.
Повторний DELETE видаленої сфери дає `404`.

### Призначення сфери задачі

У POST `/api/tasks` необов'язкове `areaId`: пропущене поле або `null` означає
задачу без сфери. UUID має посилатися на наявну Area, інакше `404`. Це працює
і для звичайного створення, і для атомарного створення з `subtasks`.

У PATCH `/api/tasks/:id` пропущене `areaId` залишає сферу незмінною; `null`
очищає її; UUID призначає сферу. Повтор поточного `areaId`
не вважається зміною і не створює `AREA_CHANGED`. Підзадачі використовують сферу
батька: власних `areaId` / `area` у їхній моделі та DTO немає; поле в запиті
підзадачі відхиляється.

Усі повні Task DTO (GET списку/деталей, POST, PATCH) містять:

```json
{
  "areaId": "00000000-0000-4000-8000-000000000001",
  "area": {
    "id": "00000000-0000-4000-8000-000000000001",
    "name": "Робота"
  }
}
```

Без сфери обидва поля — `null`. Тут `area` показує поточну назву.
Зв'язок завантажується через Prisma `include` разом зі списком задач, без окремого
запиту сфери для кожної задачі. `subtasks`, `summary`, `isCompleted` та інші поля
збережені. Планова тривалість і правила статусів не змінені.

Перевірка призначення, запис задачі, підзадач і журналу відбуваються в одній
транзакції `Serializable` з чинними трьома спробами при конфліктах. Призначення,
перейменування й видалення блокують той самий рядок Area через параметризований
`SELECT ... FOR UPDATE` перед записами Task. Навіть PATCH із тим самим `areaId`
бере це блокування, не створюючи події. Операції з `areaId: null` не потребують
блокування сфери. При видаленні пов'язані задачі читаються без фільтрів архіву
чи видалення й обробляються за `id ASC`: оновлення Task, запис події, потім
фізичне видалення Area. Усе відбувається в одній транзакції; помилка будь-якого
запису відкочує всю операцію.

Якщо конкурентне видалення завершилося першим, повторна спроба призначення чи
перейменування поверне `404`. Якщо призначення завершилося першим, видалення
відв'яже цю задачу з подією. Serialization/deadlock від raw-запиту Prisma
нормалізуються до того самого механізму повторів; інші помилки не повторюються.
FK залишається `ON DELETE RESTRICT`: автоматичний `SET NULL` не використовується,
відв'язування й журналювання явно виконує сервіс.

### Історія сфери задачі

Новий `CREATED.metadata.after` містить `areaId` і `area: { id, name } | null`.
Реальна зміна сфери створює `AREA_CHANGED` в одній транзакції зі зміною задачі:

```json
{
  "before": { "areaId": null, "area": null },
  "after": {
    "areaId": "00000000-0000-4000-8000-000000000001",
    "area": { "id": "00000000-0000-4000-8000-000000000001", "name": "Робота" }
  }
}
```

Очищення сфери або її фізичне видалення записує
`before: { areaId, area: { id, name } }`, `after: { areaId: null, area: null }`.
Історичні назви — snapshot на момент події; перейменування не переписує їх.
Перейменування Area не створює подій у пов'язаних задачах. Видалення створює
по одній `AREA_CHANGED` для кожної пов'язаної задачі зі snapshot назви на момент
видалення, не переписуючи попередні події.
`AREA_CHANGED` не є переходом статусу та не впливає на summary або його
достовірність. Старі `CREATED` без полів сфери залишаються сумісними та не
доповнюються заднім числом. Старі metadata з `area.archivedAt` повертаються без
змін і залишаються сумісними з summary.

Адитивна міграція `20261024000000_task_areas` створює таблицю Area, додає
nullable `Task.areaId`, FK з `ON DELETE RESTRICT`, індекс `Task_areaId_idx`
і значення `AREA_CHANGED` до enum журналу. Наявні задачі отримають `areaId = null`;
дані не очищуються. Ця міграція вже застосована й не редагується.
Нова міграція `20261024010000_area_physical_deletion` прибирає лише колонку
`Area.archivedAt`, зберігаючи всі сфери та задачі. Колишні архівовані сфери
стають звичайними. Нова міграція підготовлена, під час цієї зміни не застосовувалась.

### Ручна перевірка в Postman

Задайте `baseUrl = http://localhost:4000`; для body оберіть raw JSON і
`Content-Type: application/json`. На БД для ручної перевірки спочатку має бути
застосована нова міграція окремим дозволеним процесом.

1. `POST {{baseUrl}}/api/areas` з `{ "name": "  Робота  " }` → `201`;
   збережіть повернутий ID як `areaId`.
2. `POST {{baseUrl}}/api/tasks` з body нижче → `201`; збережіть ID як `taskId`.
3. `GET {{baseUrl}}/api/tasks/{{taskId}}` і `GET {{baseUrl}}/api/tasks` →
   `areaId`, `area`, `subtasks`, `summary`, `isCompleted` присутні.
4. `PATCH {{baseUrl}}/api/areas/{{areaId}}` з `{ "name": "Проєкти" }`
   → `200`. GET задачі показує нову назву; CREATED в історії зберігає «Робота».
5. `PATCH {{baseUrl}}/api/tasks/{{taskId}}` з `{ "areaId": "{{areaId}}" }` →
   `200`, нової `AREA_CHANGED` немає.
6. `DELETE {{baseUrl}}/api/areas/{{areaId}}` → `204`, без тіла.
   GET задачі повертає `areaId: null`, `area: null` та новий `updatedAt`;
   статус і решта бізнес-полів збережені. GET списку сфер більше не містить її.
7. Повторний DELETE або PATCH видаленої сфери, а також призначення її задачі → `404`.
   `GET {{baseUrl}}/api/areas?archived=true` і PATCH із `{ "archived": false }` → `400`.
8. `GET {{baseUrl}}/api/tasks/{{taskId}}/history` містить `CREATED` і фактичні
   `AREA_CHANGED` зі snapshot назв. У кожному summary час залишається часом статусів.

```json
{
  "title": "Підготувати план",
  "dueAt": "2026-11-01T12:00:00Z",
  "estimatedDurationMinutes": 45,
  "areaId": "{{areaId}}"
}
```

Для атомарного створення додайте до цього body:
`"subtasks": [{ "title": "Зібрати вимоги", "estimatedDurationMinutes": 20 }]`.
Перевірте також випадковий валідний UUID сфери → `404`, неправильний UUID,
порожню назву чи невідоме поле → `400`.

## Routines — шаблони повторюваних задач

**Збереження Routine не створює жодного Task.** Генерація календарних та AFTER_COMPLETION виконань
запускається лише явним POST `/api/routines/:id/generate`. Cron, автоматичних
запусків із GET та frontend немає. `isToday` обчислюється лише для вже збережених
Task, як описано нижче. Read-only preview розраховує календарні
виконання, не створюючи Task, RoutineAction або інших записів.

| Метод і маршрут | Результат |
| --- | --- |
| `GET /api/routines` | `200`, усі невидалені Routine, включно з paused |
| `GET /api/routines/:id` | `200`, повний Routine DTO |
| `POST /api/routines` | `201`, повний Routine DTO |
| `PATCH /api/routines/:id` | `200`, повний Routine DTO |
| `DELETE /api/routines/:id` | `204`, м'яке видалення без body |
| `GET /api/routines/:id/history` | `200`, окремий журнал RoutineAction |
| `GET /api/routines/:id/preview?from=YYYY-MM-DD&to=YYYY-MM-DD` | `200`, проєкція поточного розкладу |
| `GET /api/routines/:id/generation-preview?from=YYYY-MM-DD&to=YYYY-MM-DD` | `200`, фактично допустимі кандидати generate за збереженим станом |
| `POST /api/routines/:id/generate` | `200`, до 100 нових календарних Task або одного AFTER_COMPLETION наступника |

Список: `createdAt DESC`, потім `id ASC`. Query-параметри дозволені лише для preview та generation-preview.
Невідомі поля й порожній PATCH відхиляються. Невалідні ID/body/query — `400`,
відсутня/видалена Routine або сфера при призначенні — `404`; вичерпані повтори
конфлікту транзакції — `409`. Формат помилок і request logging спільні з іншими
модулями. Видалені Routine та їхня історія недоступні через API; відновлення немає.

### Input і DTO

POST приймає такі поля; PATCH — лише передані поля з цього набору та `paused`:

| Поле | Контракт |
| --- | --- |
| `title` | обов'язковий у POST, trim, 1–160 символів, як у Task |
| `description` | рядок або `null`; default `null`, як у Task |
| `priority` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`; default `MEDIUM` |
| `areaId` | UUID або `null`; default `null`; лише наявна Area |
| `estimatedDurationMinutes` | додатне ціле до `2147483647`; обов'язкове без підзадач у POST |
| `subtasks` | default `[]`; впорядкований масив `{ title, estimatedDurationMinutes }` |
| `timezone` | обов'язковий IANA identifier, наприклад `Europe/Kyiv` |
| `startDate` | обов'язкова локальна дата `YYYY-MM-DD`, роки 0001–9999 |
| `schedule` | обов'язковий перевірений JSON версії 1, описаний нижче |
| `endCondition` | default `{ "type": "NEVER" }` |
| `paused` | лише PATCH, boolean; керує серверним `pausedAt` |

`schedule`, `endCondition` і `subtasks` при передачі замінюються цілком.
PATCH перевіряє весь результуючий стан: наприклад, новий `startDate` не може
стати пізнішим за збережену кінцеву дату. `null` очищає лише nullable-поля;
пропущені поля зберігаються. Без реальної зміни немає запису чи нової події.

За наявності підзадач тривалість дорівнює їхній сумі, навіть якщо передано іншу
додатну оцінку батька. Переповнення перевіряється до записів. Після PATCH
`{ "subtasks": [] }` зберігається остання тривалість, яку можна одразу замінити
переданим `estimatedDurationMinutes`. Порядок масиву визначає `position` від 0.
Змінений масив замінює всі шаблони й отримує нові UUID; однаковий масив зберігає ID.
Статусів, `cancellationNote`, `plannedAt`, `dueAt` у шаблонів підзадач немає.

Повний Routine DTO містить усі збережені поля:
`id`, `title`, `description`, `priority`, `areaId`, `area: { id, name } | null`,
`estimatedDurationMinutes`, `subtasks`, `timezone`, `startDate`, `schedule`,
`endCondition`, `pausedAt`, `deletedAt`, `createdAt`, `updatedAt`.
Підзадача DTO: `{ id, routineId, title, estimatedDurationMinutes, position }`.
Часові мітки — ISO 8601; `pausedAt` і `deletedAt` — nullable. `startDate` завжди
залишається рядком локальної дати. У Routine немає `status`, `isCompleted` чи Task summary.

### Розклад версії 1

Зовнішня форма: `{ "version": 1, "recurrence": { ... }, "localTime": null }`.
`localTime` — необов'язковий `HH:mm` (00:00–23:59) або `null`, default `null`.
Без часу це календарна дата/вікно, а не UTC-північ. Для вікна час сам по собі
не обирає конкретний день його виконання.

`recurrence` — discriminated union за `type`:

| `type` | Решта полів |
| --- | --- |
| `DAILY` | `intervalDays`: кожні N календарних днів від `startDate` |
| `WEEKLY` | `intervalWeeks`, `selection` одного з двох weekly-варіантів нижче |
| `MONTHLY` | `intervalMonths`, `selection` одного з трьох monthly-варіантів нижче |
| `AFTER_COMPLETION` | `intervalDays`: N календарних днів після фактичного завершення попереднього виконання |

Усі інтервали — додатні цілі до `2147483647`. Для `AFTER_COMPLETION` перше
виконання прив'язане до `startDate`; підтримано один день, без багатоденного
вікна. Preview наступної дати потребує явного контексту завершення, описаного нижче.

Weekly selection:

- `{ "type": "DAYS", "weekdays": [1, 4] }` — **два** виконання: понеділок і четвер.
  Номери ISO: понеділок 1 … неділя 7, без дублікатів; DTO сортує їх за зростанням.
- `{ "type": "WINDOW", "startWeekday": 6, "endWeekday": 7 }` — **одне** виконання
  з вікном субота–неділя. `startWeekday <= endWeekday`; вікно не переходить через
  межу тижня. Початок тижня — понеділок; інтервали відраховуються від тижня,
  який містить `startDate`, із подальшим обрізанням межами Routine.

Monthly selection:

- `{ "type": "DAY", "day": 31, "shortMonthPolicy": "SKIP" }`;
- `{ "type": "WINDOW", "startDay": 15, "endDay": 23, "shortMonthPolicy": "CLAMP" }`;
- `{ "type": "LAST_DAY" }` — останній календарний день місяця.

Дні — 1–31; вікно лежить в одному місяці, `startDay <= endDay`. Місячні інтервали
відраховуються від місяця `startDate`. Для DAY і WINDOW політика обов'язкова:
`SKIP` пропускає весь період, якщо хоча б одна необхідна межа відсутня;
`CLAMP` обмежує кожну межу останнім днем місяця. Наприклад, 30–31 у лютому
2026 при `SKIP` не дає вікна, при `CLAMP` дає 28–28. Вікно 15–23 завжди вміщується
в місяць, але політика все одно задається явно. Для LAST_DAY вона не потрібна.

### Загальний період дії й точність

`endCondition` — окремий union:

- `{ "type": "NEVER" }` — безстроково;
- `{ "type": "UNTIL_DATE", "date": "2026-11-07" }` — до локальної дати включно,
  не раніше `startDate`;
- `{ "type": "COUNT", "count": 7 }` — після N **запланованих виконань**.

COUNT означає виконання розкладу, а не кількість DONE. Пропущене користувачем
виконання рахуватиметься, періоди, пропущені через паузу Routine, — ні.
Межі вікна обрізаються `startDate` і кінцевою датою включно; порожній перетин
не утворює виконання. SKIP, який не дає жодного вікна, не утворює виконання.
Для Routine з однією версією календарний preview зберігає COUNT від початку розкладу
та відомі паузи. Після додавання версій COUNT — спільний ліміт матеріалізованих
виконань, описаний у розділі версій нижче; вже збережені виконання не забуваються.

Усі календарні правила належать timezone Routine. `startDate` зберігається
окремим рядком локальної дати, а розклад і завершення — як перевірені JSON;
дані не конвертуються наперед у UTC timestamps. Календарні дні не означають
`N × 24 години`. Календарний розрахунок винесений у чистий модуль
`src/modules/routines/routines.preview.ts`: валідовані Routine, from/to, limit,
нормалізовані паузи й необов'язковий контекст завершення є явними входами.
Прихованого поточного часу, I/O або генерації Task в ньому немає.
`@js-temporal/polyfill` забезпечує календарну арифметику та перевірку локального
часу на пропуски/повтори DST; у підтримуваному Node.js Temporal ще відсутній.
Timezone database використовує ICU Node.js, а не системний timezone сервера.

### Preview: контракт, паузи та обмеження

`GET {{baseUrl}}/api/routines/{{routineId}}/preview?from=2026-10-25&to=2026-11-07&limit=100`

`from` і `to` обов'язкові, локальні ISO-дати включно, `from <= to`.
Максимум 366 календарних днів включно (наприклад, 2026-01-01–2027-01-01).
`limit` — ціле 1–500, default 100. Невідомі, повторені або невалідні query-поля
та невалідний UUID → `400`; відсутній або видалений шаблон → `404`.
Деталі й history залишаються на чинних маршрутах; preview не додає власних полів до Task DTO.

Відповідь — `{ routineId, timezone, from, to, occurrences, truncated, limitations }`.
Приклад елемента для шаблону «Масаж» із POST нижче:

```json
{
  "occurrenceKey": "v1:<routineId>:daily:2026-10-25",
  "startDate": "2026-10-25",
  "endDate": "2026-10-25",
  "timezone": "Europe/Kyiv",
  "localTime": "18:00",
  "instant": "2026-10-25T16:00:00Z",
  "diagnostics": []
}
```

Для однієї версії це **проєкція поточної конфігурації**, включно для минулих дат, а не достовірна
історія виконань. `limitations` завжди містить `CURRENT_CONFIGURATION_PROJECTION`.
Зміни розкладу, timezone, startDate або endCondition у snapshots додають
`CONFIGURATION_CHANGED`. Зміни назви, сфери чи підзадач на календар не впливають.

Виконання включається за перетином його вікна з [from, to]; запит не обрізає вікно.
Наприклад, вікно 15–23 та from=20, to=21 повертає 15–23. Межі Routine обрізають
вікно включно. Одне вікно — один елемент, результати відсортовані хронологічно.
`occurrenceKey` використовує ID Routine та календарний період/вибір вікна
(для AFTER_COMPLETION — лише стабільний номер); він не залежить від from/to, limit чи
випадкового UUID. Це ключ календарного виконання, не остаточний механізм
захисту генерації Task від дублікатів у БД: для цього є окремі unique constraints.

`localTime: null` означає all-day: `instant: null`, без UTC-півночі.
Для заданого localTime `instant` — запланований початок на **першій даті вікна
після обрізання межами Routine**, а не обов'язковий день фактичного виконання
всередині вікна. Кінець вікна залишається датою, дедлайн 23:59:59 не створюється.
Неіснуючий час дає `instant: null`, `diagnostics: ["NONEXISTENT_LOCAL_TIME"]`;
неоднозначний — `instant: null`, `diagnostics: ["AMBIGUOUS_LOCAL_TIME"]`.
Offset не обирається й час не зсувається. Правила залежать від установленої ICU/tzdb.

PAUSED/RESUMED читаються одним запитом журналу в тій самій Serializable-транзакції,
що й Routine; запитів на кожне виконання немає. Початок паузи береться з
`PAUSED.metadata.after.pausedAt`, відновлення — з `RESUMED.timestamp`.
Моменти переводяться в локальні дати **поточного timezone Routine**.
Інтервал паузи — `[pauseDate, resumeDate)`: дата паузи включна, дата відновлення
вже активна. Пауза та відновлення одного локального дня не виключають жодного дня.
Відкрита поточна пауза не має кінця й виключає також майбутні початки вікон.
Виключається лише виконання, **початок обрізаного вікна** якого потрапив у паузу;
вікно, що почалося раніше, залишається. Пауза не зсуває прив'язку періодів.
Виключені виконання не витрачають COUNT; SKIP короткого місяця також не витрачає COUNT.

Відсутнє/повторене CREATED, порушений ланцюжок пауз, невідповідний поточний pausedAt
або переходи пауз із однаковим timestamp додають `PAUSE_HISTORY_UNCERTAIN`.
Для NEVER/UNTIL_DATE повертається проєкція з відомими паузами й цим обмеженням.
Для COUNT при такій невизначеності або зміні конфігурації повертаються
`occurrences: []`, `COUNT_HISTORY_UNCERTAIN`; точний залишок не вигадується.
Журнал без sequence/version не дозволяє виявити всі пропуски подій: узгоджені
snapshots не є доказом повноти історії. COUNT без діагностики є підрахунком
проєкції за наявним узгодженим журналом, а не підтвердженим числом створених Tasks.
Пошкоджені snapshots, як і в history, дають `500`.

Для AFTER_COMPLETION без контексту доступне лише перше виконання на startDate.
Щоб змоделювати наступне, передайте **разом** `completedAt` (ISO instant з Z або
offset) та `completedOccurrenceNumber` (ціле 1–2147483647, номер від 1).
Контекст для календарного режиму або завершення до локального startDate → `400`.
completedAt переводиться в локальну дату Routine, додаються N календарних днів;
перевіряються endCondition і паузи, повертається максимум одне наступне виконання.
Номер є явним припущенням клієнта, не перевіреним фактом виконання; нічого не
записується. `FUTURE_COMPLETIONS_REQUIRED` означає, що подальші дати залежать від
майбутніх завершень. Якщо наступна дата виходить за 9999 рік —
`CALENDAR_RANGE_EXCEEDED`, без виконання. Так само позначається тижневе вікно,
кінець якого виходить за 9999 рік і не обрізається явним UNTIL_DATE.

Без COUNT розрахунок одразу переходить до потрібного періоду. COUNT рахується
від початку; бюджет — 10000 відвіданих періодів на запит, у тижні максимум 7
кандидатів. Вичерпання дає `COMPUTATION_BUDGET_EXCEEDED` і лише обчислену частину
результатів, яка може бути порожньою, якщо бюджет скінчився до from.
Журнал обмежений 10000 подіями: читається максимум 10001 для виявлення перевищення;
`HISTORY_BUDGET_EXCEEDED` повертається з порожніми occurrences, без часткового
відновлення пауз. `truncated: true` означає лише, що знайдено додаткове виконання
понад limit. Рівно limit без додаткового результату дає false. При вичерпанні
бюджету повнота невідома й позначається в limitations незалежно від truncated.

Точні GET-приклади Postman (без body; {{routineId}} — ID відповідного POST):

```text
GET {{baseUrl}}/api/routines/{{routineId}}/preview?from=2026-10-25&to=2026-11-07&limit=100
```

Для «Масаж» нижче очікуються 25, 27, 29, 31 жовтня та 2, 4, 6 листопада;
`truncated: false`. При limit=6 — перші шість та `truncated: true`; при limit=7 — false.

Для «Щомісячний огляд» нижче (вікно 15–23):

```text
GET {{baseUrl}}/api/routines/{{routineId}}/preview?from=2026-11-20&to=2026-11-21
```

Одне виконання з startDate=2026-11-15, endDate=2026-11-23, instant=null.
Для «Замінити фільтр» нижче (90 днів після завершення першого; %2B — знак плюс):

```text
GET {{baseUrl}}/api/routines/{{routineId}}/preview?from=2027-01-01&to=2027-02-01&completedAt=2026-10-25T23%3A30%3A00%2B00%3A00&completedOccurrenceNumber=1
```

Завершення локально 2026-10-26 → одне наступне виконання 2027-01-24.

### Точні приклади POST для Postman

Для всіх прикладів: `POST {{baseUrl}}/api/routines`, raw JSON,
`Content-Type: application/json`, `baseUrl = http://localhost:4000`.

Масаж через день протягом двох тижнів (25 жовтня — 7 листопада включно):

```json
{
  "title": "Масаж",
  "estimatedDurationMinutes": 30,
  "timezone": "Europe/Kyiv",
  "startDate": "2026-10-25",
  "schedule": {
    "version": 1,
    "recurrence": { "type": "DAILY", "intervalDays": 2 },
    "localTime": "18:00"
  },
  "endCondition": { "type": "UNTIL_DATE", "date": "2026-11-07" }
}
```

Щомісячне вікно 15–23, без конкретного часу:

```json
{
  "title": "Щомісячний огляд",
  "estimatedDurationMinutes": 45,
  "timezone": "Europe/Kyiv",
  "startDate": "2026-11-01",
  "schedule": {
    "version": 1,
    "recurrence": {
      "type": "MONTHLY", "intervalMonths": 1,
      "selection": { "type": "WINDOW", "startDay": 15, "endDay": 23, "shortMonthPolicy": "SKIP" }
    }
  },
  "endCondition": { "type": "NEVER" }
}
```

Прибирання субота–неділя — одне виконання на тиждень, із шаблонами підзадач:

```json
{
  "title": "Прибирання",
  "timezone": "Europe/Kyiv",
  "startDate": "2026-10-25",
  "subtasks": [
    { "title": "Кухня", "estimatedDurationMinutes": 20 },
    { "title": "Кімнати", "estimatedDurationMinutes": 30 }
  ],
  "schedule": {
    "version": 1,
    "recurrence": {
      "type": "WEEKLY", "intervalWeeks": 1,
      "selection": { "type": "WINDOW", "startWeekday": 6, "endWeekday": 7 }
    }
  }
}
```

Тренування понеділок/четвер — два окремі виконання щотижня; завершення після восьми:

```json
{
  "title": "Тренування",
  "estimatedDurationMinutes": 60,
  "priority": "HIGH",
  "timezone": "Europe/Kyiv",
  "startDate": "2026-10-26",
  "schedule": {
    "version": 1,
    "recurrence": {
      "type": "WEEKLY", "intervalWeeks": 1,
      "selection": { "type": "DAYS", "weekdays": [1, 4] }
    },
    "localTime": "09:00"
  },
  "endCondition": { "type": "COUNT", "count": 8 }
}
```

Заміна фільтра через 90 календарних днів після завершення попереднього виконання:

```json
{
  "title": "Замінити фільтр",
  "estimatedDurationMinutes": 15,
  "timezone": "Europe/Kyiv",
  "startDate": "2026-10-25",
  "schedule": {
    "version": 1,
    "recurrence": { "type": "AFTER_COMPLETION", "intervalDays": 90 }
  }
}
```

### Історія, сфери й ручні перевірки

RoutineAction має `id`, `routineId`, `type`, `timestamp`, `metadata: { before, after }`.
CREATED містить `before: null`; інші події — повні before/after snapshots Routine DTO,
включно зі збереженою назвою сфери й шаблонами підзадач. Типи: CREATED, UPDATED,
PAUSED, RESUMED, DELETED. Якщо PATCH одночасно редагує поля й перемикає паузу,
записуються UPDATED та PAUSED/RESUMED з повними snapshots однієї мутації.
Історія сортується `timestamp ASC`, `id ASC`; UUID при однаковому часі не є порядком
фактичного запису. При читанні DTO та історії JSON перевіряється; пошкоджені або
непідтримувані дані дають `500`, а не передаються клієнту як валідний розклад.

Усі мутації та їхній журнал — одна транзакція Serializable з трьома спробами при
конфліктах. Фізичне видалення Area атомарно обробляє Task за чинними правилами,
потім усі Routine за ID, включно з paused і deleted: `areaId` очищається,
`updatedAt` оновлюється, створюється UPDATED зі snapshot назви. Статус паузи,
розклад і підзадачі зберігаються. Історичні назви не замінюються поточною назвою.
TaskAction не використовується для шаблонів. Спільне блокування Area перед
записами Task/Routine захищає від конкурентного призначення видаленої сфери.

Після POST збережіть `routineId` у Postman. Перевірте:

1. `GET /api/routines/{{routineId}}` та `GET /api/routines` — шаблон доступний;
   `GET /api/tasks` не отримав нової задачі через створення Routine.
2. `PATCH /api/routines/{{routineId}}` з `{ "paused": true }`, потім із
   `{ "paused": false }`; повтор того самого значення не додає події.
3. PATCH з `{ "areaId": "{{areaId}}" }` для наявної сфери, потім її DELETE —
   шаблон залишається з `areaId: null`; історія містить назву видаленої сфери.
4. `GET /api/routines/{{routineId}}/history` — окремі події шаблону.
5. DELETE шаблону → `204`; подальші GET/PATCH/DELETE та GET history → `404`.

Міграція `20261025000000_routines` додає лише нові таблиці, enum, FK та індекси,
без очищення даних чи редагування старих міграцій. Вона не застосовувалась у цьому
кроці. Для ручної перевірки БД має окремо отримати цю міграцію.
Тести використовують спільний підставний Prisma та локальний HTTP-сервер;
вони перевіряють preview, CRUD та журнал. Окремий opt-in тест генерації нижче
перевіряє також реальні constraints, транзакції й конкурентні HTTP-запити на PostgreSQL.

### Версії календарного розкладу Routine

| Запит | Контракт |
| --- | --- |
| `GET /api/routines/:id/schedule-versions` | Масив незмінних версій за number ASC |
| `POST /api/routines/:id/schedule-versions` | Явне створення нової версії, `201` і повний DTO версії |

POST вимагає **всі** поля: effectiveDate, timezone, startDate, schedule, endCondition.
Це повний календарний snapshot, не частковий PATCH. Формати календарних полів ті самі,
що у POST Routine; невідомі поля/невалідні дати → `400`. Назва, опис, пріоритет,
area, duration та шаблони підзадач у версію не входять: нові Task отримують чинні
шаблонні поля під час явної генерації, створені Task зберігають свої snapshots.

Версія містить id, routineId, number (1, 2, …), effectiveDate, effectiveTimezone,
effectiveAt (ISO UTC), timezone, startDate, schedule, endCondition та createdAt.
`Routine.schedule/timezone/startDate/endCondition` відображають **останню збережену**
версію, також якщо вона ще майбутня; для календарного відбору використовується
історія версій. Початкова версія створюється атомарно разом із Routine.
scheduleVersionId зберігається на occurrence; чинний повний Task DTO не втрачає полів.

**Часова межа:** effectiveDate інтерпретується як початок локального календарного дня
в **незмінному timezone першої версії** — effectiveTimezone. Він не змінюється при зміні
timezone нового розкладу. Наприклад, для першого Europe/Kyiv дата 2026-11-01 означає
2026-10-31T22:00:00Z навіть якщо новий timezone — America/Los_Angeles.
Temporal враховує DST та початок реального локального дня; фіксованих 24 годин немає.
effectiveDate та effectiveAt мають бути строго пізнішими за попередню версію,
effectiveAt — строго майбутнім щодо серверного instant після блокування Routine.
Поточний уже розпочатий день і минулі дати → `409`; початкова версія може мати
історичний startDate. startDate у новій конфігурації — прив'язка періодичності,
а effectiveDate — межа застосування, тому це окремі поля.

Збережені версії не редагуються й не видаляються. Реальна зміна календаря звичайним
PATCH → `409` з вимогою POST schedule-versions, **також до першої генерації**.
Ідентичні календарні поля в PATCH дозволені. Звичайний PATCH назви, опису, пріоритету,
сфери, тривалості, дітей і paused працює як раніше та не створює календарної версії.
Подія SCHEDULE_VERSION_CREATED містить повні before/after snapshots Routine,
effectiveDate, scheduleVersionId та versionNumber; insert, зміна календарного mirror
Routine і подія — одна Serializable-транзакція. Помилка журналу відкочує все.

**Вибір версії та перетини:** preview, generation-preview і generate використовують
спільний resolver. Початок **цілого** вікна — локальна північ startDate у timezone
цього occurrence — має належати інтервалу `[effectiveAt, nextEffectiveAt)`.
Перша версія покриває свій початковий розклад до наступної межі. localTime не змінює
належність версії. Тижневий або місячний window, що почався до межі, залишається
цілим у старій версії; endDate не обрізається датою зміни. Власні startDate/UNTIL_DATE
конфігурації зберігають чинне обрізання. from/to — локальні календарні дати кожного
відповідного розкладу, не штучні timestamps кінця дня.

Для перевірки семантичного перетину календарне вікно переводиться у напіввідкритий
UTC-інтервал від локального початку startDate до початку дня **після** endDate.
Це працює при різних timezone та DST. Збережене occurrence завжди має пріоритет:
повертається existing з тим самим taskId незалежно від DONE, SKIPPED, soft delete,
архіву, plannedAt або того, чи відповідає воно новому розкладу. У кількох версіях
existing включає всі збережені вікна запитаного діапазону, також поза новою проєкцією;
вікно, яке пригнітило конфліктний кандидат, теж повертається як existing.
Без збереженого occurrence серед кандидатів перемагає найраніший початок вікна,
потім номер версії/occurrenceKey. Інші кандидати, що перетинаються, не створюються.

За наявності перетину preview/generation-preview/generate адитивно містять `conflicts`:

```json
{
  "conflicts": [{
    "code": "STORED_WINDOW_CONFLICT",
    "occurrenceKey": "<пригнічений новий ключ>",
    "retainedOccurrenceKey": "<збережений старий ключ>",
    "retainedTaskId": "<taskId>"
  }]
}
```

VERSION_WINDOW_CONFLICT означає перетин двох ще не створених кандидатів;
retainedTaskId тоді null. Решта неконфліктних кандидатів обробляється звичайно;
`200` з conflicts означає явний пропуск кандидата, а не заміну існуючої Task.
За відсутності конфліктів поле не додається, чинні response envelopes збережені.
У calendar preview з кількома версіями також враховуються збережені вікна;
GET залишається read-only. Обмеження/неповна історія не приховуються.

Для першої версії occurrenceKey не змінюється. Для наступних календарних і
completion-версій додається `:schedule:<number>`. Це інвалідує застарілий planning,
але **не є захистом від семантичних дублікатів**: resolver перевіряє вікна,
а транзакції беруть Area → Routine → остання completion Task, як раніше.
Усі writers використовують один Routine lock, Serializable та повтори конфліктів;
unique/FK constraints й immutable/order trigger захищають версії та належність occurrence.
Planning приймається лише за ключами поточного generation-preview; старий ключ
для ще не створеного виконання → `400` без записів. Existing ніколи не переплановується.

**Умови завершення:** після появи кількох версій calendar COUNT — верхня межа
загальної кількості матеріалізованих виконань Routine. Усі збережені occurrences,
також майбутні, SKIPPED, скасовані й видалені, резервують місця. Нові кандидати
поточного запиту витрачають залишок у детермінованому порядку початку вікна.
Нематеріалізовані вікна попередніх версій не є використаними місцями; порядок
окремих запитів generate визначає, які вікна будуть матеріалізовані першими.
Новий COUNT не може бути меншим за вже збережену кількість (`409`), але може
дорівнювати їй або збільшуватись; автоматичного скидання немає. Одноверсійний
calendar COUNT та його підрахунок планових вікон від початку залишені для сумісності.
UNTIL_DATE діє на нові кандидати відповідної версії й не змінює/видаляє старі
майбутні occurrences. Дата до effectiveDate може означати порожній майбутній хвіст,
якщо вона валідна щодо startDate. NEVER прибирає ліміт лише для кандидатів своєї версії.

AFTER_COMPLETION зберігає один ланцюжок: occurrenceNumber не скидається,
previousOccurrenceId та basisType/basisAt/basisCompletedAt незмінні у збережених
наступників. Для DONE основа — перевірений completedAt, для SKIPPED — skippedAt.
Для кожної версії обчислюється локальна дата основи в її timezone + intervalDays;
кандидат має належати цій версії за своїм початком вікна. Якщо підходить кілька,
обирається найраніший; якщо жодного — `409 VERSION_BOUNDARY_NO_CANDIDATE`, без
автоматичного зсуву. Потім застосовуються COUNT/UNTIL_DATE, паузи та DST.
COUNT тут завжди враховує всі створені номери через усі версії. Reopen або зміна
DONE ↔ SKIPPED попередника не пересуває й не дублює вже збереженого наступника.
Перехід calendar ↔ AFTER_COMPLETION і зміна startDate у AFTER_COMPLETION → конкретний
`409`: для цього кроку створіть окрему Routine. Перехід DAILY/WEEKLY/MONTHLY підтримується.
Старі completion/skipped контексти simulation preview збережені та не є фактами БД.

Пауза блокує generation-preview/generate, але не видаляє Tasks; додавання майбутньої
версії paused Routine дозволене. Soft-deleted Routine, як раніше, недоступна.
Бюджети: максимум 100 версій, 10000 збережених occurrences для перевірки перетинів,
100 нових Tasks за POST, чинні діапазон/календарні/історичні бюджети збережені.
Перевищення → `409` без часткового запису.

Міграція `20261026130000_routine_schedule_versions` створює першу версію з поточного
збереженого календаря **кожної** Routine, включно з paused/deleted, і прив'язує до неї
існуючі occurrences. Старі Tasks, snapshots, ключі, дати й зв'язки ланцюжка не
переписуються; штучних подій backfill не додає. Старі діагностики змін конфігурації
в legacy-журналі одноверсійної Routine зберігаються.

### Postman: новий розклад зі збереженими майбутніми задачами

Для Routine із початковим startDate=2026-10-25, Europe/Kyiv і DAILY intervalDays=2
створіть майбутні виконання та збережіть їхні taskId:

```http
POST {{baseUrl}}/api/routines/{{routineId}}/generate
Content-Type: application/json

{ "from": "2026-11-02", "to": "2026-11-04" }
```

Поки 2026-11-01 ще майбутня дата у початковому timezone, створіть версію
(при пізнішому запуску замініть дати на майбутні):

```http
POST {{baseUrl}}/api/routines/{{routineId}}/schedule-versions
Content-Type: application/json

{
  "effectiveDate": "2026-11-01",
  "timezone": "Europe/Kyiv",
  "startDate": "2026-11-01",
  "schedule": { "version": 1, "recurrence": { "type": "DAILY", "intervalDays": 1 }, "localTime": "09:00" },
  "endCondition": { "type": "NEVER" }
}
```

```http
GET {{baseUrl}}/api/routines/{{routineId}}/schedule-versions
GET {{baseUrl}}/api/routines/{{routineId}}/preview?from=2026-10-30&to=2026-11-05
GET {{baseUrl}}/api/routines/{{routineId}}/generation-preview?from=2026-11-01&to=2026-11-05
GET {{baseUrl}}/api/routines/{{routineId}}/history
```

Preview показує два STORED_WINDOW_CONFLICT для 2 і 4 листопада. GET не робить записів.
Повторіть generate для 1–5 листопада: нові задачі лише 1, 3, 5; 2 і 4 повернуться
як existing з попередніми taskId та незмінними plannedAt/статусами/дітьми.
Повтор того самого POST → createdCount=0. Спроба використати старий preview key
для ще не збереженого вікна → `400`; отримайте актуальний generation-preview.

### Явна генерація календарних Task

`POST {{baseUrl}}/api/routines/{{routineId}}/generate`, Body → raw → JSON:

```json
{
  "from": "2026-10-25",
  "to": "2026-11-07"
}
```

from/to — два обов'язкові поля: локальні ISO-дати включно, from <= to, не більше
366 календарних днів включно. Додатково дозволений необов'язковий planning, описаний
нижче. Query, limit, completedAt та completedOccurrenceNumber
у цьому API не підтримуються. Невалідний UUID/body → `400`, відсутня/видалена
Routine → `404`. Поточна пауза, недостовірна історія/COUNT,
unresolved DST, вичерпаний бюджет або понад 100 **нових** задач → `409` із безпечним
`error.message`. Весь запит відхиляється до записів; перші 100 мовчки не створюються.

Відповідь `200` містить лише посилання, без повних Task DTO:

```json
{
  "routineId": "<routineId>",
  "from": "2026-10-25",
  "to": "2026-11-07",
  "createdCount": 1,
  "existingCount": 0,
  "created": [
    { "occurrenceKey": "v1:<routineId>:daily:2026-10-25", "taskId": "<taskId>" }
  ],
  "existing": []
}
```

Розрахунок повторно використовує чистий модуль preview, його прив'язку до startDate,
COUNT від початку, короткі місяці та правило пауз `[pauseDate, resumeDate)`.
Діапазон включає виконання за перетином вікна, зберігаються **повні** межі вікна.
`CURRENT_CONFIGURATION_PROJECTION` саме по собі дозволене; інші невирішені
limitations, крім узгодженого `CONFIGURATION_CHANGED` для не-COUNT, блокують запит.
Перевіряються всі кандидати та їхні DST diagnostics, навіть якщо вони вже існують.
All-day із instant=null є коректним. Максимум результатів внутрішнього розрахунку —
500 (календарний діапазон до 366 днів); будь-який truncated також блокує генерацію.

Для достовірності перевіряється ланцюжок schedule/timezone/startDate/endCondition
та pausedAt у snapshots журналу до поточного стану. Ідентичні UPDATED та
PAUSED/RESUMED однієї мутації враховуються разом; неоднозначні зміни з однаковим
timestamp відхиляються. Узгоджений журнал без sequence/version все одно не дозволяє
виявити всі зовнішні пропуски або ручні зміни БД; історія, записана API, є джерелом
для генерації. При видимій неповноті генерація не робить припущень.

Реальні календарні зміни в PATCH → `409`; використовуйте явну операцію версії
з effectiveDate, описану вище. Ідентичний PATCH дозволений. Назва, опис, пріоритет,
сфера, тривалість, діти та пауза редагуються як раніше. Збережені occurrence й Task
не переписуються. У кількох версіях existing включає також збережені вікна, яких
більше немає у новій проєкції; семантичні перетини повертаються в conflicts.

Для legacy-журналів із календарними змінами до впровадження версій зберігаються
консервативний guard дати останньої зміни й COUNT_HISTORY_UNCERTAIN. Після явного
додавання версій межі визначає збережена історія версій, а не timestamp редагування.

RoutineOccurrence містить UUID, routineId, occurrenceKey, локальні startDate/endDate,
timezone, nullable localTime/instant, повний snapshot Routine на момент генерації
та createdAt. `UNIQUE(routineId, occurrenceKey)` виключає дублікати календарних
виконань. Nullable `Task.routineOccurrenceId` має UNIQUE та FK RESTRICT, тому
одному виконанню відповідає максимум одна Task. У звичайних задач зв'язок відсутній.
API фізичного видалення occurrence немає. Soft delete Task зберігає зв'язок;
повторний POST повертає той самий taskId у existing, не відновлює й не замінює задачу.
Її звичайний GET далі повертає `404`. DONE/архівування також не створюють заміни.

Усі нові Task і копії підзадач створюються в TODO зі своїми UUID. Копіюються назва,
опис, пріоритет і сфера; з дітьми тривалість є сумою шаблонів. dueAt початково null;
plannedAt також null, якщо для нового виконання не передано planning. Це особистий
план/дедлайн, а календарні межі зберігаються в occurrence.
Звичайний POST `/api/tasks` усе ще вимагає dueAt. Обидва шляхи використовують
спільну доменну функцію створення Task/Subtasks та CREATED/SUBTASK_CREATED.
CREATED містить `origin: { type: "ROUTINE", routineId }` і `routineOccurrence`
зі знімком календарного виконання та його конфігурації. Summary відраховується
від фактичного createdAt Task, навіть якщо startDate виконання була в минулому.

Усі повні Task DTO додають поле:

```json
{
  "routineOccurrence": {
    "id": "<occurrenceId>",
    "routineId": "<routineId>",
    "occurrenceKey": "v1:<routineId>:daily:2026-10-25",
    "startDate": "2026-10-25",
    "endDate": "2026-10-25",
    "timezone": "Europe/Kyiv",
    "localTime": "18:00",
    "instant": "2026-10-25T16:00:00.000Z",
    "occurrenceNumber": null,
    "previousOccurrenceId": null,
    "basisCompletedAt": null,
    "basisType": null,
    "basisAt": null
  }
}
```

Для звичайної Task це null. area, subtasks, summary, isCompleted та інші чинні
поля збережені. Зв'язок завантажується разом із Task через include, без N+1;
великий snapshot конфігурації до Task DTO не потрапляє.

Усі occurrence, Task, діти й події одного POST — одна Serializable-транзакція
із трьома спробами та timeout 30 секунд. Блокування Area → Routine узгоджене
з призначенням/видаленням Area; PATCH, пауза й DELETE Routine беруть той самий
lock Routine. Унікальні конфлікти виконання та serialization/deadlock конфлікти
повторюють всю операцію; після вичерпання повертається безпечний `409`, без сирих
Prisma-помилок. Повтор після втраченого успішного HTTP response також ідемпотентний.

### Planning нових Task під час generate

`POST /api/routines/:id/generate` адитивно приймає необов'язковий масив:

```json
{
  "from": "2026-10-25",
  "to": "2026-11-07",
  "planning": [
    {
      "occurrenceKey": "v1:<routineId>:daily:2026-10-25",
      "plannedAt": "2026-10-25T16:00:00+02:00"
    }
  ]
}
```

Старий body без planning та planning=[] еквівалентні. Запис planning має рівно
occurrenceKey (непорожній рядок до 512 символів) та plannedAt (валідний ISO timestamp
із Z або явним offset; null і дата без часу не приймаються). Timestamp зберігається
як UTC instant: наведений приклад → `2026-10-25T14:00:00.000Z`.
Максимум 100 записів для календарного режиму, максимум 1 для AFTER_COMPLETION —
відповідно до чинного максимального обсягу нової генерації. Дублікати ключів,
зайві поля, невалідні timestamps і перевищення ліміту planning → `400`.

Кожен ключ перевіряється за **результатом поточного resolver для цієї Routine та
діапазону**. Сам рядок не є дозволом отримати довільну Task; клієнтські ключі не
використовуються для пошуку чужих задач. Невідомий, чужий, поза діапазоном або
більше не допустимий ключ → `400` до будь-якого запису, відхиляється весь набір.
Перевірки пауз, COUNT, DST, історії, бюджетів та ліміту нових Task залишаються
чинними і можуть блокувати сам resolver через `409`.

План застосовується **лише при створенні нової Task**. Нові виконання без запису
в planning отримують plannedAt=null. plannedAt може бути поза вікном — це явний
особистий план. schedule, localTime, instant, межі occurrence, dueAt та Routine
не переписуються; план не розв'язує DST-проблем самого розкладу.
Спільна доменна функція створення Task отримує plannedAt одразу: CREATED.snapshot
(`metadata.after`) містить фактичний plannedAt, штучної EDITED після створення немає.
Summary відраховується від createdAt Task, а не від plannedAt чи дати occurrence.

Existing, включно з DONE і soft-deleted, повертаються з тими самими taskId; їхній
plannedAt та журнал не змінюються навіть при іншому planning у повторному POST.
Подальше перепланування робиться через чинний PATCH `/api/tasks/:id`. При двох
конкурентних POST із різними планами перемагає транзакція, яка створила виконання;
після retry інша повертає existing і не перезаписує її план. Валідація всього map,
occurrence, Task, копії підзадач та журнал — одна атомарна транзакція.
Формат успішної відповіді created/existing не змінений; planning у відповідь не додається.

### Generation-preview: фактичні кандидати перед POST

```http
GET {{baseUrl}}/api/routines/{{routineId}}/generation-preview?from=2026-10-25&to=2026-11-07
```

from/to обов'язкові, локальні ISO-дати включно, максимум 366 днів. Інші query-поля
(включно з planning, limit, completedAt і completedOccurrenceNumber) → `400`.
Невалідний UUID → `400`, відсутня/видалена Routine → `404`. Поточна пауза та
будь-які доменні перешкоди generate → той самий `409`, без часткового списку.
Зокрема діапазон із понад 100 новими календарними Task треба зменшити також для
generation-preview. Це відрізняється від simulation preview з власним limit.

Приклад відповіді (нижче один елемент; фактичний масив містить усіх кандидатів):

```json
{
  "routineId": "<routineId>",
  "timezone": "Europe/Kyiv",
  "from": "2026-10-25",
  "to": "2026-11-07",
  "occurrences": [
    {
      "occurrenceKey": "v1:<routineId>:daily:2026-10-25",
      "startDate": "2026-10-25",
      "endDate": "2026-10-25",
      "timezone": "Europe/Kyiv",
      "localTime": "18:00",
      "instant": "2026-10-25T16:00:00.000Z",
      "diagnostics": [],
      "existing": false
    }
  ]
}
```

GET використовує **той самий resolver кандидатів**, що POST: для AFTER_COMPLETION
завершення й номер беруться виключно зі збереженого ланцюжка та TaskAction.
Повертається максимум один новий наступник, без прогнозування наступних завершень.
Existing визначаються за чинними правилами повтору; для них повертаються збережені
календарні дані та existing=true. taskId, plannedAt, статус, назва й інший вміст
Task не розкриваються, зокрема для м'яко видалених задач.

Жодних записів, генерації або подій у GET немає. Читання виконується в
Serializable-транзакції з тим самим порядком SELECT locks Area → Routine → Task
для узгодженого snapshot. Вміст наявного `/preview` не змінено: він лишається
read-only симуляцією з необов'язковим **клієнтським** completion-контекстом.

Відповідь generation-preview — **знімок, не резервування**. POST знову читає й
перевіряє стан у своїй транзакції. Якщо planning-ключ більше не входить у допустимий
результат за цим діапазоном, відповідь `400` з повідомленням
`Refresh generation-preview and retry.` — оновіть GET, ключі та повторіть POST.
Якщо стан тепер блокує саму генерацію (наприклад, reopen, пауза чи невизначене
завершення), повертається `409`; також слід оновити preview після усунення причини.
План ніколи не переноситься на інший ключ. Якщо цей ключ уже existing, його план
ігнорується за правилами retry; нові виконання без власного запису planning мають null.

Точний Postman-сценарій часткового планування «Масаж»:

1. Виконайте GET generation-preview вище для massageRoutineId і скопіюйте три
   occurrenceKey за 25, 29 жовтня та 6 листопада.
2. `POST {{baseUrl}}/api/routines/{{massageRoutineId}}/generate`, raw JSON:

```json
{
  "from": "2026-10-25",
  "to": "2026-11-07",
  "planning": [
    { "occurrenceKey": "v1:{{massageRoutineId}}:daily:2026-10-25", "plannedAt": "2026-10-25T16:00:00+02:00" },
    { "occurrenceKey": "v1:{{massageRoutineId}}:daily:2026-10-29", "plannedAt": "2026-10-29T19:45:00+05:45" },
    { "occurrenceKey": "v1:{{massageRoutineId}}:daily:2026-11-06", "plannedAt": "2026-12-20T09:00:00-05:00" }
  ]
}
```

Для нового шаблону створиться 7 Task: у трьох plannedAt відповідно
`2026-10-25T14:00:00.000Z`, `2026-10-29T14:00:00.000Z`, `2026-12-20T14:00:00.000Z`,
у решти — null; dueAt у всіх null. Останній план навмисно поза вікном.
Повтор із іншими plannedAt поверне existing і не змінить Task або CREATED.

Для AFTER_COMPLETION після реального DONE останньої Task отримайте наступника:

```http
GET {{baseUrl}}/api/routines/{{completionRoutineId}}/generation-preview?from=2026-10-26&to=2026-11-07
```

Post-response script для копіювання фактично доступного нового ключа:

```javascript
pm.environment.unset("nextOccurrenceKey");
const candidate = pm.response.json().occurrences.find(o => !o.existing);
if (candidate) pm.environment.set("nextOccurrenceKey", candidate.occurrenceKey);
```

Якщо нового кандидата немає, planning для наступника не надсилайте. Інакше:

```http
POST {{baseUrl}}/api/routines/{{completionRoutineId}}/generate
```

```json
{
  "from": "2026-10-26",
  "to": "2026-11-07",
  "planning": [
    { "occurrenceKey": "{{nextOccurrenceKey}}", "plannedAt": "2026-11-01T09:00:00+02:00" }
  ]
}
```

Номер і момент результату клієнт не задає. Якщо остання Task ще не DONE/SKIPPED та в діапазоні
немає existing, GET поверне 409 за чинним правилом очікування завершення.

### AFTER_COMPLETION: генерація зі збереженого завершення

Той самий POST `/api/routines/:id/generate` і body `{ from, to }` з необов'язковим
planning, описаним вище, той самий
формат created/existing. Клієнт **не передає** completedAt чи номер виконання:
ці поля в generate дають `400`. Контекст GET preview залишається окремим read-only
моделюванням і ніколи не стає фактом завершення. GET та перехід Task у DONE/SKIPPED самі
нічого не генерують. Один POST створює максимум **одне** нове виконання.

Без попередніх виконань кандидат — рівно startDate. Він створюється лише за
потрапляння в [from, to], з endCondition, timezone, localTime та перевіркою DST.
Дата запиту не пересуває перше виконання. Далі останнє виконання визначається
за occurrenceNumber, а не createdAt, UUID чи останнім відредагованим Task.

Для продовження остання Task має бути невидаленою й зараз DONE або SKIPPED. Спільний
із summary аналіз TaskAction перевіряє CREATED і весь ланцюжок STATUS_CHANGED до поточного стану. completedAt —
timestamp останнього реального переходу з іншого статусу в DONE; same-status DONE
не є новим завершенням. Для SKIPPED аналогічно використовується skippedAt реального
поточного переходу. EDITED, AREA_CHANGED та archive не змінюють ці моменти.
Автоматичний STATUS_CHANGED від підзадач перевіряється так само, як ручний.
Відсутнє CREATED, зламаний ланцюжок, події поза життям Task, кілька реальних
переходів з однаковим timestamp, невідповідність поточному статусу або вичерпаний
бюджет історії → `409`, без записів. Журнал без sequence/version не доводить
відсутності всіх невидимих пропусків, але видимі суперечності не ігноруються.

completedAt (DONE) або skippedAt (SKIPPED) переводиться в локальну дату timezone Routine, додаються intervalDays
**календарних** днів. Спільний helper використовується preview і generate; немає
другого алгоритму або додавання N × 24 годин. localTime застосовується до отриманої
дати; без нього instant=null. Нерозв'язаний DST → `409`; час не зсувається й offset
не обирається. Збережене завершення до локального startDate або вихід календаря
за 9999 рік також відхиляються явно, відповідно до чинного preview helper.

**Точне правило retry/продовження:**

1. Повертаються всі збережені виконання, які перетинають запитаний діапазон, у
   `existing`, у порядку occurrenceNumber. Сюди можуть входити ID видалених задач.
2. Якщо остання Task не DONE/SKIPPED, скасована або видалена, але є такі existing,
   відповідь — `200`, createdCount=0. Це дозволяє повторити успішний POST, коли
   щойно створений наступник ще TODO. Запит без existing у новий діапазон → `409`
   із поясненням очікування або зупиненого ланцюжка.
3. Якщо остання Task DONE/SKIPPED із перевіреною історією й кандидат входить у діапазон,
   створюється один наступник; старі existing можуть бути в тій самій відповіді.
   Повтор після цього поверне нового наступника як existing, доки він не DONE/SKIPPED.
   Після фактичного DONE/SKIPPED цього нового наступника черговий явний POST уже може
   просунути ланцюжок ще на один крок, навіть із тим самим body. Майбутні завершення
   не прогнозуються. Допускається однакова календарна дата різних номерів, якщо
   попередні задачі фактично завершені раніше їхніх планових дат.
4. Кандидат поза діапазоном або вичерпана endCondition → `200` без нових записів.
   Зокрема COUNT, що вже досягнутий, повертає 200 незалежно від статусу останньої Task.
   Поточна пауза Routine має пріоритет: вона завжди дає `409`, включно з retry.

CANCELED та soft delete не створюють заміни й не дозволяють новий крок ланцюжка.
Архів невидаленої DONE/SKIPPED задачі не заважає продовженню. Повторне відкриття до
генерації означає очікування нового реального DONE/SKIPPED; новий результат задає нову
основу для ще не створеного наступника. Якщо наступник уже існує, відкриття,
зміна DONE ↔ SKIPPED, повторний результат або видалення **його попередника** не пересувають і не видаляють
цього наступника. Наступний крок спирається лише на останню Task ланцюжка.

Для AFTER_COMPLETION COUNT — кількість **створених** виконань, включно зі
пропущеними/скасованими/видаленими. Їхні номери не використовуються повторно. Це відрізняється
від календарного COUNT запланованих вікон. NEVER та UNTIL_DATE включно збережені.
Початкова зміна конфігурації до генерації перевіряється за журналом і датою її
чинності; COUNT цього режиму відомий зі збереженого ланцюжка, а не історичної
проєкції. Чинне блокування schedule/timezone/startDate/endCondition після першої
генерації поширюється також на AFTER_COMPLETION.

Минула пауза застосовується до дати початку кандидата за чинним `[pauseDate, resumeDate)`.
Якщо кандидат у ній, generate → `409`: потрібне окреме рішення, дата не пересувається,
кандидат не пропускається, уявний наступний не обчислюється. SKIPPED застосовується
лише до вже створеної Task; автоматичного пропуску незгенерованих вікон немає.

RoutineOccurrence адитивно містить occurrenceNumber, previousOccurrenceId,
basisType, basisAt і сумісне basisCompletedAt. Перше виконання має номер 1 та решту
цих полів null; наступник — номер +1, ID попередника й незмінну основу:
`basisType=COMPLETED, basisAt=completedAt, basisCompletedAt=completedAt` або
`basisType=SKIPPED, basisAt=skippedAt, basisCompletedAt=null`.
Ключ першої версії: `v1:<routineId>:completion:<occurrenceNumber>`, без completedAt чи дати;
для нових версій додається `:schedule:<versionNumber>`, номер ланцюжка не скидається.
У БД унікальні `(routineId, occurrenceNumber)` та previousOccurrenceId забезпечують
унікальний номер і максимум одного наступника; попередні unique/FK збережені.
У календарних occurrences, включно з наявними до міграції, **усі п'ять полів null**;
їм не приписуються штучні номери або попередники. Ці поля також включені в
routineOccurrence повного Task DTO; решта area/subtasks/summary/isCompleted збережена.

Генерація бере locks Area → Routine → остання Task. PATCH Task спочатку блокує
Area при її призначенні, потім Task; DELETE Task та мутації підзадач теж блокують
Task-батька. Завершення, автоматичний DONE, reopen і delete узгоджуються з
генерацією в Serializable-транзакції. Вставлення occurrence, Task, дітей і журналу
залишається спільним і атомарним. Unique-конфлікти номерів/попередників також
повторюють всю транзакцію, без сирих Prisma-помилок.

Бюджети: максимум 10000 подій CREATED/STATUS_CHANGED для перевірки завершення та
10000 збережених виконань ланцюжка. Перевищення/спроба продовжити ланцюжок понад
бюджет → явний `409`, без часткового результату. Звичайні календарні бюджети та
поведінка generate не змінені.

### Postman: AFTER_COMPLETION від першої задачі до наступника

`POST {{baseUrl}}/api/routines`, Body → raw → JSON:

```json
{
  "title": "Замінити фільтр",
  "estimatedDurationMinutes": 15,
  "timezone": "Europe/Kyiv",
  "startDate": "2026-10-25",
  "schedule": {
    "version": 1,
    "recurrence": { "type": "AFTER_COMPLETION", "intervalDays": 2 },
    "localTime": "09:00"
  },
  "endCondition": { "type": "COUNT", "count": 3 }
}
```

У Post-response script цього POST збережіть ID:

```javascript
pm.environment.set("completionRoutineId", pm.response.json().id);
```

`POST {{baseUrl}}/api/routines/{{completionRoutineId}}/generate`:

```json
{ "from": "2026-10-25", "to": "2026-10-25" }
```

Перший запит → createdCount=1. Збережіть ID першої задачі в Post-response script:

```javascript
const result = pm.response.json();
pm.environment.set("completionTaskId", (result.created[0] || result.existing[0]).taskId);
```

Завершіть її: `PATCH {{baseUrl}}/api/tasks/{{completionTaskId}}`:

```json
{ "status": "DONE" }
```

Щоб задати діапазон за **фактичним** timestamp, виконайте
`GET {{baseUrl}}/api/tasks/{{completionTaskId}}/history`. Post-response script нижче
бере реальний перехід із журналу й лише готує дату для body; generate усе одно
самостійно читає та перевіряє збережене завершення:

```javascript
const done = pm.response.json().filter(a => a.type === "STATUS_CHANGED"
  && a.metadata.before.status !== "DONE" && a.metadata.after.status === "DONE").at(-1);
const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit"
}).formatToParts(new Date(done.timestamp));
const get = type => Number(parts.find(p => p.type === type).value);
const calendar = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
calendar.setUTCDate(calendar.getUTCDate() + 2);
pm.environment.set("nextOccurrenceDate", calendar.toISOString().slice(0, 10));
```

Наступник: `POST {{baseUrl}}/api/routines/{{completionRoutineId}}/generate`:

```json
{ "from": "{{nextOccurrenceDate}}", "to": "{{nextOccurrenceDate}}" }
```

Очікується createdCount=1, occurrenceNumber=2. Наприклад, DONE локально 2026-10-25
дає 2026-10-27 о 09:00 Europe/Kyiv. Повторіть **той самий POST** до завершення
наступника: `200`, createdCount=0, existingCount=1 і той самий taskId.
Запит іншого діапазону без existing, поки наступник не DONE, → `409`.

### Postman: генерація «Масаж» та місячного вікна

Створіть «Масаж» точним POST із прикладу вище, збережіть його id як `massageRoutineId`.

```http
POST {{baseUrl}}/api/routines/{{massageRoutineId}}/generate
Content-Type: application/json
```

```json
{ "from": "2026-10-25", "to": "2026-11-07" }
```

Перший запит: createdCount=7, existingCount=0. Дати: 25, 27, 29, 31 жовтня;
2, 4, 6 листопада. Той самий POST повторно: createdCount=0, existingCount=7
із тими самими taskId. GET `/api/tasks/<taskId>` показує occurrence та null у plannedAt/dueAt.

Для «Передати показники» створіть окрему Routine:

```http
POST {{baseUrl}}/api/routines
Content-Type: application/json
```

```json
{
  "title": "Передати показники",
  "estimatedDurationMinutes": 10,
  "timezone": "Europe/Kyiv",
  "startDate": "2026-11-01",
  "schedule": {
    "version": 1,
    "recurrence": {
      "type": "MONTHLY",
      "intervalMonths": 1,
      "selection": { "type": "WINDOW", "startDay": 15, "endDay": 23, "shortMonthPolicy": "SKIP" }
    },
    "localTime": null
  },
  "endCondition": { "type": "NEVER" }
}
```

Збережіть id як `meterRoutineId`:

```http
POST {{baseUrl}}/api/routines/{{meterRoutineId}}/generate
Content-Type: application/json
```

```json
{ "from": "2026-11-20", "to": "2026-11-21" }
```

Перша генерація створить одну Task з occurrence 2026-11-15–2026-11-23 включно,
localTime=null, instant=null. Повтор за 2026-11-01–2026-11-30 поверне той самий
taskId у existing. Після DELETE задачі повторний generate усе ще повертає її ID,
а GET задачі → 404. Пауза шаблону → generate 409; відновлення знову дозволяє
генерацію за узгодженим журналом. GET preview та history нічого не генерують.

### Міграція й інтеграційні перевірки генерації

Нова `20261025120000_routine_occurrences` додає таблицю, nullable FK Task та
унікальні індекси, в одній SQL-транзакції, без очищення даних. Старі міграції не
редаговані. Вона перевірена лише на ізольованому локальному PostgreSQL 17;
до Supabase не підключались, production-міграцію не застосовували.

Адитивна `20261025130000_routine_completion_chain` додає три nullable поля,
унікальні номер/попередник, self-FK і перевірку узгодженості полів ланцюжка.
Наявні календарні occurrences не перенумеровуються та не видаляються. Міграцію
перевірено лише в нових ізольованих локальних тестових схемах, не в Supabase.

Звичайні HTTP-тести використовують чинний підставний Prisma, моделюють також
конкурентні commits та конфлікти unique. Opt-in `tests/routines-postgres.test.ts`
перевіряє збереження наявної Task при новій міграції, реальні unique/FK constraints,
два конкурентні POST, гонки з паузою/конфігурацією/видаленням Routine та Area,
і відкат усього набору через реальну помилку PostgreSQL trigger у журналі.
Для AFTER_COMPLETION додатково перевірено реальні конкурентні POST наступника,
гонки з reopen/DELETE останньої Task та автоматичним DONE від підзадач, унікальність
номера й попередника, збереження nullable-полів старих календарних occurrences
і повний відкат наступника після помилки журналу підзадачі. Більша матриця
дат/DST, COUNT/UNTIL_DATE, пауз, статусів і пошкодженої історії перевіряється
підставним Prisma у `tests/routines-completion.test.ts`.
Для planning на реальному PostgreSQL перевірені конкурентні календарні та
AFTER_COMPLETION POST із різними планами, незмінність плану й CREATED переможця
після retry, відсутність записів у generation-preview та відкат batch із planning
при помилці журналу. Часткове планування, offsets, невалідні/чужі ключі, межі
діапазону, застарілий preview, DST та інші негативні випадки перевіряються чинним
підставним Prisma у `tests/routines-planning.test.ts`. Це локальні інтеграційні
перевірки, а не перевірка production/Supabase або всіх можливих interleavings.
Тест створює й після завершення видаляє **лише власну нову випадкову schema**;
усі старі міграції запускає тільки в ній. Дозволено лише localhost/127.0.0.1/::1.
DATABASE_URL, DIRECT_URL і credentials із .env для цього тесту не використовуються.
Без ROUTINE_TEST_DATABASE_URL він явно skipped:

```powershell
$env:ROUTINE_TEST_DATABASE_URL = 'postgresql://test_user:test_password@127.0.0.1:15432/test_database'
npx.cmd tsx --test tests/routines-postgres.test.ts
Remove-Item Env:ROUTINE_TEST_DATABASE_URL
```

## Логування HTTP-запитів

Middleware перед CORS, JSON parser і маршрутами генерує новий UUID для кожного
запиту та повертає його в `X-Request-Id` (також доступному браузеру через CORS).
Переданий клієнтом ID не використовується. `pino` і `pino-http` пишуть рівно один
підсумковий запис на запит: `requestId` (збігається з `X-Request-Id`), `method`,
`path` без query string, `statusCode`, `durationMs` у мілісекундах і `remoteAddress`
із сокета (заголовки proxy не використовуються). Рівні: `info` для статусів до 400,
`warn` для 4xx, `error` для 5xx і транспортних помилок.
Error handler додає до того самого запису безпечний `error.type`: `api_error`,
`validation_error`, `invalid_json`, `body_too_large` або `internal_error`.
Окремого запису помилки немає. Тіла запитів/відповідей, заголовки,
токени, cookies, URL підключення до БД, повідомлення й stack винятків не логуються.
Не передавайте секрети в сегментах шляху: `path` входить до журналу.
Форма JSON-помилок і HTTP-статуси API збережені.

Без `NODE_ENV` або з `NODE_ENV=development` використовується `pino-pretty`:
кольорові timestamp із локальним часовим поясом, рівень і PID, короткий підсумок
`GET /api/health 200 12ms requestId=<UUID>`; нижче — деталі запиту.
`pino-pretty` є dev-залежністю. З `NODE_ENV=production` HTTP-логи — структурований
JSON у stdout, без завантаження `pino-pretty`; інші значення `NODE_ENV` також дають JSON.
Для production задавайте `NODE_ENV=production`, зокрема при `npm ci --omit=dev`.

## «Беклог»: isBacklog і view=backlog

Беклог — збережені задачі, які потребують нового плану. `GET /api/tasks?view=backlog`
повертає звичайний масив у чинному порядку `createdAt DESC, id DESC`, відфільтрований
за `isBacklog=true`. Без view список працює як раніше; `view=today` зберігає свої правила.
Невідомий або повторений view → `400`. `archived=false&view=backlog` дозволене;
`archived=true&view=backlog` та `archived=true&view=today` → `400`.
view підтримується лише в GET списку.

Task входить у беклог, **лише якщо одночасно**:

- status — `TODO`, `PAUSED` або `POSTPONED`; `IN_PROGRESS`, `DONE`, `CANCELED`, `SKIPPED` виключені;
- archivedAt і deletedAt — null;
- dueAt відсутній або `dueAt <= now`;
- plannedAt відсутній або `plannedAt <= now`;
- routineOccurrence відсутній або його календарне вікно вже закінчилося.

plannedAt/dueAt порівнюються як UTC instants: рівно now допускається, будь-яке майбутнє
значення хоча б одного поля виключає Task, навіть якщо інше поле або occurrence у минулому.
Без обох дат і без occurrence Task дозволеного статусу входить у беклог.

startDate/endDate occurrence — локальні календарні дати **timezone occurrence**.
Вікно закінчилося лише коли локальна дата now строго більша за endDate.
Майбутнє й активне вікно виключають Task навіть із минулими особистими датами.
Останній день вікна включно ще не прострочений; localTime та instant не скорочують
його. Наприклад, вікно 15–23 жовтня в Europe/Kyiv входить у беклог з локальної
півночі 24 жовтня, якщо решта умов виконані. DST враховується календарною арифметикою
Temporal; фіксовані 24 години та штучний timestamp кінця дня не використовуються.
Пауза/видалення шаблону Routine не змінюють відбір створеної Task: поточний шаблон
для цього не завантажується.

`timezone` запиту, `overdueMode` та `overdueDays` не впливають на isBacklog, але й далі
валідуються за спільними правилами контексту. Вони впливають лише на isToday.
Беклог може перетинатися зі «Сьогодні»: TODO з dueAt рівно now та без occurrence
може мати `isToday=true` й `isBacklog=true` одночасно. Відбір не вимагає isToday=false.

Усі повні Task DTO (GET списку/деталей, POST, PATCH) містять обчислюваний boolean
`isBacklog`, без колонки БД. Чистий `tasks.backlog.ts` отримує явний now. isBacklog,
isToday, completedAt і summary використовують один instant на всю відповідь після
успішної транзакції, також після повторних спроб. completedAt, summary, area,
subtasks, routineOccurrence та isCompleted зберігають чинну семантику.
Автоматичні зміни статусу батька від підзадач враховуються в наступному GET Task.
GET не створює записів, occurrence чи подій: використовується наявний snapshot і
один пакетний запит історії summary без N+1 та додаткових запитів історії.
Клієнт не передає isBacklog або now/date/asOf — такі поля відхиляються з `400`.

### Postman: беклог і новий особистий план

`baseUrl` — наприклад `http://localhost:3000`. POST, Body → raw → JSON:

```http
POST {{baseUrl}}/api/tasks
Content-Type: application/json

{
  "title": "Потребує нового плану",
  "dueAt": "2020-01-01T12:00:00Z",
  "estimatedDurationMinutes": 15
}
```

Збережіть id як `taskId`. Якщо серверний now пізніше цієї дати, POST поверне
isBacklog=true, completedAt=null. GET без body:

```http
GET {{baseUrl}}/api/tasks/{{taskId}}
GET {{baseUrl}}/api/tasks?view=backlog
GET {{baseUrl}}/api/tasks?view=backlog&timezone=Europe%2FKyiv&overdueMode=none&overdueDays=1
GET {{baseUrl}}/api/tasks?view=backlog&timezone=America%2FLos_Angeles&overdueMode=all&overdueDays=365
GET {{baseUrl}}/api/tasks?view=today&overdueMode=all
```

Обидва контексти беклогу містять ту саму Task; останній GET демонструє перетин зі
«Сьогодні» для цього минулого dueAt. Решта isToday у DTO може відрізнятися за контекстом.
Призначте майбутній особистий план (дату за потреби замініть на майбутню щодо сервера):

```http
PATCH {{baseUrl}}/api/tasks/{{taskId}}
Content-Type: application/json

{ "plannedAt": "2099-01-01T09:00:00Z" }
```

PATCH та наступні GET повернуть isBacklog=false; список беклогу більше не містить Task,
хоча dueAt залишився минулим. PATCH `{ "plannedAt": null, "dueAt": null }` поверне
її у беклог. PATCH `{ "status": "IN_PROGRESS" }` виключить, `{ "status": "PAUSED" }`
поверне, а `{ "status": "DONE" }` виключить і збереже чинний розрахунок completedAt.

```http
GET {{baseUrl}}/api/tasks?archived=false&view=backlog
GET {{baseUrl}}/api/tasks?archived=true&view=backlog
GET {{baseUrl}}/api/tasks?archived=true&view=today
GET {{baseUrl}}/api/tasks?view=unknown
```

Перший запит → `200` і масив, решта → `400`.
Для збереженого Routine з вікном 15–23 перевірте GET деталей і view=backlog в останній
локальний день та після півночі наступного дня timezone occurrence: false → true.
Після паузи/видалення шаблону результат той самий. Майбутній plannedAt Task знову
виключає її. Час для ручної перевірки визначає сервер; query-підміни now немає.

## «Сьогодні»: isToday і view=today

Усі повні Task DTO у GET списку, GET деталей, POST та PATCH містять boolean
`isToday`, `isBacklog`, `completedAt: ISO string | null`, `skippedAt: ISO string | null`.
Ці поля обчислювані, без колонок БД; skipNote — збережене nullable поле Task.
area, subtasks, routineOccurrence,
summary, isCompleted та всі чинні поля збережені. Підзадачі окремого isToday не мають.

На цих чотирьох маршрутах підтримуються query-параметри:

| Параметр | Значення | Default |
| --- | --- | --- |
| `timezone` | валідний IANA identifier за чинним timezone helper, наприклад `Europe/Kyiv` | `UTC` |
| `overdueMode` | `none`, `limited`, `all` | `limited` |
| `overdueDays` | ціле десяткове число 1–365 | `3` |

**Без переданого timezone використовується UTC**, не timezone сервера чи браузера.
Після підключення frontend він передаватиме налаштування користувача з localStorage
в кожному запиті. Backend не зберігає ці налаштування в Task або глобальному стані;
контекст одного запиту не змінює наступні. overdueDays перевіряється також у режимах
none/all, хоча там не впливає на відбір. Невідомі поля, повторені query-параметри,
невідомі view/mode, невалідні timezone та overdueDays → `400` до записів.

Поточний instant отримується один раз для всієї відповіді після успішної транзакції,
включно зі спробами після serialization conflict. Чистий `tasks.today.ts` отримує
Task, контекст та явний now. Параметрів now/date/asOf для підміни часу клієнтом немає;
вони відхиляються як невідомі. Для тестів використовується чинний інжектований clock.

`GET /api/tasks?view=today` повертає **масив** лише з isToday=true, без обгортки.
Без view зберігається повний чинний список та його сортування `createdAt DESC,
id DESC`; задачі з isToday=false не приховуються. `archived=false&view=today`
дозволене, `archived=true&view=today` → `400`. view передається лише в GET списку;
GET деталей, POST та PATCH приймають три параметри контексту без view/archived.
Поточний API завантажує весь список без пагінації: відбір застосовується до нього
і використовує той самий isToday, а не іншу копію правил. Історія summary читається
одним пакетним запитом; нових запитів для кожної Task або occurrence немає.

### Правила «Сьогодні»

CANCELED, SKIPPED, archivedAt != null або deletedAt != null завжди дають false.
М'яко видалені Task, як раніше, недоступні через API. PAUSED та POSTPONED самі
по собі не виключають задачу; застосовуються її поточні збережені дати.

Для DONE isToday=true, якщо **останній достовірний реальний перехід у DONE**
відбувся сьогодні в timezone **запиту**. plannedAt, dueAt, вікно та timezone
RoutineOccurrence, overdueMode й overdueDays на цей відбір не впливають.
Завершення в попередній день не входить, навіть якщо дедлайн сьогодні.

completedAt — timestamp цього поточного завершення, ISO UTC з Z; timezone запиту
змінює лише відбір, не сам timestamp. Для не-DONE completedAt=null. Для архівованої
DONE момент завершення може бути відомий, але isToday усе одно false.
Використовується наявний `verifiedTaskCompletion` з TaskAction, той самий helper,
що й у AFTER_COMPLETION: окремого аналізу історії немає. updatedAt і summary.asOf
не є джерелами завершення. Редагування назви/сфери, архівування та повторний PATCH
з незміненим DONE не пересувають completedAt. Автоматичний DONE від підзадач
враховується так само, як ручний. Після reopen completedAt=null і знову працюють
правила невиконаних задач; повторний реальний DONE встановлює новий completedAt.

Якщо helper не може достовірно визначити завершення (пропуски/суперечності,
неоднозначні переходи з однаковим timestamp або бюджет історії), для DONE
повертаються completedAt=null та isToday=false, без вигаданої дати. Наявні
summary.historyIncomplete/historyIssues збережені за чинними правилами summary;
їх не переписує розрахунок completedAt. Історія CREATED/STATUS_CHANGED читається
тим самим одним пакетним запитом для summary, без нового запиту на кожну Task.
У мутаціях використовуються також щойно записані події. Один now на відповідь,
семантика summary та генерації AFTER_COMPLETION не змінені.

Для **невиконаної** звичайної Task plannedAt і dueAt незалежно переводяться в локальні дати
timezone **запиту**. Достатньо однієї відповідності:

- none — дата дорівнює сьогодні;
- limited — від сьогодні мінус overdueDays календарних днів до сьогодні включно;
- all — сьогодні або раніше.

Наприклад, при сьогодні 2026-10-25 і limited=3 входять 22–25 жовтня; 21 та 26 — ні.
Майбутня дата або null не відповідає. Без обох дат і без occurrence isToday=false.
Конкретна година сьогодні не обмежує календарний відбір: дата сьогодні входить
навіть тоді, коли її timestamp пізніший за поточну годину.

Для невиконаної Task зі збереженим RoutineOccurrence локальні startDate/endDate залишаються в
**timezone occurrence**. Сьогодні визначається з того самого request instant у
цьому timezone; межі не переводяться в UTC або timezone запиту. Без plannedAt:

- сьогодні всередині вікна включно — true;
- раніше startDate — false;
- після endDate: none → false, limited → не більше N календарних днів після
  endDate, all → true.

Вікно 15–23 активне й 15-го, й 23-го. localTime та instant не приховують задачу
до конкретної години. Для all-day не створюється UTC-північ. Обидва види відбору
використовують Temporal та календарні дні, а не N × 24 години, включно з DST.

**Особистий plannedAt замінює вікно occurrence як підставу включення.** Саме
збережене occurrence не змінюється. dueAt лишається незалежною підставою:

```text
plannedAt заданий: isToday = plannedAt-відбір OR dueAt-відбір
plannedAt відсутній: isToday = occurrence-відбір OR dueAt-відбір
```

Отже, **дедлайн сьогодні включає задачу навіть при особистому плануванні на
майбутнє**. Дати plannedAt/dueAt використовують timezone запиту, а вікно — свій.
Пауза або видалення шаблону Routine не приховує створену Task; поточний шаблон
для цього не завантажується. GET нічого не генерує та не записує. Цей відбір
не залежить від віку Task, часу в статусах або достовірності summary. У DONE
використовується лише перевірене завершення та timezone запиту, як описано вище.

### Postman: звичайна Task

Body → raw → JSON, `Content-Type: application/json`:

```http
POST {{baseUrl}}/api/tasks?timezone=Europe%2FKyiv&overdueMode=limited&overdueDays=3
```

```json
{
  "title": "Перевірити документ",
  "dueAt": "2026-10-22T18:00:00+03:00",
  "estimatedDurationMinutes": 10
}
```

За поточної локальної дати 2026-10-25 буде isToday=true. Збережіть id як taskId:

```http
GET {{baseUrl}}/api/tasks/{{taskId}}?timezone=Europe%2FKyiv&overdueMode=none
GET {{baseUrl}}/api/tasks?view=today&timezone=Europe%2FKyiv&overdueMode=limited&overdueDays=3
```

При тій самій даті перший GET повертає Task з isToday=false, другий включає її.
Це приклад для вказаної дати, а не спосіб підмінити production clock; для іншого
дня змініть dueAt відповідно. Запити без контексту працюють із UTC/limited/3.

### Postman: збережений «Масаж»

Для календарного шаблону «Масаж» із прикладу вище збережіть ID як massageRoutineId.
Генерація лишається окремим явним POST:

```http
POST {{baseUrl}}/api/routines/{{massageRoutineId}}/generate
```

```json
{ "from": "2026-10-25", "to": "2026-11-07" }
```

Збережіть taskId виконання 2026-10-25 як massageTaskId:

```http
GET {{baseUrl}}/api/tasks?view=today&timezone=Europe%2FKyiv&overdueMode=none
GET {{baseUrl}}/api/tasks/{{massageTaskId}}?timezone=Europe%2FKyiv&overdueMode=none
```

Якщо сьогодні в occurrence Europe/Kyiv 25 жовтня, виконання входить навіть до
18:00. plannedAt/dueAt початково null. Перенесіть особистий план:

```http
PATCH {{baseUrl}}/api/tasks/{{massageTaskId}}?timezone=Europe%2FKyiv&overdueMode=none
```

```json
{ "plannedAt": "2026-10-26T09:00:00+02:00" }
```

25 жовтня isToday=false, хоча незмінне occurrence має startDate=endDate=2026-10-25.
Той самий PATCH із body нижче поверне true через незалежний дедлайн:

```json
{ "dueAt": "2026-10-25T18:00:00+02:00" }
```

Приклади навмисно не додають now/date до URL. Перевірка
`GET {{baseUrl}}/api/tasks?archived=true&view=today` → `400`.

### Postman: задача, виконана сьогодні

Створіть неархівовану TODO:

```http
POST {{baseUrl}}/api/tasks?timezone=Europe%2FKyiv&overdueMode=none
```

```json
{
  "title": "Перевірка завершення сьогодні",
  "dueAt": "2027-01-01T12:00:00Z",
  "estimatedDurationMinutes": 5
}
```

Збережіть id як taskId. POST поверне completedAt=null. Виконайте реальний перехід:

```http
PATCH {{baseUrl}}/api/tasks/{{taskId}}?timezone=Europe%2FKyiv&overdueMode=none
```

```json
{ "status": "DONE" }
```

У відповіді completedAt містить фактичний timestamp переходу, isToday=true,
незалежно від дедлайну. Той самий контекст використовується в читанні:

```http
GET {{baseUrl}}/api/tasks/{{taskId}}?timezone=Europe%2FKyiv&overdueMode=none
GET {{baseUrl}}/api/tasks?view=today&timezone=Europe%2FKyiv&overdueMode=none
```

Повторіть PATCH `{ "status": "DONE" }` — completedAt не зміниться. Після переходу
через північ у Europe/Kyiv задача перестане входити в today без зміни completedAt.
PATCH `{ "status": "TODO" }` поверне completedAt=null і застосує звичайні правила
дат; новий PATCH DONE зафіксує нове реальне завершення. completedAt у body не
передається: поле read-only, спроба запису → `400`. GET нічого не записує й не генерує.

## Часовий підсумок Task

GET списку, GET деталей, POST і PATCH задачі повертають додаткове поле `summary`.
Усі чинні поля, `subtasks` і `isCompleted` збережені. Підзадачі власного summary
не мають; час батька та підзадач не складається. Приклад:

```json
{
  "asOf": "2026-10-22T00:01:40.000Z",
  "ageSeconds": 100,
  "inProgressSeconds": 60,
  "timeToCompletionSeconds": null,
  "statusDurationsSeconds": {
    "TODO": 20,
    "IN_PROGRESS": 60,
    "PAUSED": 10,
    "POSTPONED": 10
  },
  "historyIncomplete": false,
  "historyIssues": []
}
```

`asOf` — єдиний момент розрахунку для всіх задач відповіді, ISO 8601 UTC.
Усі тривалості — невід'ємні цілі **секунди**: різниці абсолютних timestamp
сумуються в мілісекундах для кожного статусу, потім округлюються вниз до секунд.
Локальний часовий пояс на результат не впливає. `estimatedDurationMinutes`
залишається плановою оцінкою в хвилинах і в summary не дублюється.

- `ageSeconds` — від `createdAt` до `asOf`; для поточного `DONE`, `CANCELED` або `SKIPPED`
  зупиняється на останньому вході в цей поточний кінцевий статус.
- `inProgressSeconds` — сумарний час у статусі **«У роботі» (`IN_PROGRESS`)**.
  Це не незалежний таймер фактично витраченої праці.
- `timeToCompletionSeconds` — від `createdAt` до останнього входу в `DONE`,
  лише якщо поточний статус `DONE`; для інших статусів — `null`.
- `statusDurationsSeconds` — суми всіх проміжків у кожному з чотирьох статусів.
  `inProgressSeconds` дорівнює `statusDurationsSeconds.IN_PROGRESS`.

Початковий статус береться з `CREATED.metadata.after.status`, але його проміжок
починається з `Task.createdAt`, навіть якщо подія створення записана пізніше.
Ручні та автоматичні `STATUS_CHANGED`, включно з переходами через підзадачі,
враховуються однаково. Звичайні редагування, архівування, події підзадач і записи
з однаковими `before.status` та `after.status` не створюють переходу.
Архівування не ставить облік на паузу. `DONE`, `CANCELED`, `SKIPPED` не входять до сум
робочих статусів. Після повторного відкриття ці суми продовжують накопичуватися,
а вік знову рахується до `asOf`, включно з календарним часом попередніх завершень.
Повторне завершення встановлює нову межу віку та часу до завершення.

Історія читається на backend: для непорожнього списку одним пакетним запитом
лише `CREATED` та `STATUS_CHANGED` для всіх повернутих задач. Snapshot і події
читаються в одній транзакції `Serializable`, після мутацій — після всіх записів
подій у ній. Після успішного commit фіксується один `asOf` для відповіді й чистого
розрахунку за цим узгодженим snapshot. Повтори транзакції не читають clock повторно
для відповіді. Історія не переписується. Правила summary та календарного isToday
незалежні; використовується лише той самий instant запиту.

### Достовірність журналу

Порядок переходів детермінований: `timestamp ASC`, потім `id ASC`, як у GET
історії. Початковий статус відновлюється з події створення окремо; за однакового
timestamp створення й переходу початковий проміжок може мати нульову тривалість.
UUID не є порядковим номером: при однаковому timestamp порядок реальних записів
не гарантований. Якщо цей порядок порушує ланцюжок `before`/`after`, результат
позначається неповним; довільне переставлення подій для приховування суперечності
не виконується. Журнал не має sequence/version чи гарантії виявлення всіх пропусків:
пропущені переходи, які залишили узгоджений ланцюжок і snapshot, виявити неможливо.
Точність обмежена timestamp подій, а не моментом фактичної роботи користувача.

За неповної або суперечливої історії `historyIncomplete: true`, усі чотири суми
статусів та `inProgressSeconds` консервативно повертаються як `null`, а не вигадані
нулі. Для активної задачі `ageSeconds` усе ще визначається з коректного `createdAt`;
для кінцевого статусу вік і час до завершення також стають `null`.
`historyIssues` містить діагностичні коди:

- `MISSING_OR_DUPLICATE_CREATION` — немає єдиної події створення;
- `INVALID_INITIAL_STATUS` / `INVALID_STATUS_EVENT` — metadata не містить валідних статусів;
- `STATUS_CHAIN_MISMATCH` — `before.status` не збігається з відновленим статусом;
- `SNAPSHOT_STATUS_MISMATCH` — останній відновлений статус суперечить поточному Task;
- `CREATION_AFTER_TRANSITION` — перехід датований раніше події створення;
- `EVENT_OUTSIDE_LIFETIME` — некоректний timestamp або подія поза `createdAt`…`asOf`;
- `INVALID_LIFETIME` — некоректні межі життя, зокрема `createdAt > asOf`.

## Локальні перевірки

```powershell
npm run prisma:validate
npm run build
npm run test:typecheck
npm test
git diff --check
```

HTTP-тести використовують підставний транзакційний Prisma-клієнт і локальний
HTTP-сервер; вони не підключаються до БД й не потребують credentials.
Перевіряються валідація, всі статуси, сумісність `isCompleted`, планування,
необов'язковий `plannedAt`, пріоритети та їхній журнал, request ID і безпечні HTTP-логи,
скасування, редагування, архів, видалення, історія, відкат при помилці журналу
та повтори конфліктів транзакцій. Також перевіряються повні DTO у `Task.subtasks`
у списках, деталях і PATCH, порожній масив (зокрема в POST), стабільне сортування,
відсутність м'яко видалених підзадач та завантаження списку без запитів для кожної задачі.
Регресійні тести синхронізації охоплюють створення, зміну статусу й м'яке видалення
для всіх шести початкових статусів батька: всі `TODO`, всі `DONE`, наявність
`IN_PROGRESS`, суміш `DONE` і `TODO` зі збереженням `PAUSED`/`POSTPONED`, інші
комбінації та ігнорування видалених підзадач. Також перевіряються збереження
статусу й останньої сумарної тривалості після видалення останньої підзадачі,
заборона ручного редагування тривалості за наявності підзадач і відсутність
каскадної зміни їхніх статусів при ручній зміні статусу батька.
`test:typecheck` перевіряє також TypeScript тестів.
Тести Areas охоплюють валідацію, сортування й однакові назви, фізичне видалення,
Task DTO без запитів сфери для кожної задачі, snapshot назв, no-op призначення,
відкати й атомарне створення з підзадачами, повтори `P2034` і raw-query конфліктів.
Перевіряються відв'язування всіх задач, включно з архівованими й видаленими,
оновлення `updatedAt`, незмінність статусів/summary/підзадач і збереження історії,
повні відкати після частини записів та повтори видалення без дублювання подій.
Конкурентне видалення моделюється підставним Prisma-клієнтом; реальні блокування
PostgreSQL та виконання SQL-міграції на БД цими тестами не перевіряються.
Створення Task із вкладеними підзадачами перевіряється для пропущеної та переданої
тривалості батька, правил статусу, валідації масиву й елементів, переповнення до
транзакції, повних відсортованих DTO та подій створення. Тести моделюють помилку
кожного запису підзадачі й журналу, а також конфлікт після всіх записів перед
commit: відкат повний, повторні спроби не дублюють записи й події.

## Production-збірка

```powershell
npm run build
npm start
```

`build` генерує Prisma Client і компілює TypeScript; міграції запускаються окремо.
