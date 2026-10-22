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

`POST /api/tasks` вимагає `title`, `dueAt` і
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

Маршрути:

| Запит | Поведінка |
| --- | --- |
| `GET /api/tasks` | Неархівовані й невидалені задачі, нові спочатку |
| `GET /api/tasks?archived=true` | Лише архівовані й невидалені задачі |
| `GET /api/tasks?archived=false` | Звичайний список |
| `GET /api/tasks/:id` | Одна невидалена задача, включно з архівованою |
| `PATCH /api/tasks/:id` | Редагування полів, статусу та/або архіву |
| `DELETE /api/tasks/:id` | Встановлення `deletedAt`, відповідь `204` |
| `GET /api/tasks/:id/history` | Журнал невидаленої задачі, старі події спочатку |

PATCH приймає `title`, `description`, `status`, `priority`, `plannedAt`, `dueAt`,
`estimatedDurationMinutes`, `cancellationNote`, `archived`. Невідомі поля та
порожній PATCH відхиляються. `description`, `plannedAt` і `dueAt` можна очистити
через `null`; при створенні задачі дати не можуть бути `null`.

Статуси: `TODO`, `IN_PROGRESS`, `PAUSED`, `POSTPONED`, `DONE`, `CANCELED`.
Переходи між ними дозволені; `CANCELED` вимагає в тому самому запиті непорожню
`cancellationNote` (пробіли по краях обрізаються). Причина зберігається в задачі
та metadata події зміни статусу; наступні зміни статусу не стирають її.
При переході в `POSTPONED` без `plannedAt` попередня дата планування очищається.
Непереданий `dueAt` зберігається, а явний `dueAt: null` очищає дедлайн.

Для сумісності кожна відповідь із задачею містить обчислений `isCompleted`,
який є `true` лише для `DONE`. Старий PATCH `{ "isCompleted": true }` переводить
у `DONE`, а `false` — у `TODO`. Одночасно передавати `status` і `isCompleted`
не можна. У БД поля `isCompleted` більше немає. Старий frontend має додати
обов'язкові `dueAt` та `estimatedDurationMinutes` до POST; frontend у цьому етапі не змінюється.

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

## Підзадачі

Кожен Task у відповідях `GET /api/tasks` (зокрема архівному списку),
`GET /api/tasks/:id`, `POST /api/tasks` і `PATCH /api/tasks/:id` містить `subtasks`.
Це масив повних публічних DTO невидалених підзадач, відсортованих за `createdAt`,
потім `id` за зростанням. Без підзадач повертається `[]`, зокрема при створенні Task.
Підзадачі списку задач завантажуються через Prisma relation include без окремого
запиту для кожної задачі. Окремі маршрути підзадач повертають DTO підзадачі
(або їх масив для GET), а не Task.

| Запит | Поведінка |
| --- | --- |
| `GET /api/tasks/:taskId/subtasks` | Невидалені підзадачі, відповідь `200` |
| `POST /api/tasks/:taskId/subtasks` | Створення, відповідь `201` із підзадачею |
| `PATCH /api/tasks/:taskId/subtasks/:subtaskId` | Редагування, відповідь `200` із підзадачею |
| `DELETE /api/tasks/:taskId/subtasks/:subtaskId` | М'яке видалення, відповідь `204` |

POST вимагає `title` (1–160 символів після обрізання пробілів) і додатне ціле
`estimatedDurationMinutes` до `2147483647`. Необов'язкові `status` (типово `TODO`)
та `cancellationNote`. PATCH приймає лише `title`, `status`,
`estimatedDurationMinutes`, `cancellationNote`; порожній PATCH і невідомі поля
відхиляються. Статуси ті самі, що й у задач. Передача `status: "CANCELED"` в POST
або PATCH вимагає в тому самому запиті непорожню `cancellationNote`; причина
зберігається після наступних переходів. `plannedAt`, `dueAt`, `priority` у підзадач немає.
Відповідь містить `id`, `taskId`, `title`, `status`, `estimatedDurationMinutes`,
`cancellationNote`, `createdAt`, `updatedAt`, `deletedAt`.

Невалідний UUID або дані дають `400`; відсутня чи видалена підзадача, неправильна
належність або видалена батьківська задача — `404`. Архівована задача дозволяє
читання списку, але POST/PATCH/DELETE підзадач дають `409`. Використано чинний
формат `error.message` і `error.details` для помилок валідації.

Поки є невидалені підзадачі, оцінка задачі дорівнює сумі їхніх тривалостей,
включно з `DONE` і `CANCELED`. Ручний PATCH оцінки задачі повертає `409`, навіть
якщо передано поточне значення. Після видалення останньої підзадачі остання сума
зберігається, а ручне редагування знову доступне. Сума понад `2147483647` дає `400`
та відкат усієї операції. Нова підзадача після цього знову визначає оцінку задачі.

Зміни батьківської задачі ніколи не змінюють статусів підзадач, включно з ручним
`DONE` та legacy `isCompleted`. Після зміни підзадачі застосовуються правила:

- Будь-яка невидалена `IN_PROGRESS` переводить задачу в `IN_PROGRESS`.
- Якщо всі невидалені підзадачі `DONE`, задача стає `DONE`.
- Якщо задача `IN_PROGRESS`, невидалені підзадачі є й усі вони `TODO`, задача стає `TODO`.
- Додавання підзадачі або повторне відкриття `DONE`/`CANCELED` підзадачі в інший
  незавершений статус під задачею `DONE` переводить задачу в `TODO`, якщо вище
  не спрацювало правило `IN_PROGRESS` чи всіх `DONE`.
- Інші комбінації зберігають статус задачі. Без підзадач синхронізації немає.

Журнал батьківської задачі містить `SUBTASK_CREATED`, `SUBTASK_EDITED`,
`SUBTASK_STATUS_CHANGED`, `SUBTASK_DELETED` із `metadata.subtaskId` і значеннями
`before`/`after`. Автоматичні зміни тривалості та статусу задачі записуються як
`EDITED` і `STATUS_CHANGED` із тим самим `subtaskId`. М'яке видалення зберігає
рядок підзадачі та журнал. Операція, перерахунок і всі події атомарні в одній
транзакції `Serializable`; помилка будь-якого запису журналу відкочує всі зміни.

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

## Локальні перевірки

```powershell
npm run prisma:validate
npm run build
npm test
npm run test:typecheck
```

HTTP-тести використовують підставний транзакційний Prisma-клієнт і локальний
HTTP-сервер; вони не підключаються до БД й не потребують credentials.
Перевіряються валідація, всі статуси, сумісність `isCompleted`, планування,
необов'язковий `plannedAt`, пріоритети та їхній журнал, request ID і безпечні HTTP-логи,
скасування, редагування, архів, видалення, історія, відкат при помилці журналу
та повтори конфліктів транзакцій. Також перевіряються повні DTO у `Task.subtasks`
у списках, деталях і PATCH, порожній масив (зокрема в POST), стабільне сортування,
відсутність м'яко видалених підзадач та завантаження списку без запитів для кожної задачі.
`test:typecheck` перевіряє також TypeScript тестів.

## Production-збірка

```powershell
npm run build
npm start
```

`build` генерує Prisma Client і компілює TypeScript; міграції запускаються окремо.
