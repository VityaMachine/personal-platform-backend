import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";

import { app } from "../src/app";
import { errorHandler } from "../src/middleware/error-handler";
import { requestLogger } from "../src/middleware/request-logger";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("app assigns unique request IDs and logs each completed request without sensitive input", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ids = new Set<string>();
  const cases = [
    { path: "/api/health?token=query-secret", method: "GET", status: 200 },
    { path: "/api/tasks/invalid-id", method: "GET", status: 400 },
    { path: "/api/tasks", method: "POST", body: '{"secret":"body-secret",', status: 400 },
    { path: "/missing", method: "GET", status: 404 },
    { path: "/api/tasks", method: "OPTIONS", status: 204 },
  ];
  for (const item of cases) {
    const response = await fetch(base + item.path, {
      method: item.method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-secret", Cookie: "session=cookie-secret", "X-Request-Id": "untrusted-id" },
      body: item.body,
    });
    await response.text();
    assert.equal(response.status, item.status);
    const requestId = response.headers.get("X-Request-Id")!;
    assert.match(requestId, uuid);
    assert.ok(!ids.has(requestId));
    ids.add(requestId);
    const matching = logs.mock.calls.map((call) => JSON.parse(String(call.arguments[0])))
      .filter((entry) => entry.requestId === requestId);
    assert.equal(matching.length, 1);
    assert.deepEqual(Object.keys(matching[0]).sort(), ["durationMs", "method", "path", "requestId", "statusCode"]);
    assert.equal(matching[0].method, item.method);
    assert.equal(matching[0].path, item.path.split("?")[0]);
    assert.equal(matching[0].statusCode, item.status);
    assert.equal(typeof matching[0].durationMs, "number");
    assert.ok(matching[0].durationMs >= 0);
  }
  assert.equal(logs.mock.callCount(), cases.length);
  assert.equal(errors.mock.callCount(), 2);
  for (const call of errors.mock.calls) {
    const entry = JSON.parse(String(call.arguments[0]));
    assert.ok(ids.has(entry.requestId));
    assert.ok(["api_error", "invalid_json"].includes(entry.error.type));
  }
  const output = JSON.stringify([...logs.mock.calls, ...errors.mock.calls]);
  for (const secret of ["query-secret", "body-secret", "token-secret", "cookie-secret", "untrusted-id"]) {
    assert.ok(!output.includes(secret));
  }
});

test("unexpected errors log only a safe category with the matching request ID", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const localApp = express();
  localApp.use(requestLogger);
  localApp.get("/failure", () => { throw new Error("DATABASE_URL=postgres://secret-password"); });
  localApp.use(errorHandler);
  const server = localApp.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/failure`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { message: "Internal server error." } });
  const requestId = response.headers.get("X-Request-Id");
  assert.equal(errors.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(errors.mock.calls[0].arguments[0])), {
    requestId, error: { type: "internal_error" },
  });
  assert.equal(logs.mock.callCount(), 1);
  assert.equal(JSON.parse(String(logs.mock.calls[0].arguments[0])).requestId, requestId);
});
