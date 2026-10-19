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

## Prisma та перша міграція

Використано [Prisma Config](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference),
генератор `prisma-client` з CommonJS і `@prisma/adapter-pg`.
Налаштування підключення описані в [документації Supabase](https://supabase.com/docs/guides/database/prisma).
Prisma CLI читає `DIRECT_URL` з `prisma.config.ts`; клієнт читає `DATABASE_URL`
через ліниву функцію `getPrisma()` у `src/lib/prisma.ts`.

Є лише модель `Task`: UUID `id`, обов'язковий `title` (`varchar(160)`),
необов'язковий `description` (`text`), `isCompleted` (типово `false`),
`createdAt` і `updatedAt`. UUID генерує Prisma; `updatedAt` автоматично оновлюється
під час записів через Prisma Client (це не тригер PostgreSQL).

SQL уже підготовлений у `prisma/migrations/20261019000000_create_task/migration.sql`.
Міграцію не застосовано. Для першого застосування використовуйте базу, де ще немає
таблиці `Task`. Лише після заповнення `.env` виконайте окрему команду:

```powershell
npm run prisma:migrate:deploy
```

Вона застосує збережену міграцію без shadow database. Для цього кроку не потрібні
`migrate dev` або `db push` на Supabase.

Перевірка схеми та генерація клієнта не потребують `.env` і не змінюють БД:

```powershell
npm run prisma:validate
npm run prisma:generate
```

Згенерований клієнт у `src/generated/prisma/` ігнорується Git.
Після зміни схеми повторіть генерацію перед `npm run dev`.

## Production-збірка

```powershell
npm run build
npm start
```

`build` генерує Prisma Client і компілює TypeScript; міграції запускаються окремо.
