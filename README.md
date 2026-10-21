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

Модель `Task` зберігає статус, планування, причину скасування та незалежні
`archivedAt` / `deletedAt`. `TaskAction` зберігає журнал із UUID, `taskId`, `type`,
`timestamp` і JSON `metadata: { before, after }`. UUID генерує Prisma;
`updatedAt` автоматично оновлюється під час записів через Prisma Client.

Початкова міграція `20261019000000_create_task` не змінена. Нова міграція
`20261021000000_task_lifecycle` **очищає лише наявні тестові записи `Task`**,
бо вони не мають обов'язкової тривалості та даних планування. Інші таблиці не
видаляються. Додані SQL CHECK-обмеження для додатної тривалості й причини
скасування; зміни міграції виконуються в одній SQL-транзакції.

Для ручного застосування підготовлених міграцій із кореня backend виконайте:

```powershell
npm run prisma:migrate:deploy
```

Команда використовує налаштований `DIRECT_URL`, застосовує лише ще не застосовані
міграції та не потребує shadow database. Не використовуйте `migrate reset`.

Перевірка схеми та генерація клієнта не потребують `.env` і не змінюють БД:

```powershell
npm run prisma:validate
npm run prisma:generate
```

Згенерований клієнт у `src/generated/prisma/` ігнорується Git.
Після зміни схеми повторіть генерацію перед `npm run dev`.

## Task API

`POST /api/tasks` вимагає `title`, `plannedAt`, `dueAt` і
`estimatedDurationMinutes`. Дати — ISO 8601 із часовим поясом (`Z` або offset),
тривалість — додатне ціле число до `2147483647`. `description` необов'язковий.
Нові задачі мають статус `TODO`.

```json
{
  "title": "Підготувати пропозицію",
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

PATCH приймає `title`, `description`, `status`, `plannedAt`, `dueAt`,
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
обов'язкові поля планування до POST; frontend у цьому етапі не змінюється.

Архівування: `PATCH { "archived": true }`; відновлення з архіву:
`PATCH { "archived": false }`. Це не змінює статус чи планування. Видалення
зберігає задачу та журнал у БД; подальші GET/PATCH/DELETE й запит історії для неї
повертають `404`. Відновлення видалених задач через API немає.

Події: `CREATED`, `EDITED`, `STATUS_CHANGED`, `ARCHIVED`, `UNARCHIVED`, `DELETED`.
PATCH, що змінює кілька незалежних аспектів задачі, створює відповідні події
в одній транзакції; повторне встановлення тих самих значень не створює подій.
Записи задачі й журналу атомарні. Транзакції мають ізоляцію `Serializable`;
конфлікти повторюються до трьох спроб, після чого API повертає `409`.
Помилки валідації повертають `400` з `error.message` та `error.details`,
невалідний UUID — `400`, відсутня чи видалена задача — `404`.

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
скасування, редагування, архів, видалення, історія, відкат при помилці журналу
та повтори конфліктів транзакцій. `test:typecheck` перевіряє також TypeScript тестів.

## Production-збірка

```powershell
npm run build
npm start
```

`build` генерує Prisma Client і компілює TypeScript; міграції запускаються окремо.
