import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RoutineAction } from "../src/generated/prisma/client";
import { fixture, input as taskInput } from "./helpers/api-fixture";

const input = {
  title: "  Massage  ", timezone: "Europe/Kyiv", startDate: "2026-10-25", estimatedDurationMinutes: 30,
  schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 2 } },
};
const children = [{ title: "  Prepare  ", estimatedDurationMinutes: 10 }, { title: "Clean up", estimatedDurationMinutes: 5 }];

test("Routine CRUD, paused listing, stable ordering, no-op patches and soft-delete history are independent of Tasks", async (t) => {
  const f = await fixture(t);
  const at = (seconds: number) => new Date(Date.parse("2026-10-25T00:00:00Z") + seconds * 1000);
  f.setTime(at(0));
  const first = await f.routineRequest("POST", "", input);
  assert.equal(first.status, 201);
  const id = first.body.id;
  assert.equal(first.body.title, "Massage");
  assert.equal(first.body.description, null);
  assert.equal(first.body.priority, "MEDIUM");
  assert.equal(first.body.areaId, null);
  assert.equal(first.body.area, null);
  assert.equal(first.body.pausedAt, null);
  assert.equal(first.body.deletedAt, null);
  assert.equal(first.body.startDate, "2026-10-25");
  assert.equal(first.body.schedule.localTime, null);
  assert.deepEqual(first.body.endCondition, { type: "NEVER" });
  assert.deepEqual(first.body.subtasks, []);
  assert.deepEqual((await f.routineRequest("GET", `/${id}`)).body, first.body);
  assert.deepEqual(f.state().routineActions[0].metadata, { before: null, after: first.body });
  const second = (await f.routineRequest("POST", "", input)).body;
  f.setTime(at(10));
  const latest = (await f.routineRequest("POST", "", input)).body;
  assert.deepEqual((await f.routineRequest("GET")).body.map((entry: { id: string }) => entry.id), [latest.id, ...[id, second.id].sort()]);
  const pause = await f.routineRequest("PATCH", `/${id}`, { paused: true });
  assert.equal(pause.body.pausedAt, at(10).toISOString());
  assert.equal((await f.routineRequest("GET")).body.length, 3);
  const beforeNoop = structuredClone(f.state());
  await f.routineRequest("PATCH", `/${id}`, { paused: true, title: " Massage ", schedule: input.schedule });
  assert.deepEqual(f.state(), beforeNoop);
  f.setTime(at(20));
  const resumed = await f.routineRequest("PATCH", `/${id}`, { paused: false, description: "Details", priority: "HIGH" });
  assert.equal(resumed.body.pausedAt, null);
  assert.equal(resumed.body.description, "Details");
  const history = (await f.routineRequest("GET", `/${id}/history`)).body;
  assert.deepEqual(history.map((action: RoutineAction) => action.type).sort(), ["CREATED", "PAUSED", "RESUMED", "UPDATED"].sort());
  assert.deepEqual(await f.routineRequest("DELETE", `/${id}`), { status: 204, body: null });
  assert.ok(f.state().routines.find((entry) => entry.id === id)!.deletedAt);
  assert.equal(f.state().routineActions.at(-1)!.type, "DELETED");
  assert.equal((await f.routineRequest("GET")).body.length, 2);
  for (const [method, path, body] of [["GET", `/${id}`, undefined], ["GET", `/${id}/history`, undefined],
    ["PATCH", `/${id}`, { title: "Restore" }], ["DELETE", `/${id}`, undefined]] as const) {
    assert.equal((await f.routineRequest(method, path, body)).status, 404);
  }
  assert.equal(f.state().tasks.length, 0);
  assert.equal(f.state().actions.length, 0);
  assert.ok(f.logs.some((line) => JSON.parse(line).path === "/api/routines"));
});

test("Routine templates preserve positions and IDs on no-op; replacements recompute duration and retain historical children", async (t) => {
  const f = await fixture(t);
  const created = await f.routineRequest("POST", "", { ...input, subtasks: children, estimatedDurationMinutes: 999 });
  assert.equal(created.status, 201);
  assert.equal(created.body.estimatedDurationMinutes, 15);
  assert.deepEqual(created.body.subtasks.map((child: { title: string; position: number }) => [child.title, child.position]), [["Prepare", 0], ["Clean up", 1]]);
  for (const child of created.body.subtasks) {
    assert.equal(child.routineId, created.body.id);
    assert.deepEqual(Object.keys(child).sort(), ["estimatedDurationMinutes", "id", "position", "routineId", "title"]);
  }
  const before = structuredClone(f.state());
  await f.routineRequest("PATCH", `/${created.body.id}`, { subtasks: children, estimatedDurationMinutes: 99 });
  assert.deepEqual(f.state(), before);
  const replacement = await f.routineRequest("PATCH", `/${created.body.id}`, { subtasks: [children[1], { title: "New", estimatedDurationMinutes: 7 }] });
  assert.equal(replacement.body.estimatedDurationMinutes, 12);
  assert.deepEqual(replacement.body.subtasks.map((child: { position: number }) => child.position), [0, 1]);
  const originalIds = new Set(created.body.subtasks.map((child: { id: string }) => child.id));
  assert.ok(replacement.body.subtasks.every((child: { id: string }) => !originalIds.has(child.id)));
  assert.deepEqual(f.state().routineActions[0].metadata, before.routineActions[0].metadata);
  const cleared = await f.routineRequest("PATCH", `/${created.body.id}`, { subtasks: [] });
  assert.equal(cleared.body.estimatedDurationMinutes, 12, "removing children retains the stored duration unless replaced");
  assert.deepEqual(cleared.body.subtasks, []);
  assert.equal((await f.routineRequest("PATCH", `/${created.body.id}`, { estimatedDurationMinutes: 40 })).body.estimatedDurationMinutes, 40);
});

test("Routine validation rejects invalid fields, overflow and ambiguous schedules before writes", async (t) => {
  const f = await fixture(t);
  const { estimatedDurationMinutes, ...noDuration } = input;
  const invalid = [noDuration, { ...input, title: " " }, { ...input, title: "x".repeat(161) }, { ...input, timezone: "+03:00" },
    { ...input, startDate: "2026-02-30" }, { ...input, startDate: "2026-10-25T00:00:00Z" }, { ...input, priority: "URGENT" },
    { ...input, status: "TODO" }, { ...input, paused: true }, { ...input, deletedAt: null }, { ...input, schedule: {} },
    { ...input, endCondition: { type: "UNTIL_DATE", date: "2026-10-24" } },
    { ...input, subtasks: [{ title: "A", estimatedDurationMinutes: 2_147_483_647 }, { title: "B", estimatedDurationMinutes: 1 }] },
    ...[0, -1, 1.5, "10", null].map((duration) => ({ ...input, estimatedDurationMinutes: duration })),
    ...["status", "cancellationNote", "plannedAt", "dueAt", "position", "id", "areaId"].map((key) => ({
      ...input, subtasks: [{ ...children[0], [key]: "invalid" }],
    })),
  ];
  for (const body of invalid) assert.equal((await f.routineRequest("POST", "", body)).status, 400, JSON.stringify(body));
  assert.equal(f.attempts(), 0);
  assert.equal(f.state().routines.length, 0);
  const maximum = await f.routineRequest("POST", "", { ...input, estimatedDurationMinutes: 2_147_483_647 });
  assert.equal(maximum.status, 201);
  assert.equal((await f.routineRequest("POST", "", { ...noDuration, subtasks: children })).status, 201);
  for (const body of [{}, { pausedAt: null }, { deletedAt: null }, { paused: null }, { title: "Edited", unknown: true }]) {
    assert.equal((await f.routineRequest("PATCH", `/${maximum.body.id}`, body)).status, 400);
  }
  for (const method of ["GET", "PATCH", "DELETE"]) {
    assert.equal((await f.routineRequest(method, "/invalid", method === "PATCH" ? { title: "Valid" } : undefined)).status, 400);
    assert.equal((await f.routineRequest(method, `/${randomUUID()}`, method === "PATCH" ? { title: "Valid" } : undefined)).status, 404);
  }
  assert.equal((await f.routineRequest("GET", "?paused=true")).status, 400);
});

test("PATCH validates merged dates and complete replacement schedule, including overflow before any write", async (t) => {
  const f = await fixture(t);
  const created = (await f.routineRequest("POST", "", { ...input, endCondition: { type: "UNTIL_DATE", date: "2026-11-01" } })).body;
  const before = structuredClone(f.state());
  for (const body of [{ startDate: "2026-11-02" }, { endCondition: { type: "UNTIL_DATE", date: "2026-10-24" } },
    { schedule: { recurrence: { type: "DAILY", intervalDays: 5 } } },
    { subtasks: [{ title: "A", estimatedDurationMinutes: 2_147_483_647 }, { title: "B", estimatedDurationMinutes: 1 }] }]) {
    const operations = f.operations.length;
    assert.equal((await f.routineRequest("PATCH", `/${created.id}`, body)).status, 400);
    assert.equal(f.operations.length, operations);
    assert.deepEqual(f.state(), before);
  }
  const changed = await f.routineRequest("PATCH", `/${created.id}`, {
    startDate: "2026-11-02", endCondition: { type: "UNTIL_DATE", date: "2026-11-02" },
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 90 }, localTime: "09:00" },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.schedule.localTime, "09:00");
  assert.equal(changed.body.estimatedDurationMinutes, 30);
  const replaced = await f.routineRequest("PATCH", `/${created.id}`, { schedule: input.schedule });
  assert.equal(replaced.body.schedule.localTime, null);
  assert.equal(replaced.body.startDate, "2026-11-02");
});

test("Areas can be assigned/cleared; snapshots survive rename; deletion atomically detaches Tasks and all Routines", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-25T00:00:00Z"));
  const area = await f.createArea("Old name");
  const task = await f.request("POST", "", { ...taskInput, areaId: area.id });
  const routines = [];
  for (let index = 0; index < 3; index++) {
    routines.push((await f.routineRequest("POST", "", { ...input, areaId: area.id, subtasks: children })).body);
  }
  await f.routineRequest("PATCH", `/${routines[1].id}`, { paused: true });
  await f.routineRequest("DELETE", `/${routines[2].id}`);
  const count = f.state().routineActions.length;
  await f.areaRequest("PATCH", `/${area.id}`, { name: "Name at deletion" });
  await f.routineRequest("PATCH", `/${routines[0].id}`, { areaId: area.id.toUpperCase() });
  assert.equal(f.state().routineActions.length, count);
  const before = structuredClone(f.state());
  f.setTime(new Date("2026-10-25T01:00:00Z"));
  f.commitConflicts(2);
  assert.equal((await f.areaRequest("DELETE", `/${area.id}`)).status, 204);
  assert.equal(f.state().tasks[0].areaId, null);
  assert.equal(f.state().actions.filter((event) => event.taskId === task.body.id && event.type === "AREA_CHANGED").length, 1);
  assert.equal(f.state().routines.length, 3);
  assert.deepEqual(f.state().routineSubtasks, before.routineSubtasks);
  assert.deepEqual(f.state().routineActions.slice(0, before.routineActions.length), before.routineActions);
  const events = f.state().routineActions.slice(before.routineActions.length);
  assert.equal(events.length, 3);
  assert.equal(new Set(events.map((event) => event.routineId)).size, 3);
  for (const routine of f.state().routines) {
    const previous = before.routines.find((entry) => entry.id === routine.id)!;
    assert.deepEqual(routine, { ...previous, areaId: null, updatedAt: new Date("2026-10-25T01:00:00Z") });
  }
  for (const event of events) {
    assert.equal(event.type, "UPDATED");
    const metadata = event.metadata as { before: { area: unknown }; after: { areaId: unknown; area: unknown } };
    assert.deepEqual(metadata.before.area, { id: area.id, name: "Name at deletion" });
    assert.equal(metadata.after.areaId, null);
    assert.equal(metadata.after.area, null);
  }
  const creation = f.state().routineActions.find((event) => event.type === "CREATED")!;
  assert.equal((creation.metadata as { after: { area: { name: string } } }).after.area.name, "Old name");
  const other = await f.createArea("Other");
  assert.equal((await f.routineRequest("PATCH", `/${routines[0].id}`, { areaId: other.id })).status, 200);
  const clear = await f.routineRequest("PATCH", `/${routines[0].id}`, { areaId: null });
  assert.equal(clear.body.area, null);
  for (const method of ["POST", "PATCH"]) {
    assert.equal((await f.routineRequest(method, method === "POST" ? "" : `/${routines[0].id}`,
      { ...(method === "POST" ? input : {}), areaId: area.id })).status, 404);
  }
});

test("journal, child and parent failures roll back Routine mutations, pause and deletion", async (t) => {
  for (const operation of ["create", "update", "pause", "resume", "delete", "children"] as const) {
    const f = await fixture(t);
    const routine = (await f.routineRequest("POST", "", { ...input, subtasks: children })).body;
    if (operation === "resume") await f.routineRequest("PATCH", `/${routine.id}`, { paused: true });
    const before = structuredClone(f.state());
    if (operation === "children") f.failRoutineChildren(1);
    else f.failEvents();
    const result = operation === "create" ? await f.routineRequest("POST", "", { ...input, subtasks: children })
      : operation === "delete" ? await f.routineRequest("DELETE", `/${routine.id}`)
      : await f.routineRequest("PATCH", `/${routine.id}`, operation === "pause" ? { paused: true }
        : operation === "resume" ? { paused: false } : { title: "Changed", subtasks: [...children].reverse() });
    assert.equal(result.status, 500, operation);
    assert.deepEqual(f.state(), before, operation);
  }
  const f = await fixture(t);
  const routine = (await f.routineRequest("POST", "", input)).body;
  const before = structuredClone(f.state());
  f.failEvents(1);
  assert.equal((await f.routineRequest("PATCH", `/${routine.id}`, { title: "Changed", paused: true })).status, 500);
  assert.deepEqual(f.state(), before);
});

test("Area deletion rolls back Tasks and Routines together on a later Routine journal/write failure", async (t) => {
  for (const failure of ["event", "routine", "area"] as const) {
    const f = await fixture(t);
    const area = await f.createArea();
    await f.request("POST", "", { ...taskInput, areaId: area.id });
    for (let index = 0; index < 2; index++) await f.routineRequest("POST", "", { ...input, areaId: area.id });
    const before = structuredClone(f.state());
    if (failure === "event") f.failEvents(2); // Task event and first Routine event succeed.
    else if (failure === "routine") f.failRoutineWrites(1);
    else f.failAreaDelete();
    assert.equal((await f.areaRequest("DELETE", `/${area.id}`)).status, 500);
    assert.deepEqual(f.state(), before);
  }
});

test("Routine transactions retry without duplicates and recheck Area after a simulated concurrent deletion", async (t) => {
  const f = await fixture(t);
  f.commitConflicts(2);
  const routine = (await f.routineRequest("POST", "", { ...input, subtasks: children })).body;
  assert.equal(f.state().routines.length, 1);
  assert.equal(f.state().routineActions.length, 1);
  assert.equal(f.state().routineSubtasks.length, 2);
  f.commitConflicts(2);
  assert.equal((await f.routineRequest("PATCH", `/${routine.id}`, { title: "Changed", paused: true })).status, 200);
  assert.deepEqual(f.state().routineActions.map((event) => event.type), ["CREATED", "UPDATED", "PAUSED"]);
  const before = structuredClone(f.state());
  f.conflicts(3);
  assert.equal((await f.routineRequest("DELETE", `/${routine.id}`)).status, 409);
  assert.deepEqual(f.state(), before);
  const area = await f.createArea();
  f.deleteOnAssignmentConflict(area.id, "P2010");
  assert.equal((await f.routineRequest("PATCH", `/${routine.id}`, { areaId: area.id })).status, 404);
  assert.equal(f.state().routineActions.length, 3);
});

test("corrupt stored JSON is not returned as a valid Routine DTO", async (t) => {
  const f = await fixture(t);
  const routine = (await f.routineRequest("POST", "", input)).body;
  f.state().routines[0].schedule = { version: 99, recurrence: { type: "DAILY", intervalDays: 1 } };
  assert.equal((await f.routineRequest("GET", `/${routine.id}`)).status, 500);
  assert.equal((await f.routineRequest("GET")).status, 500);
  assert.equal((await f.routineRequest("PATCH", `/${routine.id}`, { paused: true })).status, 500);
});

test("Routine history validates recorded JSON without replacing historical Area names", async (t) => {
  const f = await fixture(t);
  const routine = (await f.routineRequest("POST", "", input)).body;
  f.state().routineActions[0].metadata = { before: null, after: { id: routine.id, schedule: { version: 99 } } };
  const result = await f.routineRequest("GET", `/${routine.id}/history`);
  assert.deepEqual(result, { status: 500, body: { error: { message: "Internal server error." } } });
});

test("calendar and completion schedules plus all end conditions round-trip through HTTP and persisted JSON", async (t) => {
  const f = await fixture(t);
  const recurrences = [
    { type: "DAILY", intervalDays: 2 },
    { type: "WEEKLY", intervalWeeks: 2, selection: { type: "DAYS", weekdays: [1, 4] } },
    { type: "WEEKLY", intervalWeeks: 1, selection: { type: "WINDOW", startWeekday: 6, endWeekday: 7 } },
    { type: "MONTHLY", intervalMonths: 1, selection: { type: "DAY", day: 31, shortMonthPolicy: "CLAMP" } },
    { type: "MONTHLY", intervalMonths: 1, selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } },
    { type: "MONTHLY", intervalMonths: 1, selection: { type: "LAST_DAY" } },
    { type: "AFTER_COMPLETION", intervalDays: 90 },
  ];
  for (const recurrence of recurrences) {
    for (const endCondition of [{ type: "NEVER" }, { type: "COUNT", count: 8 }, { type: "UNTIL_DATE", date: "2026-11-07" }]) {
      const result = await f.routineRequest("POST", "", { ...input, schedule: { version: 1, recurrence }, endCondition });
      assert.equal(result.status, 201);
      assert.deepEqual(result.body.schedule, { version: 1, recurrence, localTime: null });
      assert.deepEqual(result.body.endCondition, endCondition);
      assert.deepEqual((await f.routineRequest("GET", `/${result.body.id}`)).body, result.body);
      assert.equal((await f.routineRequest("GET", `/${result.body.id}/history`)).status, 200);
    }
  }
  assert.equal(f.state().tasks.length, 0);
});
