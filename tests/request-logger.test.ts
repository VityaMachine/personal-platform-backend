import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import express from "express";

import { createApp } from "../src/app";
import { createLogger } from "../src/lib/logger";
import { ApiError } from "../src/lib/api-error";
import { errorHandler } from "../src/middleware/error-handler";
import { createRequestLogger } from "../src/middleware/request-logger";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function capture() {
  const lines: string[] = [];
  const middleware = createRequestLogger(createLogger("production", {
    write(line) { lines.push(line); },
  }));
  return { middleware, lines, entries: () => lines.map((line) => JSON.parse(line)) };
}

async function listen(t: TestContext, app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("app logs each request once with its response UUID, status and safe metadata", async (t) => {
  const output = capture();
  const base = await listen(t, createApp(output.middleware));
  const ids = new Set<string>();
  const cases = [
    { path: "/api/health?token=query-secret&password=password-secret", method: "GET", status: 200 },
    { path: "/api/tasks/invalid-id", method: "GET", status: 400, category: "api_error" },
    { path: "/api/tasks", method: "POST", body: '{"password":"body-secret",', status: 400, category: "invalid_json" },
    { path: "/api/tasks", method: "POST", body: '{}', status: 400, category: "validation_error" },
    { path: "/api/areas", method: "POST", body: '{}', status: 400, category: "validation_error" },
    { path: "/api/areas/invalid-id", method: "PATCH", body: '{}', status: 400, category: "api_error" },
    { path: "/api/areas/invalid-id", method: "DELETE", status: 400, category: "api_error" },
    { path: "/api/areas?archived=true", method: "GET", status: 400, category: "validation_error" },
    { path: "/api/areas?unknown=true", method: "GET", status: 400, category: "validation_error" },
    { path: "/api/tasks", method: "POST", body: JSON.stringify({ password: "x".repeat(110_000) }), status: 413, category: "body_too_large" },
    { path: "/missing", method: "GET", status: 404 },
    { path: "/api/tasks", method: "OPTIONS", status: 204 },
  ];
  for (const item of cases) {
    const response = await fetch(base + item.path, {
      method: item.method,
      headers: {
        "Content-Type": "application/json", Authorization: "Bearer token-secret",
        Cookie: "session=cookie-secret", "X-Request-Id": "untrusted-id",
        Origin: "http://localhost:3000",
      },
      body: item.body,
    });
    await response.text();
    assert.equal(response.status, item.status);
    const requestId = response.headers.get("X-Request-Id")!;
    assert.match(requestId, uuid);
    assert.ok(!ids.has(requestId));
    ids.add(requestId);
    assert.ok(response.headers.get("Access-Control-Expose-Headers")?.includes("X-Request-Id"));
    const matching = output.entries().filter((entry) => entry.requestId === requestId);
    assert.equal(matching.length, 1);
    const entry = matching[0];
    assert.equal(entry.method, item.method);
    assert.equal(entry.path, item.path.split("?")[0]);
    assert.equal(entry.statusCode, item.status);
    assert.equal(entry.level, item.status >= 400 ? 40 : 30);
    assert.equal(typeof entry.durationMs, "number");
    assert.ok(entry.durationMs >= 0);
    assert.equal(entry.remoteAddress, "127.0.0.1");
    assert.equal(entry.error?.type, item.category);
    assert.equal(typeof entry.time, "number");
    assert.equal(entry.pid, process.pid);
    assert.ok(entry.msg.includes(requestId));
    assert.deepEqual(Object.keys(entry).sort(), [
      "durationMs", "hostname", "level", "method", "msg", "path", "pid", "remoteAddress", "requestId", "statusCode", "time",
      ...(item.category ? ["error"] : []),
    ].sort());
  }
  assert.equal(output.lines.length, cases.length);
  for (const secret of ["query-secret", "password-secret", "body-secret", "token-secret", "cookie-secret", "untrusted-id", "Authorization", "Cookie"]) {
    assert.ok(!output.lines.join("").includes(secret), secret);
  }
});

test("500 and API errors omit exception details and response bodies and emit one record", async (t) => {
  const output = capture();
  const app = express();
  app.use(output.middleware);
  app.get("/failure", () => { throw new Error("DATABASE_URL=postgres://secret-password token=exception-secret"); });
  app.get("/api-error", () => { throw new ApiError(409, "response-secret"); });
  app.get("/success", (_req, res) => {
    res.setHeader("Set-Cookie", "session=response-cookie-secret");
    res.json({ password: "response-body-secret" });
  });
  app.use(errorHandler);
  const base = await listen(t, app);
  for (const [path, status, category] of [
    ["/failure", 500, "internal_error"], ["/api-error", 409, "api_error"], ["/success", 200, undefined],
  ] as const) {
    const response = await fetch(base + path);
    assert.equal(response.status, status);
    const body = await response.json();
    if (status === 500) assert.deepEqual(body, { error: { message: "Internal server error." } });
    const entries = output.entries().filter((entry) => entry.requestId === response.headers.get("X-Request-Id"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].statusCode, status);
    assert.equal(entries[0].level, status >= 500 ? 50 : status >= 400 ? 40 : 30);
    assert.equal(entries[0].error?.type, category);
  }
  assert.equal(output.lines.length, 3);
  for (const secret of ["DATABASE_URL", "secret-password", "exception-secret", "response-secret", "response-cookie-secret", "response-body-secret", "stack"]) {
    assert.ok(!output.lines.join("").includes(secret), secret);
  }
});

test("development prints colored timestamp, PID, HTTP summary and details; production prints JSON", () => {
  for (const environment of ["development", "production"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
      const { createLogger } = require('./src/lib/logger.ts');
      const logger = createLogger(${JSON.stringify(environment)});
      logger.info({requestId:'sample-id',method:'GET',path:'/api/health',statusCode:200,durationMs:12,remoteAddress:'127.0.0.1'}, 'completed');
    `], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    if (environment === "production") {
      const entry = JSON.parse(result.stdout);
      assert.equal(entry.requestId, "sample-id");
      assert.equal(entry.statusCode, 200);
      assert.ok(!result.stdout.includes("\u001b["));
    } else {
      assert.ok(result.stdout.includes("\u001b["));
      const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(plain, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}/);
      assert.match(plain, /INFO\s+\(\d+\): GET \/api\/health 200 12ms requestId=sample-id/);
      assert.match(plain, /\n\s+remoteAddress: "127\.0\.0\.1"/);
    }
  }
});
