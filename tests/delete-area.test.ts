import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { Prisma, type PrismaClient } from "../src/generated/prisma/client";
import { createDeleteArea } from "../src/application/delete-area";
import { createAreasRepository } from "../src/modules/areas/areas.repository";
import { ApiError } from "../src/http/api-error";
import { fixture, input } from "./helpers/api-fixture";

type Call = { operation: string; args: unknown[]; client: Prisma.TransactionClient };
type Attempt = { options: unknown; calls: Call[]; client?: Prisma.TransactionClient };

// Intercept the real callback boundary, including both Area and Tasks/Routines queries.
// The fake only exposes writes in this callback; a nested transaction is an error.
function traceTransactions(client: PrismaClient) {
  const db = client as unknown as {
    $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options: { isolationLevel: string }): Promise<T>;
  };
  const original = db.$transaction.bind(db);
  const attempts: Attempt[] = [];
  db.$transaction = (work, options) => original(async (tx) => {
    const attempt: Attempt = { options, calls: [] };
    attempts.push(attempt);
    const traced = new Proxy(tx, {
      get(target, property) {
        assert.notEqual(property, "$transaction", "Nested operations must not open transactions");
        const value = Reflect.get(target, property);
        if (typeof value === "function") return (...args: unknown[]) => {
          attempt.calls.push({ operation: String(property), args, client: traced });
          return Reflect.apply(value, target, args);
        };
        if (value && typeof value === "object") return new Proxy(value, {
          get(delegate, method) {
            const query = Reflect.get(delegate, method);
            if (typeof query !== "function") return query;
            return (...args: unknown[]) => {
              attempt.calls.push({ operation: `${String(property)}.${String(method)}`, args, client: traced });
              return Reflect.apply(query, delegate, args);
            };
          },
        });
        return value;
      },
    });
    attempt.client = traced;
    return work(traced);
  }, options);
  return attempts;
}

function checkAttempt(attempt: Attempt, tasks: string[], routines: string[], areaId: string, deleted = true) {
  assert.deepEqual(attempt.options, { isolationLevel: "Serializable" });
  assert.ok(attempt.calls.every(call => call.client === attempt.client));
  assert.deepEqual(attempt.calls.map(call => call.operation), [
    "$queryRaw", "task.findMany",
    ...tasks.flatMap(() => ["task.update", "taskAction.create"]),
    "routine.findMany",
    ...routines.flatMap(() => ["routine.update", "routineAction.create"]),
    ...(deleted ? ["area.delete"] : []),
  ]);
  const [strings, id] = attempt.calls[0].args as [TemplateStringsArray, string];
  assert.match(strings.join("?"), /FROM "Area" WHERE "id" = \?::uuid FOR UPDATE/);
  assert.equal(id, areaId);
  assert.deepEqual(attempt.calls[1].args, [{ where: { areaId }, orderBy: { id: "asc" }, select: { id: true } }]);
  assert.deepEqual(attempt.calls.filter(call => call.operation === "task.update").map(call => call.args),
    tasks.map(id => [{ where: { id }, data: { areaId: null } }]));
  const linked = attempt.calls.find(call => call.operation === "routine.findMany")!;
  assert.deepEqual(linked.args, [{ where: { areaId }, orderBy: { id: "asc" }, include: {
    area: { select: { id: true, name: true } }, subtasks: { orderBy: [{ position: "asc" }, { id: "asc" }] },
  } }]);
  assert.deepEqual(attempt.calls.filter(call => call.operation === "routine.update")
    .map(call => (call.args[0] as { where: { id: string } }).where.id), routines);
}

async function linkedFixture(t: TestContext) {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-28T09:00:00Z"));
  const area = await f.createArea("Name at deletion");
  const other = await f.createArea("Other");
  const task = (await f.request("POST", "", { ...input, areaId: area.id,
    subtasks: [{ title: "Child", estimatedDurationMinutes: 5 }] })).body;
  await f.request("PATCH", `/${task.id}`, { archived: true });
  await f.request("DELETE", `/${task.id}`);
  const routineInput = { title: "Routine", areaId: area.id, timezone: "Europe/Kyiv", startDate: "2026-10-28",
    schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 1 } },
    subtasks: [{ title: "Template", estimatedDurationMinutes: 10 }] };
  const routine = (await f.routineRequest("POST", "", routineInput)).body;
  assert.equal((await f.routineRequest("POST", `/${routine.id}/generate`, { from: "2026-10-28", to: "2026-10-28" })).status, 200);
  await f.routineRequest("PATCH", `/${routine.id}`, { paused: true });
  const deleted = (await f.routineRequest("POST", "", routineInput)).body;
  await f.routineRequest("DELETE", `/${deleted.id}`);
  await f.request("POST", "", { ...input, areaId: other.id });
  await f.routineRequest("POST", "", { ...routineInput, areaId: other.id });
  const before = structuredClone(f.state());
  const at = new Date("2026-10-28T12:00:00Z");
  f.setTime(at);
  return { f, area, before, at,
    taskIds: before.tasks.filter(task => task.areaId === area.id).map(task => task.id).sort(),
    routineIds: before.routines.filter(routine => routine.areaId === area.id).map(routine => routine.id).sort(),
  };
}

test("coordinator returns unchanged 404 for a missing Area and removes an empty Area in one transaction", async (t) => {
  const f = await fixture(t);
  const attempts = traceTransactions(f.client);
  assert.deepEqual(await f.areaRequest("DELETE", `/${randomUUID()}`), {
    status: 404, body: { error: { message: "Area not found." } },
  });
  assert.deepEqual(attempts[0].calls.map(call => call.operation), ["$queryRaw"]);
  const area = await f.createArea();
  attempts.length = 0;
  assert.deepEqual(await f.areaRequest("DELETE", `/${area.id}`), { status: 204, body: null });
  assert.equal(attempts.length, 1);
  checkAttempt(attempts[0], [], [], area.id);
  assert.equal(f.state().areas.length, 0);
  assert.equal(f.state().actions.length, 0);
  assert.equal(f.state().routineActions.length, 0);
});

test("coordinator preserves one client, Tasks-before-Routines order, archived/deleted links, updatedAt and exact journals", async (t) => {
  const { f, area, before, at, taskIds, routineIds } = await linkedFixture(t);
  const attempts = traceTransactions(f.client);
  assert.deepEqual(await f.areaRequest("DELETE", `/${area.id}`), { status: 204, body: null });
  assert.equal(attempts.length, 1);
  checkAttempt(attempts[0], taskIds, routineIds, area.id);
  const after = f.state();
  assert.deepEqual(after.areas, before.areas.filter(entry => entry.id !== area.id));
  assert.deepEqual(after.tasks, before.tasks.map(task => task.areaId === area.id ? { ...task, areaId: null, updatedAt: at } : task));
  assert.deepEqual(after.routines, before.routines.map(routine => routine.areaId === area.id ? { ...routine, areaId: null, updatedAt: at } : routine));
  for (const key of ["subtasks", "routineSubtasks", "occurrences", "scheduleVersions"] as const) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.actions.slice(0, before.actions.length), before.actions);
  assert.deepEqual(after.routineActions.slice(0, before.routineActions.length), before.routineActions);
  assert.deepEqual(after.actions.slice(before.actions.length).map(({ taskId, type, timestamp, metadata }) => ({ taskId, type, timestamp, metadata })),
    taskIds.map(taskId => ({ taskId, type: "AREA_CHANGED", timestamp: at, metadata: {
      before: { areaId: area.id, area: { id: area.id, name: area.name } }, after: { areaId: null, area: null },
    } })));
  assert.deepEqual(after.routineActions.slice(before.routineActions.length).map(({ routineId, type, timestamp, metadata }) => ({ routineId, type, timestamp, metadata })),
    routineIds.map(routineId => {
      const row = before.routines.find(entry => entry.id === routineId)!;
      const snapshot = { ...row, area: { id: area.id, name: area.name },
        subtasks: before.routineSubtasks.filter(child => child.routineId === routineId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)) };
      return { routineId, type: "UPDATED", timestamp: at, metadata: JSON.parse(JSON.stringify({
        before: snapshot, after: { ...snapshot, areaId: null, area: null, updatedAt: at },
      })) };
    }));
});

test("a late Routine journal error rolls back Area, both kinds of links and all prior journals without retry", async (t) => {
  const { f, area, before, taskIds, routineIds } = await linkedFixture(t);
  const attempts = traceTransactions(f.client);
  f.failEvents(taskIds.length + routineIds.length - 1);
  assert.deepEqual(await f.areaRequest("DELETE", `/${area.id}`), { status: 500, body: { error: { message: "Internal server error." } } });
  assert.equal(attempts.length, 1);
  checkAttempt(attempts[0], taskIds, routineIds, area.id, false);
  assert.deepEqual(f.state(), before);
});

test("commit conflicts replay the entire ordered transaction without duplicate Task or Routine journals", async (t) => {
  const { f, area, before, taskIds, routineIds } = await linkedFixture(t);
  const attempts = traceTransactions(f.client);
  f.commitConflicts(3);
  assert.deepEqual(await f.areaRequest("DELETE", `/${area.id}`), {
    status: 409, body: { error: { message: "Area changed concurrently. Retry the request." } },
  });
  assert.equal(attempts.length, 3);
  assert.deepEqual(f.state(), before);
  f.commitConflicts(2);
  assert.deepEqual(await f.areaRequest("DELETE", `/${area.id}`), { status: 204, body: null });
  assert.equal(attempts.length, 6);
  assert.equal(new Set(attempts.map(attempt => attempt.client)).size, 6);
  for (const attempt of attempts) checkAttempt(attempt, taskIds, routineIds, area.id);
  const taskEvents = f.state().actions.slice(before.actions.length);
  const routineEvents = f.state().routineActions.slice(before.routineActions.length);
  assert.deepEqual(taskEvents.map(event => event.taskId), taskIds);
  assert.deepEqual(routineEvents.map(event => event.routineId), routineIds);
  assert.equal(new Set([...taskEvents, ...routineEvents].map(event => event.id)).size, taskIds.length + routineIds.length);
});

test("coordinator keeps Areas retry policy and 409 mapping, without retrying unrelated Prisma errors", async () => {
  for (const [code, expectedAttempts] of [["P2034", 3], ["P2002", 1], ["P2010", 1]] as const) {
    const area = { id: randomUUID(), name: "Area", createdAt: new Date(), updatedAt: new Date() };
    let attempts = 0;
    const tx = { async $queryRaw() { return [area]; } } as unknown as Prisma.TransactionClient;
    const error = new Prisma.PrismaClientKnownRequestError("Injected conflict", { code, clientVersion: "7.10.1" });
    const client = { async $transaction(work: (client: Prisma.TransactionClient) => Promise<void>, options: unknown) {
      attempts++; assert.deepEqual(options, { isolationLevel: "Serializable" }); return work(tx);
    } } as unknown as PrismaClient;
    const remove = createDeleteArea(createAreasRepository(() => client), async (received, locked) => {
      assert.equal(received, tx); assert.equal(locked, area); throw error;
    });
    await assert.rejects(remove(area.id), code === "P2034"
      ? (caught: unknown) => caught instanceof ApiError && caught.status === 409 && caught.message === "Area changed concurrently. Retry the request."
      : (caught: unknown) => caught === error);
    assert.equal(attempts, expectedAttempts);
  }
});
