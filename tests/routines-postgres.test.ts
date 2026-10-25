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
import { Temporal } from "@js-temporal/polyfill";

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
  const legacyRoutineId = randomUUID(), legacyOccurrenceId = randomUUID();
  for (const migration of migrations) {
    if (migration === "20261025120000_routine_occurrences") {
      await sql.query('INSERT INTO "Task" ("id", "title", "estimatedDurationMinutes", "updatedAt") VALUES ($1, $2, 10, now())', [ordinaryId, "Existing ordinary task"]);
    }
    if (migration === "20261025130000_routine_completion_chain") {
      await sql.query(`INSERT INTO "Routine" ("id", "title", "estimatedDurationMinutes", "timezone", "startDate", "schedule", "endCondition", "updatedAt")
        VALUES ($1, 'Legacy calendar', 10, 'UTC', '2026-01-01', '{"version":1,"recurrence":{"type":"DAILY","intervalDays":1}}', '{"type":"NEVER"}', now())`, [legacyRoutineId]);
      await sql.query(`INSERT INTO "RoutineOccurrence" ("id", "routineId", "occurrenceKey", "startDate", "endDate", "timezone", "snapshot")
        VALUES ($1, $2, 'legacy-calendar-key', '2026-01-01', '2026-01-01', 'UTC', '{}')`, [legacyOccurrenceId, legacyRoutineId]);
    }
    await sql.query(await readFile(path.join(directory, migration, "migration.sql"), "utf8"));
  }
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: ordinaryId } })).routineOccurrenceId, null);
  const legacy = await prisma.routineOccurrence.findUniqueOrThrow({ where: { id: legacyOccurrenceId } });
  assert.equal(legacy.occurrenceNumber, null); assert.equal(legacy.previousOccurrenceId, null); assert.equal(legacy.basisCompletedAt, null);
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

  const completionInput = { ...input, title: "Completion chain", startDate: "2026-01-01",
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } } };
  const completion = (await request("POST", "/routines", completionInput)).body;
  const firstResponses = await Promise.all([1, 2].map(() => request("POST", `/routines/${completion.id}/generate`, { from: "2026-01-01", to: "2026-01-01" })));
  assert.ok(firstResponses.every((response) => response.status === 200));
  assert.deepEqual(firstResponses.map((response) => response.body.createdCount).sort(), [0, 1]);
  const first = firstResponses.find((response) => response.body.createdCount === 1)!.body.created[0];
  assert.equal((await request("PATCH", `/tasks/${first.taskId}`, { status: "DONE" })).status, 200);
  const done = await prisma.taskAction.findFirstOrThrow({ where: { taskId: first.taskId, type: "STATUS_CHANGED" }, orderBy: { timestamp: "desc" } });
  const nextDate = Temporal.Instant.from(done.timestamp.toISOString()).toZonedDateTimeISO("Europe/Kyiv").toPlainDate().add({ days: 2 }).toString();
  const completionRange = { from: nextDate, to: nextDate };
  const successors = await Promise.all([1, 2].map(() => request("POST", `/routines/${completion.id}/generate`, completionRange)));
  assert.ok(successors.every((response) => response.status === 200), JSON.stringify(successors));
  assert.deepEqual(successors.map((response) => response.body.createdCount).sort(), [0, 1]);
  const second = await prisma.routineOccurrence.findFirstOrThrow({ where: { routineId: completion.id, occurrenceNumber: 2 }, include: { task: true } });
  assert.equal(second.basisCompletedAt!.toISOString(), done.timestamp.toISOString());
  assert.equal(second.startDate, nextDate);
  const { id: _secondId, task: _secondTask, ...secondFields } = second;
  for (const patch of [{ occurrenceKey: "duplicate-number" }, { occurrenceKey: "duplicate-predecessor", occurrenceNumber: 3 }]) {
    await assert.rejects(prisma.routineOccurrence.create({ data: { ...secondFields, snapshot: {}, ...patch } }),
      (error: Prisma.PrismaClientKnownRequestError) => error.code === "P2002" && isRoutineOccurrenceUniqueConflict(error));
  }
  await request("PATCH", `/tasks/${first.taskId}`, { status: "TODO" });
  const retry = await request("POST", `/routines/${completion.id}/generate`, completionRange);
  assert.equal(retry.status, 200); assert.equal(retry.body.existing[0].taskId, second.task!.id);
  await request("PATCH", `/tasks/${second.task!.id}`, { status: "DONE" });
  const nextDone = await prisma.taskAction.findFirstOrThrow({ where: { taskId: second.task!.id, type: "STATUS_CHANGED" }, orderBy: { timestamp: "desc" } });
  const thirdDate = Temporal.Instant.from(nextDone.timestamp.toISOString()).toZonedDateTimeISO("Europe/Kyiv").toPlainDate().add({ days: 2 }).toString();
  const [continuation, reopening] = await Promise.all([
    request("POST", `/routines/${completion.id}/generate`, { from: thirdDate, to: thirdDate }),
    request("PATCH", `/tasks/${second.task!.id}`, { status: "TODO" }),
  ]);
  assert.equal(reopening.status, 200); assert.ok([200, 409].includes(continuation.status), JSON.stringify(continuation));
  const completionCount = await prisma.routineOccurrence.count({ where: { routineId: completion.id } });
  assert.equal(completionCount, continuation.body.createdCount === 1 ? 3 : 2);
  if (continuation.body.createdCount === 1) {
    const third = await prisma.routineOccurrence.findFirstOrThrow({ where: { routineId: completion.id, occurrenceNumber: 3 } });
    assert.equal(third.previousOccurrenceId, second.id); assert.equal(third.basisCompletedAt!.toISOString(), nextDone.timestamp.toISOString());
  }

  const automatic = (await request("POST", "/routines", { ...completionInput, subtasks: [{ title: "Done automatically", estimatedDurationMinutes: 5 }] })).body;
  const parentId = (await request("POST", `/routines/${automatic.id}/generate`, { from: "2026-01-01", to: "2026-01-01" })).body.created[0].taskId;
  const child = await prisma.subtask.findFirstOrThrow({ where: { taskId: parentId } });
  const [automaticStatus, automaticGeneration] = await Promise.all([
    request("PATCH", `/tasks/${parentId}/subtasks/${child.id}`, { status: "DONE" }),
    request("POST", `/routines/${automatic.id}/generate`, completionRange),
  ]);
  assert.equal(automaticStatus.status, 200); assert.ok([200, 409].includes(automaticGeneration.status));
  assert.equal((await request("POST", `/routines/${automatic.id}/generate`, completionRange)).status, 200);
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: automatic.id } }), 2);
  const automaticDone = await prisma.taskAction.findFirstOrThrow({ where: { taskId: parentId, type: "STATUS_CHANGED" } });
  const automaticNext = await prisma.routineOccurrence.findFirstOrThrow({ where: { routineId: automatic.id, occurrenceNumber: 2 } });
  assert.equal(automaticNext.basisCompletedAt!.toISOString(), automaticDone.timestamp.toISOString());

  const deletingCompletion = (await request("POST", "/routines", completionInput)).body;
  const deletingTaskId = (await request("POST", `/routines/${deletingCompletion.id}/generate`, { from: "2026-01-01", to: "2026-01-01" })).body.created[0].taskId;
  await request("PATCH", `/tasks/${deletingTaskId}`, { status: "DONE" });
  const [deletingGeneration, taskDeletion] = await Promise.all([
    request("POST", `/routines/${deletingCompletion.id}/generate`, completionRange), request("DELETE", `/tasks/${deletingTaskId}`),
  ]);
  assert.equal(taskDeletion.status, 204); assert.ok([200, 409].includes(deletingGeneration.status));
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: deletingCompletion.id } }), deletingGeneration.status === 200 ? 2 : 1);

  await sql.query(`CREATE FUNCTION fail_completion_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."type" = 'SUBTASK_CREATED' AND EXISTS (
      SELECT 1 FROM "Task" t JOIN "RoutineOccurrence" o ON t."routineOccurrenceId" = o."id"
      WHERE t."id" = NEW."taskId" AND t."title" = 'Fail completion' AND o."occurrenceNumber" = 2)
    THEN RAISE EXCEPTION 'test completion journal failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_completion_event BEFORE INSERT ON "TaskAction" FOR EACH ROW EXECUTE FUNCTION fail_completion_event();`);
  const failingCompletion = (await request("POST", "/routines", { ...completionInput, title: "Fail completion",
    subtasks: [{ title: "Child rollback", estimatedDurationMinutes: 5 }] })).body;
  const failingFirst = (await request("POST", `/routines/${failingCompletion.id}/generate`, { from: "2026-01-01", to: "2026-01-01" })).body.created[0];
  await request("PATCH", `/tasks/${failingFirst.taskId}`, { status: "DONE" });
  const beforeFailure = { tasks: await prisma.task.count(), children: await prisma.subtask.count(), actions: await prisma.taskAction.count() };
  assert.equal((await request("POST", `/routines/${failingCompletion.id}/generate`, completionRange)).status, 500);
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: failingCompletion.id } }), 1);
  assert.deepEqual({ tasks: await prisma.task.count(), children: await prisma.subtask.count(), actions: await prisma.taskAction.count() }, beforeFailure);
});
