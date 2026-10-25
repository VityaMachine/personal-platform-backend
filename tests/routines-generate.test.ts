import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture, input as taskInput } from "./helpers/api-fixture";

const massage = { title: "Масаж", estimatedDurationMinutes: 30, timezone: "Europe/Kyiv", startDate: "2026-10-25",
  schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 2 }, localTime: "18:00" },
  endCondition: { type: "UNTIL_DATE", date: "2026-11-07" } };
const range = { from: "2026-10-25", to: "2026-11-07" };
type Pair = { occurrenceKey: string; taskId: string };

test("massage generates seven Tasks with stable occurrence keys, null personal dates and actual creation summary", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-12-01T10:00:00Z"));
  const r = (await f.routineRequest("POST", "", massage)).body;
  const before = structuredClone(f.state());
  const preview = (await f.routineRequest("GET", `/${r.id}/preview?from=${range.from}&to=${range.to}`)).body;
  assert.deepEqual(f.state(), before);
  const generated = await f.routineRequest("POST", `/${r.id}/generate`, range);
  assert.equal(generated.status, 200);
  assert.deepEqual(Object.keys(generated.body).sort(), ["routineId", "from", "to", "createdCount", "existingCount", "created", "existing"].sort());
  assert.equal(generated.body.createdCount, 7);
  assert.equal(generated.body.existingCount, 0);
  assert.deepEqual(generated.body.created.map((entry: Pair) => entry.occurrenceKey), preview.occurrences.map((entry: Pair) => entry.occurrenceKey));
  assert.deepEqual(f.state().occurrences.map((entry) => entry.startDate),
    ["2026-10-25", "2026-10-27", "2026-10-29", "2026-10-31", "2026-11-02", "2026-11-04", "2026-11-06"]);
  const reads = { ...f.reads };
  const tasks = (await f.request("GET")).body;
  assert.equal(f.reads.tasks - reads.tasks, 1);
  assert.equal(f.reads.history - reads.history, 1);
  assert.equal(tasks.length, 7);
  for (const task of tasks) {
    assert.equal(task.status, "TODO"); assert.equal(task.isCompleted, false);
    assert.equal(task.plannedAt, null); assert.equal(task.dueAt, null);
    assert.equal(task.estimatedDurationMinutes, 30);
    assert.equal(task.summary.ageSeconds, 0); assert.equal(task.summary.historyIncomplete, false);
    assert.equal(task.createdAt, "2026-12-01T10:00:00.000Z");
    assert.equal(task.routineOccurrence.routineId, r.id);
    assert.equal(task.routineOccurrence.timezone, "Europe/Kyiv");
    assert.equal(task.routineOccurrence.localTime, "18:00");
    assert.equal(Object.keys(task.routineOccurrence).length, 11);
    assert.equal(task.routineOccurrence.occurrenceNumber, null);
    assert.equal(task.routineOccurrence.previousOccurrenceId, null);
    assert.equal(task.routineOccurrence.basisCompletedAt, null);
    assert.equal("snapshot" in task.routineOccurrence, false);
    assert.equal("routineOccurrenceId" in task, false);
    assert.deepEqual(f.state().occurrences.find((entry) => entry.id === task.routineOccurrence.id)!.snapshot, r);
  }
  const action = f.state().actions[0].metadata as { origin: unknown; routineOccurrence: { snapshot: unknown } };
  assert.deepEqual(action.origin, { type: "ROUTINE", routineId: r.id });
  assert.deepEqual(action.routineOccurrence.snapshot, r);
});

test("monthly window intersects inside query once and retains full dates; overlapping requests are idempotent", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", { ...massage, title: "Передати показники", startDate: "2026-11-01",
    endCondition: { type: "NEVER" }, schedule: { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1,
      selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } } } })).body;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-11-20", to: "2026-11-21" })).body;
  assert.equal(first.createdCount, 1);
  assert.equal(f.state().occurrences[0].startDate, "2026-11-15");
  assert.equal(f.state().occurrences[0].endDate, "2026-11-23");
  assert.equal(f.state().occurrences[0].instant, null);
  const repeated = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-11-01", to: "2026-12-31" })).body;
  assert.equal(repeated.createdCount, 1); assert.equal(repeated.existingCount, 1);
  assert.deepEqual(repeated.existing, first.created);
  const before = structuredClone(f.state());
  const again = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-11-16", to: "2026-12-20" })).body;
  assert.equal(again.createdCount, 0); assert.equal(again.existingCount, 2);
  assert.deepEqual(f.state(), before);
});

test("DONE and soft-deleted generated Tasks retain occurrences and are never replaced or restored", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", massage)).body;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, range)).body;
  const [done, deleted] = first.created;
  await f.request("PATCH", `/${done.taskId}`, { status: "DONE" });
  await f.request("DELETE", `/${deleted.taskId}`);
  const before = structuredClone(f.state());
  const repeated = (await f.routineRequest("POST", `/${r.id}/generate`, range)).body;
  assert.equal(repeated.createdCount, 0); assert.equal(repeated.existingCount, 7);
  assert.deepEqual(repeated.existing, first.created);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.request("GET", `/${deleted.taskId}`)).status, 404);
  assert.equal((await f.request("GET", `/${done.taskId}`)).body.isCompleted, true);
});

test("templates, Area, priority and summed duration are copied independently and Area deletion preserves snapshots", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-24T10:00:00Z"));
  const area = await f.createArea("Wellbeing");
  const r = (await f.routineRequest("POST", "", { ...massage, areaId: area.id, description: "Details", priority: "HIGH",
    subtasks: [{ title: "Prepare", estimatedDurationMinutes: 3 }, { title: "Finish", estimatedDurationMinutes: 7 }] })).body;
  const one = { from: "2026-10-25", to: "2026-10-25" };
  const generated = (await f.routineRequest("POST", `/${r.id}/generate`, one)).body;
  const id = generated.created[0].taskId;
  const task = (await f.request("GET", `/${id}`)).body;
  assert.equal(task.estimatedDurationMinutes, 10); assert.equal(task.priority, "HIGH");
  assert.equal(task.description, "Details"); assert.deepEqual(task.area, { id: area.id, name: area.name });
  assert.deepEqual(task.subtasks.map((child: { status: string; estimatedDurationMinutes: number }) => [child.status, child.estimatedDurationMinutes])
    .sort((a: [string, number], b: [string, number]) => a[1] - b[1]), [["TODO", 3], ["TODO", 7]]);
  assert.ok(task.subtasks.every((child: { id: string }) => !r.subtasks.some((template: { id: string }) => child.id === template.id)));
  assert.deepEqual(f.state().actions.map((entry) => entry.type), ["CREATED", "SUBTASK_CREATED", "SUBTASK_CREATED"]);
  const operations = f.operations;
  assert.ok(operations.indexOf(`area-lock:${area.id}`) < operations.indexOf(`routine-lock:${r.id}`));
  await f.request("PATCH", `/${id}`, { title: "Personal title" });
  await f.request("PATCH", `/${id}/subtasks/${task.subtasks[0].id}`, { title: "Personal preparation" });
  f.setTime(new Date("2026-10-26T10:00:00Z"));
  await f.routineRequest("PATCH", `/${r.id}`, { title: "New template", subtasks: [{ title: "New child", estimatedDurationMinutes: 20 }] });
  const still = (await f.request("GET", `/${id}`)).body;
  assert.equal(still.title, "Personal title"); assert.equal(still.estimatedDurationMinutes, 10);
  assert.ok(still.subtasks.some((child: { title: string }) => child.title === "Personal preparation"));
  assert.equal((await f.routineRequest("GET", `/${r.id}`)).body.title, "New template");
  const next = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-27", to: "2026-10-27" })).body;
  assert.equal((await f.request("GET", `/${next.created[0].taskId}`)).body.estimatedDurationMinutes, 20);
  const snapshots = structuredClone(f.state().occurrences);
  assert.equal((await f.areaRequest("DELETE", `/${area.id}`)).status, 204);
  assert.deepEqual(f.state().occurrences, snapshots);
  assert.equal((await f.request("GET", `/${id}`)).body.area, null);
});

test("generation rolls back the entire batch on occurrence, Task, child or later journal failure", async (t) => {
  for (const failure of ["occurrence", "task", "child", "event"] as const) {
    const f = await fixture(t);
    const r = (await f.routineRequest("POST", "", { ...massage,
      subtasks: [{ title: "Preparation", estimatedDurationMinutes: 5 }] })).body;
    const before = structuredClone(f.state());
    if (failure === "occurrence") f.failOccurrences(2);
    if (failure === "task") f.failTaskWrites(2);
    if (failure === "child") f.failSubtasks(2);
    if (failure === "event") f.failEvents(5);
    const response = await f.routineRequest("POST", `/${r.id}/generate`, range);
    assert.equal(response.status, 500, failure);
    assert.deepEqual(f.state(), before, failure);
  }
});

test("serialization retries, unique-conflict retries, concurrent requests and post-commit network repeats are idempotent", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", massage)).body;
  f.commitConflicts(2);
  const first = await f.routineRequest("POST", `/${r.id}/generate`, range);
  assert.equal(first.status, 200); assert.equal(f.state().occurrences.length, 7);
  assert.equal(f.state().actions.length, 7);
  const repeated = await f.routineRequest("POST", `/${r.id}/generate`, range);
  assert.deepEqual(repeated.body.existing, first.body.created);
  const another = (await f.routineRequest("POST", "", massage)).body;
  f.occurrenceConflicts(2);
  assert.equal((await f.routineRequest("POST", `/${another.id}/generate`, range)).status, 200);
  const concurrent = (await f.routineRequest("POST", "", massage)).body;
  const responses = await Promise.all([1, 2].map(() => f.routineRequest("POST", `/${concurrent.id}/generate`, range)));
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual(responses.map((response) => response.body.createdCount).sort((a, b) => a - b), [0, 7]);
  assert.equal(f.state().occurrences.filter((entry) => entry.routineId === concurrent.id).length, 7);
  const before = structuredClone(f.state());
  f.occurrenceConflicts(3);
  const fresh = (await f.routineRequest("POST", "", massage)).body;
  const error = await f.routineRequest("POST", `/${fresh.id}/generate`, range);
  assert.equal(error.status, 409);
  assert.equal(JSON.stringify(error.body).includes("P2002"), false);
  assert.equal(f.state().occurrences.length, before.occurrences.length);
});

test("generate validates exact body/UUID and rejects paused/deleted/completion Routines without writes", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", massage)).body;
  const before = structuredClone(f.state());
  for (const body of [undefined, {}, { from: range.from }, { ...range, limit: 100 },
    { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-11-01", to: "2026-10-25" },
    { from: "2026-01-01", to: "2027-01-02" }, { ...range, completedAt: "2026-10-25T10:00:00Z" }]) {
    assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, body)).status, 400);
  }
  assert.deepEqual(f.state(), before);
  assert.equal((await f.routineRequest("POST", "/invalid/generate", range)).status, 400);
  assert.equal((await f.routineRequest("POST", `/${randomUUID()}/generate`, range)).status, 404);
  await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
  const paused = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, range)).status, 409);
  assert.deepEqual(f.state(), paused);
  await f.routineRequest("DELETE", `/${r.id}`);
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, range)).status, 404);
});

test("DST and incomplete/budgeted histories reject atomically; all-day instant=null is valid", async (t) => {
  for (const mode of ["dst", "count", "periodBudget", "historyBudget", "missing", "gap", "corrupt"] as const) {
    const f = await fixture(t);
    f.setTime(new Date("2026-01-01T10:00:00Z"));
    const r = (await f.routineRequest("POST", "", { ...massage,
      startDate: mode === "periodBudget" ? "0001-01-01" : "2026-01-01",
      schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 1 }, localTime: mode === "dst" ? "03:30" : null },
      endCondition: mode === "periodBudget" || mode === "count"
        ? { type: "COUNT", count: mode === "periodBudget" ? 2_147_483_647 : 5 } : { type: "NEVER" },
    })).body;
    if (!r.id) throw new Error(`Invalid fixture for ${mode}`);
    if (mode === "count") {
      f.setTime(new Date("2026-01-02T10:00:00Z"));
      await f.routineRequest("PATCH", `/${r.id}`, { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 2 } } });
    }
    if (mode === "missing") f.state().routineActions = [];
    if (mode === "corrupt") f.state().routineActions[0].metadata = {};
    if (mode === "historyBudget") f.state().routineActions = Array.from({ length: 10001 }, () => f.state().routineActions[0]);
    if (mode === "gap") {
      f.setTime(new Date("2026-01-02T10:00:00Z"));
      await f.routineRequest("PATCH", `/${r.id}`, { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 3 } } });
      f.setTime(new Date("2026-01-03T10:00:00Z"));
      await f.routineRequest("PATCH", `/${r.id}`, { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 4 } } });
      f.state().routineActions.splice(1, 1);
    }
    const before = structuredClone(f.state());
    const result = await f.routineRequest("POST", `/${r.id}/generate`, mode === "periodBudget"
      ? { from: "9999-12-31", to: "9999-12-31" } : { from: "2026-10-25", to: "2026-10-25" });
    assert.equal(result.status, 409, mode);
    assert.deepEqual(f.state(), before, mode);
  }
});

test("COUNT and pauses reuse preview, with count from origin and pause-excluded occurrences", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-24T10:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...massage, endCondition: { type: "COUNT", count: 4 } })).body;
  f.setTime(new Date("2026-10-27T10:00:00Z"));
  await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
  f.setTime(new Date("2026-10-30T10:00:00Z"));
  await f.routineRequest("PATCH", `/${r.id}`, { paused: false });
  const result = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-29", to: "2026-11-10" });
  assert.equal(result.status, 200);
  assert.equal(result.body.createdCount, 3);
  assert.deepEqual(f.state().occurrences.map((entry) => entry.startDate), ["2026-10-31", "2026-11-02", "2026-11-04"]);
});

test("100 NEW task limit rejects before writes, but permits a large range with enough existing tasks", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", { ...massage, startDate: "2026-01-01", endCondition: { type: "NEVER" },
    schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 1 } } })).body;
  const before = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-01-01", to: "2026-04-11" })).status, 409);
  assert.deepEqual(f.state(), before);
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-01-01", to: "2026-04-10" })).body;
  assert.equal(first.createdCount, 100);
  const next = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-01-01", to: "2026-07-19" })).body;
  assert.equal(next.createdCount, 100); assert.equal(next.existingCount, 100);
  const repeat = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-01-01", to: "2026-07-19" })).body;
  assert.equal(repeat.createdCount, 0); assert.equal(repeat.existingCount, 200);
});

test("calendar edits before generation are effective only for later starts; edits after generation are explicit conflicts", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-24T10:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...massage, endCondition: { type: "NEVER" } })).body;
  f.setTime(new Date("2026-10-28T10:00:00Z"));
  await f.routineRequest("PATCH", `/${r.id}`, { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 3 } } });
  const before = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, range)).status, 409);
  assert.deepEqual(f.state(), before);
  const generated = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-29", to: "2026-11-03" });
  assert.equal(generated.status, 200); assert.equal(generated.body.createdCount, 2);
  const frozen = structuredClone(f.state());
  for (const patch of [{ schedule: massage.schedule }, { timezone: "UTC" }, { startDate: "2026-10-26" }, { endCondition: { type: "COUNT", count: 10 } }]) {
    assert.equal((await f.routineRequest("PATCH", `/${r.id}`, patch)).status, 409);
    assert.deepEqual(f.state(), frozen);
  }
  assert.equal((await f.routineRequest("PATCH", `/${r.id}`, { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 3 } } })).status, 200);
  assert.equal((await f.request("POST", "", { title: "Ordinary", estimatedDurationMinutes: 10 })).status, 400);
  const ordinary = await f.request("POST", "", taskInput);
  assert.equal(ordinary.status, 201); assert.equal(ordinary.body.routineOccurrence, null);
});
