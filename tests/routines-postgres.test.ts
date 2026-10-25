import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { createRoutinesRouter } from "../src/modules/routines/routines.routes";
import { createTasksRouter } from "../src/modules/tasks/tasks.routes";
import { createAreasRouter } from "../src/modules/areas/areas.routes";
import { errorHandler } from "../src/middleware/error-handler";
import { isRoutineOccurrenceUniqueConflict } from "../src/modules/routines/routines.repository";

// Opt-in only. All migrations, including old data-changing migrations, run in a NEW isolated schema.
// DATABASE_URL/DIRECT_URL and .env credentials are never used by this test.
test("local PostgreSQL: additive migration, unique/FK constraints, atomic rollback and concurrent HTTP generation", {
  skip: !process.env.ROUTINE_TEST_DATABASE_URL,
}, async (t) => {
  const connectionString = process.env.ROUTINE_TEST_DATABASE_URL!;
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only a local PostgreSQL test database is allowed");
  const schema = `routine_generation_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const sql = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }) });
  t.after(async () => {
    await prisma.$disconnect(); await sql.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  });
  const directory = path.resolve("prisma/migrations");
  const migrations = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const ordinaryId = randomUUID();
  for (const migration of migrations) {
    if (migration === "20261025120000_routine_occurrences") {
      await sql.query('INSERT INTO "Task" ("id", "title", "estimatedDurationMinutes", "updatedAt") VALUES ($1, $2, 10, now())', [ordinaryId, "Existing ordinary task"]);
    }
    await sql.query(await readFile(path.join(directory, migration, "migration.sql"), "utf8"));
  }
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: ordinaryId } })).routineOccurrenceId, null);
  const app = express(); app.use(express.json());
  app.use("/api/routines", createRoutinesRouter(() => prisma));
  app.use("/api/tasks", createTasksRouter(() => prisma));
  app.use("/api/areas", createAreasRouter(() => prisma));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const input = { title: "Massage", timezone: "Europe/Kyiv", startDate: "2026-10-25", estimatedDurationMinutes: 30,
    schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 2 } } };
  const r = (await request("POST", "/routines", input)).body;
  const range = { from: "2026-10-25", to: "2026-11-07" };
  const responses = await Promise.all([1, 2].map(() => request("POST", `/routines/${r.id}/generate`, range)));
  assert.ok(responses.every((response) => response.status === 200), JSON.stringify(responses));
  assert.deepEqual(responses.map((response) => response.body.createdCount).sort((a, b) => a - b), [0, 7]);
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: r.id } }), 7);
  const occurrence = await prisma.routineOccurrence.findFirstOrThrow({ where: { routineId: r.id }, include: { task: true } });
  const { id: _id, task: _task, ...duplicate } = occurrence;
  await assert.rejects(prisma.routineOccurrence.create({ data: { ...duplicate, snapshot: duplicate.snapshot as Prisma.InputJsonValue } }),
    (error: Prisma.PrismaClientKnownRequestError) => {
      assert.equal(error.code, "P2002");
      assert.equal(isRoutineOccurrenceUniqueConflict(error), true, JSON.stringify(error.meta));
      return true;
    });
  await assert.rejects(prisma.task.create({ data: { title: "Duplicate", estimatedDurationMinutes: 10, routineOccurrenceId: occurrence.id } }),
    (error: Prisma.PrismaClientKnownRequestError) => {
      assert.equal(error.code, "P2002");
      assert.equal(isRoutineOccurrenceUniqueConflict(error), true, JSON.stringify(error.meta));
      return true;
    });
  await assert.rejects(prisma.routineOccurrence.delete({ where: { id: occurrence.id } }), (error: { code?: string }) => error.code === "P2003");
  await request("DELETE", `/tasks/${occurrence.task!.id}`);
  const repeated = await request("POST", `/routines/${r.id}/generate`, range);
  assert.equal(repeated.body.createdCount, 0); assert.equal(repeated.body.existingCount, 7);
  assert.equal((await request("GET", `/tasks/${occurrence.task!.id}`)).status, 404);

  // A real PostgreSQL trigger fails the fourth CREATED write, after three complete Task inserts.
  await sql.query(`CREATE FUNCTION fail_generated_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."type" = 'CREATED' AND NEW."metadata"->'after'->>'title' = 'Fail batch'
      AND (SELECT count(*) FROM "TaskAction" WHERE "type" = 'CREATED' AND "metadata"->'after'->>'title' = 'Fail batch') >= 3
    THEN RAISE EXCEPTION 'test journal failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_generated_event BEFORE INSERT ON "TaskAction" FOR EACH ROW EXECUTE FUNCTION fail_generated_event();`);
  const failing = (await request("POST", "/routines", { ...input, title: "Fail batch" })).body;
  assert.equal((await request("POST", `/routines/${failing.id}/generate`, range)).status, 500);
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: failing.id } }), 0);
  assert.equal(await prisma.task.count({ where: { title: "Fail batch" } }), 0);
  await sql.query("DROP TRIGGER fail_generated_event ON \"TaskAction\"; DROP FUNCTION fail_generated_event()");

  // Real generation racing with pause: either generation wins first or safely returns 409.
  const pausing = (await request("POST", "/routines", input)).body;
  const [generation, pause] = await Promise.all([
    request("POST", `/routines/${pausing.id}/generate`, range), request("PATCH", `/routines/${pausing.id}`, { paused: true }),
  ]);
  assert.equal(pause.status, 200); assert.ok([200, 409].includes(generation.status));
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: pausing.id } }), generation.status === 200 ? 7 : 0);
  assert.equal((await request("POST", `/routines/${pausing.id}/generate`, range)).status, 409);

  const changing = (await request("POST", "/routines", { ...input, startDate: "2000-01-01" })).body;
  const [configGeneration, patch] = await Promise.all([
    request("POST", `/routines/${changing.id}/generate`, { from: "2000-01-01", to: "2000-01-14" }),
    request("PATCH", `/routines/${changing.id}`, { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 3 } } }),
  ]);
  assert.deepEqual([configGeneration.status, patch.status].sort(), [200, 409]);
  const afterRace = await prisma.routine.findUniqueOrThrow({ where: { id: changing.id } });
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: changing.id } }), configGeneration.status === 200 ? 7 : 0);
  if (configGeneration.status === 200) assert.deepEqual(afterRace.schedule, changing.schedule);

  const removing = (await request("POST", "/routines", input)).body;
  const [deleteGeneration, removal] = await Promise.all([
    request("POST", `/routines/${removing.id}/generate`, range), request("DELETE", `/routines/${removing.id}`),
  ]);
  assert.equal(removal.status, 204); assert.ok([200, 404].includes(deleteGeneration.status));
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: removing.id } }), deleteGeneration.status === 200 ? 7 : 0);
  assert.equal((await request("POST", `/routines/${removing.id}/generate`, range)).status, 404);

  const area = (await request("POST", "/areas", { name: "Generation race" })).body;
  const linked = (await request("POST", "/routines", { ...input, areaId: area.id })).body;
  const [areaGeneration, deletion] = await Promise.all([
    request("POST", `/routines/${linked.id}/generate`, range), request("DELETE", `/areas/${area.id}`),
  ]);
  assert.equal(deletion.status, 204); assert.equal(areaGeneration.status, 200);
  assert.equal(await prisma.task.count({ where: { areaId: area.id } }), 0);
  assert.equal((await prisma.routine.findUniqueOrThrow({ where: { id: linked.id } })).areaId, null);
});
