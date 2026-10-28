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
import { createRoutinesRouter } from "../src/modules/tasks/routines/http/routines.routes";
import { createTasksRouter } from "../src/modules/tasks/http/tasks.routes";
import { createAreasRouter } from "../src/modules/areas/http/areas.routes";
import { errorHandler } from "../src/http/middleware/error-handler";
import { isRoutineOccurrenceUniqueConflict, createRoutinesRepository } from "../src/modules/tasks/routines/routines.repository";
import { createRoutinesService } from "../src/modules/tasks/routines/routines.service";
import { createRoutineRunner } from "../src/modules/tasks/routines/runner/routines.runner";
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
  const legacyFirstId = randomUUID(), legacySuccessorId = randomUUID();
  const legacyPausedId = randomUUID(), legacyDeletedId = randomUUID();
  const legacyBasis = "2026-01-02T12:00:00.000Z";
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
    if (migration === "20261026120000_task_skipped") {
      // Seed the old schema before the additive migration: both first and successor must survive.
      await sql.query(`INSERT INTO "RoutineOccurrence"
        ("id", "routineId", "occurrenceKey", "startDate", "endDate", "timezone", "snapshot", "occurrenceNumber", "previousOccurrenceId", "basisCompletedAt")
        VALUES ($1, $3, 'legacy-completion-1', '2026-01-01', '2026-01-01', 'UTC', '{}', 1, NULL, NULL),
          ($2, $3, 'legacy-completion-2', '2026-01-04', '2026-01-04', 'UTC', '{}', 2, $1, $4)`,
      [legacyFirstId, legacySuccessorId, legacyRoutineId, legacyBasis]);
    }
    if (migration === "20261026130000_routine_schedule_versions") {
      await sql.query(`INSERT INTO "Routine" ("id", "title", "estimatedDurationMinutes", "timezone", "startDate", "schedule", "endCondition", "pausedAt", "deletedAt", "updatedAt")
        VALUES ($1, 'Legacy paused', 10, 'Europe/Kyiv', '2026-10-25', '{"version":1,"recurrence":{"type":"DAILY","intervalDays":2}}', '{"type":"NEVER"}', now(), NULL, now()),
          ($2, 'Legacy deleted', 10, 'UTC', '2026-01-01', '{"version":1,"recurrence":{"type":"AFTER_COMPLETION","intervalDays":3}}', '{"type":"COUNT","count":5}', NULL, now(), now())`,
      [legacyPausedId, legacyDeletedId]);
    }
    await sql.query(await readFile(path.join(directory, migration, "migration.sql"), "utf8"));
  }
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: ordinaryId } })).routineOccurrenceId, null);
  for (const legacyId of [legacyRoutineId, legacyPausedId, legacyDeletedId]) {
    const routine = await prisma.routine.findUniqueOrThrow({ where: { id: legacyId } });
    assert.equal(routine.autoGenerate, false); assert.equal(routine.generationHorizonDays, 7);
  }
  for (const invalid of [0, 31]) await assert.rejects(sql.query('UPDATE "Routine" SET "generationHorizonDays" = $1 WHERE "id" = $2',
    [invalid, legacyRoutineId]), (error: { code?: string }) => error.code === "23514");
  const legacy = await prisma.routineOccurrence.findUniqueOrThrow({ where: { id: legacyOccurrenceId } });
  assert.equal(legacy.occurrenceNumber, null); assert.equal(legacy.previousOccurrenceId, null); assert.equal(legacy.basisCompletedAt, null);
  assert.equal(legacy.basisType, null); assert.equal(legacy.basisAt, null);
  const oldFirst = await prisma.routineOccurrence.findUniqueOrThrow({ where: { id: legacyFirstId } });
  assert.equal(oldFirst.basisType, null); assert.equal(oldFirst.basisAt, null);
  const oldSuccessor = await prisma.routineOccurrence.findUniqueOrThrow({ where: { id: legacySuccessorId } });
  assert.equal(oldSuccessor.basisType, "COMPLETED"); assert.equal(oldSuccessor.basisAt!.toISOString(), legacyBasis);
  assert.equal(oldSuccessor.basisCompletedAt!.toISOString(), legacyBasis);
  const backfilledVersion = await prisma.routineScheduleVersion.findFirstOrThrow({ where: { routineId: legacyRoutineId } });
  assert.equal(backfilledVersion.number, 1); assert.equal(backfilledVersion.effectiveDate, "2026-01-01");
  assert.equal(backfilledVersion.timezone, "UTC"); assert.equal(backfilledVersion.effectiveTimezone, "UTC");
  assert.equal(legacy.scheduleVersionId, backfilledVersion.id);
  assert.equal(oldFirst.scheduleVersionId, backfilledVersion.id); assert.equal(oldSuccessor.scheduleVersionId, backfilledVersion.id);
  assert.equal(oldSuccessor.startDate, "2026-01-04"); assert.equal(oldSuccessor.previousOccurrenceId, legacyFirstId);
  const pausedVersion = await prisma.routineScheduleVersion.findFirstOrThrow({ where: { routineId: legacyPausedId } });
  assert.equal(pausedVersion.effectiveAt.toISOString(), "2026-10-24T21:00:00.000Z");
  assert.equal(pausedVersion.effectiveTimezone, "Europe/Kyiv");
  const deletedVersion = await prisma.routineScheduleVersion.findFirstOrThrow({ where: { routineId: legacyDeletedId } });
  assert.deepEqual(deletedVersion.endCondition, { type: "COUNT", count: 5 });
  assert.ok((await prisma.routine.findUniqueOrThrow({ where: { id: legacyDeletedId } })).deletedAt);
  for (const statement of ['UPDATE "RoutineScheduleVersion" SET "timezone" = \'Europe/Kyiv\' WHERE "id" = $1',
    'DELETE FROM "RoutineScheduleVersion" WHERE "id" = $1']) {
    await assert.rejects(sql.query(statement, [backfilledVersion.id]), (error: { code?: string }) => error.code === "23514");
  }
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: ordinaryId } })).skipNote, null);
  await assert.rejects(sql.query('UPDATE "Task" SET "status" = \'SKIPPED\' WHERE "id" = $1', [ordinaryId]),
    (error: { code?: string }) => error.code === "23514");
  for (const invalid of [
    'UPDATE "RoutineOccurrence" SET "basisType" = NULL WHERE "id" = $1',
    'UPDATE "RoutineOccurrence" SET "basisAt" = NULL WHERE "id" = $1',
    'UPDATE "RoutineOccurrence" SET "basisType" = \'SKIPPED\' WHERE "id" = $1',
    'UPDATE "RoutineOccurrence" SET "basisCompletedAt" = "basisAt" + interval \'1 second\' WHERE "id" = $1',
  ]) await assert.rejects(sql.query(invalid, [legacySuccessorId]), (error: { code?: string }) => error.code === "23514");
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

  const plannedRoutine = (await request("POST", "/routines", input)).body;
  const beforePreviewCounts = { tasks: await prisma.task.count(), occurrences: await prisma.routineOccurrence.count(), actions: await prisma.taskAction.count() };
  const plannedPreview = await request("GET", `/routines/${plannedRoutine.id}/generation-preview?from=2026-10-25&to=2026-10-25`);
  assert.equal(plannedPreview.status, 200); assert.equal(plannedPreview.body.occurrences[0].existing, false);
  assert.deepEqual({ tasks: await prisma.task.count(), occurrences: await prisma.routineOccurrence.count(), actions: await prisma.taskAction.count() }, beforePreviewCounts);
  const plans = ["2026-12-01T16:00:00+02:00", "2026-12-02T09:00:00-05:00"];
  const plannedKey = plannedPreview.body.occurrences[0].occurrenceKey;
  const plannedRequests = await Promise.all(plans.map((plannedAt) => request("POST", `/routines/${plannedRoutine.id}/generate`, {
    from: "2026-10-25", to: "2026-10-25", planning: [{ occurrenceKey: plannedKey, plannedAt }],
  })));
  assert.ok(plannedRequests.every((response) => response.status === 200), JSON.stringify(plannedRequests));
  assert.deepEqual(plannedRequests.map((response) => response.body.createdCount).sort(), [0, 1]);
  const planWinner = plannedRequests.findIndex((response) => response.body.createdCount === 1);
  const plannedTaskId = plannedRequests[planWinner].body.created[0].taskId;
  const plannedTask = await prisma.task.findUniqueOrThrow({ where: { id: plannedTaskId } });
  assert.equal(plannedTask.plannedAt!.toISOString(), new Date(plans[planWinner]).toISOString());
  const plannedEvent = await prisma.taskAction.findFirstOrThrow({ where: { taskId: plannedTaskId, type: "CREATED" } });
  assert.equal((plannedEvent.metadata as { after: { plannedAt: string } }).after.plannedAt, plannedTask.plannedAt!.toISOString());
  assert.equal(await prisma.taskAction.count({ where: { taskId: plannedTaskId } }), 1);
  const plannedRetry = await request("POST", `/routines/${plannedRoutine.id}/generate`, {
    from: "2026-10-25", to: "2026-10-25", planning: [{ occurrenceKey: plannedKey, plannedAt: "2027-01-01T00:00:00Z" }],
  });
  assert.equal(plannedRetry.body.createdCount, 0); assert.equal(plannedRetry.body.existing[0].taskId, plannedTaskId);
  assert.deepEqual(await prisma.task.findUniqueOrThrow({ where: { id: plannedTaskId } }), plannedTask);
  const privatePreview = await request("GET", `/routines/${r.id}/generation-preview?from=${range.from}&to=${range.to}`);
  assert.ok(privatePreview.body.occurrences.every((entry: { existing: boolean; taskId?: string; title?: string }) => entry.existing && entry.taskId === undefined && entry.title === undefined));

  // A real PostgreSQL trigger fails the fourth CREATED write, after three complete Task inserts.
  await sql.query(`CREATE FUNCTION fail_generated_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."type" = 'CREATED' AND NEW."metadata"->'after'->>'title' = 'Fail batch'
      AND (SELECT count(*) FROM "TaskAction" WHERE "type" = 'CREATED' AND "metadata"->'after'->>'title' = 'Fail batch') >= 3
    THEN RAISE EXCEPTION 'test journal failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_generated_event BEFORE INSERT ON "TaskAction" FOR EACH ROW EXECUTE FUNCTION fail_generated_event();`);
  const failing = (await request("POST", "/routines", { ...input, title: "Fail batch" })).body;
  assert.equal((await request("POST", `/routines/${failing.id}/generate`, { ...range,
    planning: [{ occurrenceKey: `v1:${failing.id}:daily:2026-10-25`, plannedAt: "2026-12-01T10:00:00Z" }] })).status, 500);
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
  const successorPreview = await request("GET", `/routines/${completion.id}/generation-preview?from=${nextDate}&to=${nextDate}`);
  assert.equal(successorPreview.status, 200); assert.equal(successorPreview.body.occurrences[0].existing, false);
  const successors = await Promise.all(plans.map((plannedAt) => request("POST", `/routines/${completion.id}/generate`, { ...completionRange,
    planning: [{ occurrenceKey: successorPreview.body.occurrences[0].occurrenceKey, plannedAt }] })));
  assert.ok(successors.every((response) => response.status === 200), JSON.stringify(successors));
  assert.deepEqual(successors.map((response) => response.body.createdCount).sort(), [0, 1]);
  const second = await prisma.routineOccurrence.findFirstOrThrow({ where: { routineId: completion.id, occurrenceNumber: 2 }, include: { task: true } });
  assert.equal(second.basisCompletedAt!.toISOString(), done.timestamp.toISOString());
  assert.equal(second.basisType, "COMPLETED"); assert.equal(second.basisAt!.toISOString(), done.timestamp.toISOString());
  assert.equal(second.startDate, nextDate);
  const successorWinner = successors.findIndex((response) => response.body.createdCount === 1);
  assert.equal(second.task!.plannedAt!.toISOString(), new Date(plans[successorWinner]).toISOString());
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

  const skipRoutine = (await request("POST", "/routines", { ...completionInput,
    title: "Skip chain", subtasks: [{ title: "Remain TODO", estimatedDurationMinutes: 5 }] })).body;
  const skipFirst = (await request("POST", `/routines/${skipRoutine.id}/generate`, { from: "2026-01-01", to: "2026-01-01" })).body.created[0];
  const skipChild = await prisma.subtask.findFirstOrThrow({ where: { taskId: skipFirst.taskId } });
  await assert.rejects(sql.query('UPDATE "Subtask" SET "status" = \'SKIPPED\' WHERE "id" = $1', [skipChild.id]),
    (error: { code?: string }) => error.code === "23514");
  const [skipMutation, skipGeneration] = await Promise.all([
    request("PATCH", `/tasks/${skipFirst.taskId}`, { status: "SKIPPED", skipNote: "  Local DB skip  " }),
    request("POST", `/routines/${skipRoutine.id}/generate`, completionRange),
  ]);
  assert.equal(skipMutation.status, 200); assert.ok([200, 409].includes(skipGeneration.status), JSON.stringify(skipGeneration));
  assert.equal(skipMutation.body.skipNote, "Local DB skip"); assert.equal(skipMutation.body.completedAt, null);
  const skipAction = await prisma.taskAction.findFirstOrThrow({ where: { taskId: skipFirst.taskId, type: "STATUS_CHANGED" } });
  assert.equal(skipMutation.body.skippedAt, skipAction.timestamp.toISOString());
  assert.equal((await prisma.subtask.findUniqueOrThrow({ where: { id: skipChild.id } })).status, "TODO");
  const skipDate = Temporal.Instant.from(skipAction.timestamp.toISOString()).toZonedDateTimeISO("Europe/Kyiv").toPlainDate().add({ days: 2 }).toString();
  const skipRange = { from: skipDate, to: skipDate };
  const skipSuccessors = await Promise.all([1, 2].map(() => request("POST", `/routines/${skipRoutine.id}/generate`, skipRange)));
  assert.ok(skipSuccessors.every((response) => response.status === 200), JSON.stringify(skipSuccessors));
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: skipRoutine.id } }), 2);
  const skipNext = await prisma.routineOccurrence.findFirstOrThrow({ where: { routineId: skipRoutine.id, occurrenceNumber: 2 }, include: { task: true } });
  assert.equal(skipNext.basisType, "SKIPPED"); assert.equal(skipNext.basisAt!.toISOString(), skipAction.timestamp.toISOString());
  assert.equal(skipNext.basisCompletedAt, null); assert.equal(skipNext.startDate, skipDate);
  for (const status of ["DONE", "SKIPPED", "TODO"] as const) {
    const result = await request("PATCH", `/tasks/${skipFirst.taskId}`, { status });
    assert.equal(result.status, 200);
    assert.equal((await request("POST", `/routines/${skipRoutine.id}/generate`, skipRange)).body.createdCount, 0);
    assert.deepEqual(await prisma.routineOccurrence.findUniqueOrThrow({ where: { id: skipNext.id }, include: { task: true } }), skipNext);
  }
  // Race reopening the latest skipped execution against generation under real row locks.
  await request("PATCH", `/tasks/${skipNext.task!.id}`, { status: "SKIPPED" });
  const latestSkipAction = await prisma.taskAction.findFirstOrThrow({ where: { taskId: skipNext.task!.id, type: "STATUS_CHANGED" } });
  const raceDate = Temporal.Instant.from(latestSkipAction.timestamp.toISOString()).toZonedDateTimeISO("Europe/Kyiv").toPlainDate().add({ days: 2 }).toString();
  const [skipReopen, skipContinuation] = await Promise.all([
    request("PATCH", `/tasks/${skipNext.task!.id}`, { status: "TODO" }),
    request("POST", `/routines/${skipRoutine.id}/generate`, { from: raceDate, to: raceDate }),
  ]);
  assert.equal(skipReopen.status, 200); assert.ok([200, 409].includes(skipContinuation.status), JSON.stringify(skipContinuation));
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: skipRoutine.id } }), skipContinuation.body.createdCount === 1 ? 3 : 2);
  if (skipContinuation.body.createdCount === 1) {
    const third = await prisma.routineOccurrence.findFirstOrThrow({ where: { routineId: skipRoutine.id, occurrenceNumber: 3 } });
    assert.equal(third.basisType, "SKIPPED"); assert.equal(third.basisAt!.toISOString(), latestSkipAction.timestamp.toISOString());
  }

  const rollbackRoutine = (await request("POST", "/routines", { ...completionInput, title: "Skip rollback" })).body;
  const rollbackId = (await request("POST", `/routines/${rollbackRoutine.id}/generate`, { from: "2026-01-01", to: "2026-01-01" })).body.created[0].taskId;
  await sql.query(`CREATE FUNCTION fail_skip_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."type" = 'STATUS_CHANGED' AND NEW."metadata"->'after'->>'status' = 'SKIPPED'
      AND EXISTS (SELECT 1 FROM "Task" WHERE "id" = NEW."taskId" AND "title" = 'Skip rollback')
    THEN RAISE EXCEPTION 'test skip journal failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_skip_event BEFORE INSERT ON "TaskAction" FOR EACH ROW EXECUTE FUNCTION fail_skip_event();`);
  const beforeSkipFailure = await prisma.task.findUniqueOrThrow({ where: { id: rollbackId } });
  const beforeSkipActions = await prisma.taskAction.count({ where: { taskId: rollbackId } });
  assert.equal((await request("PATCH", `/tasks/${rollbackId}`, { status: "SKIPPED", skipNote: "Rollback" })).status, 500);
  assert.deepEqual(await prisma.task.findUniqueOrThrow({ where: { id: rollbackId } }), beforeSkipFailure);
  assert.equal(await prisma.taskAction.count({ where: { taskId: rollbackId } }), beforeSkipActions);

  // Version appends race the existing generation operation under the same Routine lock.
  const boundary = Temporal.Now.instant().toZonedDateTimeISO("UTC").toPlainDate().add({ days: 10 });
  const versionEnd = boundary.add({ days: 4 }).toString();
  const versionInput = { title: "Version race", estimatedDurationMinutes: 10, timezone: "UTC", startDate: "2026-01-01",
    schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 1 }, localTime: "09:00" } };
  const versionRoutine = (await request("POST", "/routines", versionInput)).body;
  const versionBody = { effectiveDate: boundary.toString(), timezone: "UTC", startDate: boundary.toString(),
    schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 1 }, localTime: "18:00" }, endCondition: { type: "NEVER" } };
  const versionRange = { from: boundary.toString(), to: versionEnd };
  const [append, raceGeneration] = await Promise.all([
    request("POST", `/routines/${versionRoutine.id}/schedule-versions`, versionBody),
    request("POST", `/routines/${versionRoutine.id}/generate`, versionRange),
  ]);
  assert.equal(append.status, 201, JSON.stringify(append)); assert.equal(raceGeneration.status, 200, JSON.stringify(raceGeneration));
  const frozenVersionTasks = await prisma.task.findMany({ where: { routineOccurrence: { routineId: versionRoutine.id } }, orderBy: { id: "asc" } });
  const frozenVersionOccurrences = await prisma.routineOccurrence.findMany({ where: { routineId: versionRoutine.id }, orderBy: { id: "asc" } });
  const versionRepeats = await Promise.all([1, 2].map(() => request("POST", `/routines/${versionRoutine.id}/generate`, versionRange)));
  assert.ok(versionRepeats.every((response) => response.status === 200 && response.body.createdCount === 0), JSON.stringify(versionRepeats));
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: versionRoutine.id } }), 5);
  assert.equal(new Set(frozenVersionOccurrences.map((entry) => entry.startDate)).size, 5, "version key changes cannot duplicate occupied windows");
  assert.deepEqual(await prisma.task.findMany({ where: { routineOccurrence: { routineId: versionRoutine.id } }, orderBy: { id: "asc" } }), frozenVersionTasks);
  assert.deepEqual(await prisma.routineOccurrence.findMany({ where: { routineId: versionRoutine.id }, orderBy: { id: "asc" } }), frozenVersionOccurrences);
  assert.equal(await prisma.routineScheduleVersion.count({ where: { routineId: versionRoutine.id } }), 2);
  const nextBoundary = boundary.add({ days: 5 }).toString();
  const appendRaces = await Promise.all([1, 2].map(() => request("POST", `/routines/${versionRoutine.id}/schedule-versions`, {
    ...versionBody, effectiveDate: nextBoundary, startDate: nextBoundary,
  })));
  assert.deepEqual(appendRaces.map((response) => response.status).sort(), [201, 409]);
  assert.equal(await prisma.routineScheduleVersion.count({ where: { routineId: versionRoutine.id } }), 3);
  await assert.rejects(sql.query(`INSERT INTO "RoutineScheduleVersion"
    ("id", "routineId", "number", "effectiveDate", "effectiveTimezone", "effectiveAt", "timezone", "startDate", "schedule", "endCondition")
    SELECT $1, "routineId", 99, '2099-01-01', "effectiveTimezone", '2099-01-01T00:00:00Z', "timezone", "startDate", "schedule", "endCondition"
    FROM "RoutineScheduleVersion" WHERE "id" = $2`, [randomUUID(), append.body.id]), (error: { code?: string }) => error.code === "23514");
  const foreignVersion = await prisma.routineScheduleVersion.findFirstOrThrow({ where: { routineId: versionRoutine.id } });
  await assert.rejects(prisma.routineOccurrence.create({ data: { routineId: legacyRoutineId, scheduleVersionId: foreignVersion.id,
    occurrenceKey: "wrong-version-owner", startDate: "2026-02-01", endDate: "2026-02-01", timezone: "UTC", snapshot: {} } }),
  (error: { code?: string }) => error.code === "P2003");

  const staleRoutine = (await request("POST", "/routines", { ...versionInput, title: "Stale version planning" })).body;
  const staleKey = (await request("GET", `/routines/${staleRoutine.id}/generation-preview?from=${versionRange.from}&to=${versionRange.from}`)).body.occurrences[0].occurrenceKey;
  assert.equal((await request("POST", `/routines/${staleRoutine.id}/schedule-versions`, versionBody)).status, 201);
  assert.equal((await request("POST", `/routines/${staleRoutine.id}/generate`, { ...versionRange,
    planning: [{ occurrenceKey: staleKey, plannedAt: "2099-01-01T09:00:00Z" }] })).status, 400);
  assert.equal(await prisma.routineOccurrence.count({ where: { routineId: staleRoutine.id } }), 0);

  const versionRollback = (await request("POST", "/routines", { ...versionInput, title: "Version rollback" })).body;
  await sql.query(`CREATE FUNCTION fail_version_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."type"::text = 'SCHEDULE_VERSION_CREATED'
      AND EXISTS (SELECT 1 FROM "Routine" WHERE "id" = NEW."routineId" AND "title" = 'Version rollback')
    THEN RAISE EXCEPTION 'test version journal failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_version_event BEFORE INSERT ON "RoutineAction" FOR EACH ROW EXECUTE FUNCTION fail_version_event();`);
  const beforeVersionFailure = await prisma.routine.findUniqueOrThrow({ where: { id: versionRollback.id } });
  const beforeVersionActions = await prisma.routineAction.count({ where: { routineId: versionRollback.id } });
  assert.equal((await request("POST", `/routines/${versionRollback.id}/schedule-versions`, versionBody)).status, 500);
  assert.deepEqual(await prisma.routine.findUniqueOrThrow({ where: { id: versionRollback.id } }), beforeVersionFailure);
  assert.equal(await prisma.routineScheduleVersion.count({ where: { routineId: versionRollback.id } }), 1);
  assert.equal(await prisma.routineAction.count({ where: { routineId: versionRollback.id } }), beforeVersionActions);

  const versionCompletion = (await request("POST", "/routines", { ...completionInput, timezone: "UTC", title: "Version completion" })).body;
  const versionFirst = (await request("POST", `/routines/${versionCompletion.id}/generate`, { from: "2026-01-01", to: "2026-01-01" })).body.created[0];
  const completionBoundary = Temporal.Now.instant().toZonedDateTimeISO("UTC").toPlainDate().add({ days: 1 }).toString();
  const completionVersion = await request("POST", `/routines/${versionCompletion.id}/schedule-versions`, {
    ...versionBody, effectiveDate: completionBoundary, startDate: "2026-01-01",
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 4 } }, endCondition: { type: "COUNT", count: 2 },
  });
  assert.equal(completionVersion.status, 201, JSON.stringify(completionVersion));
  const versionSkip = await request("PATCH", `/tasks/${versionFirst.taskId}`, { status: "SKIPPED" });
  assert.equal(versionSkip.status, 200);
  const versionNextDate = Temporal.Instant.from(versionSkip.body.skippedAt).toZonedDateTimeISO("UTC").toPlainDate().add({ days: 4 }).toString();
  const versionSuccessor = await request("POST", `/routines/${versionCompletion.id}/generate`, { from: versionNextDate, to: versionNextDate });
  assert.equal(versionSuccessor.status, 200, JSON.stringify(versionSuccessor)); assert.equal(versionSuccessor.body.createdCount, 1);
  const versionSecond = await prisma.routineOccurrence.findFirstOrThrow({ where: { routineId: versionCompletion.id, occurrenceNumber: 2 } });
  assert.equal(versionSecond.scheduleVersionId, completionVersion.body.id); assert.equal(versionSecond.basisType, "SKIPPED");
  assert.equal(versionSecond.basisAt!.toISOString(), versionSkip.body.skippedAt); assert.equal(versionSecond.basisCompletedAt, null);
  await request("PATCH", `/tasks/${versionFirst.taskId}`, { status: "TODO" });
  assert.equal((await request("POST", `/routines/${versionCompletion.id}/generate`, { from: versionNextDate, to: versionNextDate })).body.createdCount, 0);
  assert.deepEqual(await prisma.routineOccurrence.findUniqueOrThrow({ where: { id: versionSecond.id } }), versionSecond);

  await t.test("two runners and manual generation use real PostgreSQL locks and preserve planning", async () => {
    const repository = createRoutinesRepository(() => prisma);
    const service = createRoutinesService(repository);
    const today = Temporal.Now.instant().toZonedDateTimeISO("UTC").toPlainDate().toString();
    const routine = (await request("POST", "/routines", { ...versionInput, autoGenerate: true })).body;
    const logger = { info() {}, warn() {} };
    const first = createRoutineRunner({ repository, service, logger });
    const second = createRoutineRunner({ repository, service, logger });
    const manualRange = { from: today, to: Temporal.PlainDate.from(today).add({ days: 6 }).toString() };
    const manual = service.generate(routine.id, manualRange);
    const results = await Promise.all([first.runOnce(), second.runOnce(), manual]);
    assert.equal(results[0].errors + results[1].errors, 0);
    assert.equal(results[0].created + results[1].created + results[2].createdCount, 7);
    assert.equal(await prisma.routineOccurrence.count({ where: { routineId: routine.id } }), 7);
    const task = await prisma.task.findFirstOrThrow({ where: { routineOccurrence: { routineId: routine.id } } });
    await request("PATCH", `/tasks/${task.id}`, { plannedAt: "2099-01-01T12:00:00Z" });
    const before = await prisma.task.findMany({ where: { routineOccurrence: { routineId: routine.id } }, orderBy: { id: "asc" } });
    await first.runOnce(); await first.runOnce();
    assert.deepEqual(await prisma.task.findMany({ where: { routineOccurrence: { routineId: routine.id } }, orderBy: { id: "asc" } }), before);
    await first.stop(); await second.stop();
    await request("PATCH", `/routines/${routine.id}`, { autoGenerate: false });
  });

  for (const patch of [{ autoGenerate: false }, { paused: true }, { generationHorizonDays: 1 }]) {
    await t.test(`settings change before runner lock is rechecked: ${JSON.stringify(patch)}`, async () => {
      const routine = (await request("POST", "/routines", { ...versionInput, autoGenerate: true })).body;
      const repository = createRoutinesRepository(() => prisma);
      let signal!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => { signal = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let gated = false;
      const service = createRoutinesService({ ...repository, transaction: (work) => repository.transaction(async (tx) => {
        const originalLock = tx.lock;
        return work({ ...tx, async lock(id) {
          if (!gated) { gated = true; signal(); await gate; }
          return originalLock(id);
        } });
      }) });
      const generation = service.generateAutomatically(routine.id);
      await entered;
      try { assert.equal((await request("PATCH", `/routines/${routine.id}`, patch)).status, 200); }
      finally { release(); }
      const generated = await generation;
      if ("generationHorizonDays" in patch) assert.equal(generated!.createdCount, 1);
      else assert.equal(generated, null);
      assert.equal(await prisma.routineOccurrence.count({ where: { routineId: routine.id } }), "generationHorizonDays" in patch ? 1 : 0);
    });
  }

  await t.test("runner journal failure fully rolls back one routine and processes the next", async () => {
    const routine = (await request("POST", "/routines", { ...versionInput, title: "Auto rollback", autoGenerate: true })).body;
    const healthy = (await request("POST", "/routines", { ...versionInput, autoGenerate: true })).body;
    await sql.query(`CREATE FUNCTION fail_auto_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."type" = 'CREATED' AND EXISTS (SELECT 1 FROM "Task" WHERE "id" = NEW."taskId" AND "title" = 'Auto rollback')
      THEN RAISE EXCEPTION 'test automatic journal failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_auto_event BEFORE INSERT ON "TaskAction" FOR EACH ROW EXECUTE FUNCTION fail_auto_event();`);
    const repository = createRoutinesRepository(() => prisma);
    const runner = createRoutineRunner({ repository, service: createRoutinesService(repository), logger: { info() {}, warn() {} } });
    const result = await runner.runOnce();
    assert.equal(result.errors, 1);
    assert.equal(await prisma.routineOccurrence.count({ where: { routineId: routine.id } }), 0);
    assert.equal(await prisma.task.count({ where: { title: "Auto rollback" } }), 0);
    assert.equal(await prisma.routineOccurrence.count({ where: { routineId: healthy.id } }), 7);
    await runner.stop();
  });
});
