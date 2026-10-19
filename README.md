# Personal Platform Backend

Мінімальний backend-каркас на Express і TypeScript.

## Запуск

Потрібен Node.js 20 або новіший.

```bash
cp .env.example .env
npm install
npm run dev
```

Сервер типово працює на `http://localhost:4000`. Перевірка стану:

```bash
curl http://localhost:4000/api/health
```

Очікувана відповідь: `{"status":"ok"}`.

## Production-збірка

```bash
npm run build
npm start
```

Змінні середовища:

- `PORT` — порт сервера, типово `4000`;
- `CLIENT_ORIGIN` — дозволений CORS origin, типово `http://localhost:3000`.
