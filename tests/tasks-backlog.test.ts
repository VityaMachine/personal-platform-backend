import assert from "node:assert/strict";
import { test } from "node:test";
import { isTaskBacklog, type TaskBacklogInput } from "../src/modules/tasks/domain/tasks.backlog";
import { isTaskToday, DEFAULT_TODAY_CONTEXT } from "../src/modules/tasks/domain/tasks.today";
import { fixture } from "./helpers/api-fixture";

const now = new Date("2026-10-25T12:00:00Z");
const task = (patch: Partial<TaskBacklogInput> = {}): TaskBacklogInput => ({
  status: "TODO", archivedAt: null, deletedAt: null, plannedAt: null, dueAt: null, routineOccurrence: null, ...patch,
});
const occurrence = { startDate: "2026-10-15", endDate: "2026-10-23", timezone: "Europe/Kyiv" };

test("backlog accepts only TODO/PAUSED/POSTPONED and excludes archived/deleted tasks", () => {
  for (const status of ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"] as const) {
    for (const routineOccurrence of [null, occurrence]) {
      const value = task({ status, routineOccurrence });
      assert.equal(isTaskBacklog(value, now), ["TODO", "PAUSED", "POSTPONED"].includes(status), status);
      assert.equal(isTaskBacklog({ ...value, archivedAt: now }, now), false);
      assert.equal(isTaskBacklog({ ...value, deletedAt: now }, now), false);
    }
  }
});

test("both personal dates must be absent or <= the UTC instant, including exact equality and offsets", () => {
  for (const routineOccurrence of [null, occurrence]) {
    for (const plannedAt of [null, new Date(now.getTime() - 1), now, new Date(now.getTime() + 1)]) {
      for (const dueAt of [null, new Date(now.getTime() - 1), now, new Date(now.getTime() + 1)]) {
        assert.equal(isTaskBacklog(task({ plannedAt, dueAt, routineOccurrence }), now),
          (plannedAt === null || plannedAt <= now) && (dueAt === null || dueAt <= now));
      }
    }
  }
  assert.equal(isTaskBacklog(task({ plannedAt: new Date("2026-10-25T14:00:00+02:00"), dueAt: now }), now), true);
  assert.equal(isTaskBacklog(task({ plannedAt: new Date("2026-10-25T14:00:00.001+02:00"), dueAt: now }), now), false);
});

test("future/active windows exclude even past personal dates; the final local day is inclusive", () => {
  for (const [asOf, expected] of [
    ["2026-10-14T12:00:00Z", false], ["2026-10-15T12:00:00Z", false],
    ["2026-10-20T12:00:00Z", false], ["2026-10-23T20:59:59.999Z", false],
    ["2026-10-23T21:00:00Z", true],
  ] as const) {
    assert.equal(isTaskBacklog(task({ routineOccurrence: occurrence, plannedAt: new Date("2026-01-01"), dueAt: new Date("2026-01-01") }), new Date(asOf)), expected, asOf);
  }
  assert.equal(isTaskBacklog(task({ routineOccurrence: occurrence, plannedAt: new Date("2026-10-26") }), now), false);
});

test("occurrence timezone governs midnight and DST spring/fall days, independent of server timezone", () => {
  for (const [day, lastInstant, nextDay] of [
    ["2026-03-29", "2026-03-29T20:59:59.999Z", "2026-03-29T21:00:00Z"],
    ["2026-10-25", "2026-10-25T21:59:59.999Z", "2026-10-25T22:00:00Z"],
  ]) {
    const value = task({ routineOccurrence: { startDate: day, endDate: day, timezone: "Europe/Kyiv" } });
    assert.equal(isTaskBacklog(value, new Date(lastInstant)), false);
    assert.equal(isTaskBacklog(value, new Date(nextDay)), true);
    assert.equal(isTaskBacklog({ ...value, routineOccurrence: { ...value.routineOccurrence!, timezone: "UTC" } }, new Date(nextDay)), false);
  }
});

test("backlog can overlap Today and does not depend on overdue preferences", () => {
  for (const value of [task({ dueAt: now }), task({ routineOccurrence: occurrence })]) {
    for (const overdueMode of ["none", "limited", "all"] as const) {
      for (const overdueDays of [1, 3, 365]) {
        const today = isTaskToday({ ...value, completedAt: null }, { ...DEFAULT_TODAY_CONTEXT, overdueMode, overdueDays }, now);
        assert.equal(isTaskBacklog(value, now), true);
        if (overdueMode === "all" || value.dueAt !== null) assert.equal(today, true);
      }
    }
  }
});

test("POST/PATCH/detail/list share full DTOs, one response clock and unchanged summary", async (t) => {
  const f = await fixture(t); f.setTime(now); f.commitConflicts(2);
  let clock = f.taskClockCalls();
  const created = await f.request("POST", "", { title: "Backlog", dueAt: now.toISOString(), estimatedDurationMinutes: 10 });
  assert.equal(created.status, 201); assert.equal(f.taskClockCalls() - clock, 1);
  const id = created.body.id;
  assert.equal(created.body.isBacklog, true); assert.equal(created.body.isToday, true);
  assert.equal(created.body.completedAt, null); assert.equal(created.body.isCompleted, false);
  assert.equal("isBacklog" in f.state().tasks[0], false);
  for (const path of [`/${id}`, "", "?view=backlog", "?view=today"]) {
    clock = f.taskClockCalls();
    const result = await f.request("GET", path);
    assert.deepEqual(Array.isArray(result.body) ? result.body[0] : result.body, created.body);
    assert.equal(f.taskClockCalls() - clock, 1);
  }
  const changed = await f.request("PATCH", `/${id}`, { title: "Renamed" });
  assert.equal(changed.body.isBacklog, true); assert.deepEqual(changed.body.summary, created.body.summary);
  assert.deepEqual((await f.request("GET", `/${id}`)).body, changed.body);
  const future = await f.request("PATCH", `/${id}`, { plannedAt: "2026-10-26T00:00:00Z" });
  assert.equal(future.body.isBacklog, false); assert.equal(future.body.isToday, true);
  assert.deepEqual((await f.request("GET", "?view=backlog")).body, []);
  assert.deepEqual(future.body.summary, created.body.summary);
  f.setTime(new Date("2026-10-25T12:01:00Z"));
  const done = (await f.request("PATCH", `/${id}`, { status: "DONE" })).body;
  assert.equal(done.isBacklog, false); assert.equal(done.isToday, true); assert.equal(done.isCompleted, true);
  assert.equal(done.completedAt, "2026-10-25T12:01:00.000Z"); assert.equal(done.summary.historyIncomplete, false);
  assert.deepEqual((await f.request("GET", `/${id}`)).body, done);
  assert.deepEqual((await f.request("GET")).body, [done]);
});

test("view=backlog preserves ordered arrays without writes or extra history/Routine queries", async (t) => {
  const f = await fixture(t); f.setTime(now);
  for (const dueAt of ["2026-10-20T12:00:00Z", "2026-10-25T12:00:00Z", "2026-10-26T12:00:00Z"]) {
    await f.request("POST", "", { title: dueAt, dueAt, estimatedDurationMinutes: 10 });
  }
  const all = (await f.request("GET")).body;
  const before = structuredClone(f.state()), reads = { ...f.reads }, operations = f.operations.length;
  const clock = f.taskClockCalls();
  const result = await f.request("GET", "?view=backlog");
  assert.equal(result.status, 200); assert.ok(Array.isArray(result.body));
  assert.equal(result.body.length, 2);
  assert.deepEqual(result.body, all.filter((entry: { isBacklog: boolean }) => entry.isBacklog));
  assert.equal(f.taskClockCalls() - clock, 1);
  assert.equal(f.reads.tasks - reads.tasks, 1); assert.equal(f.reads.history - reads.history, 1);
  assert.equal(f.reads.routines, reads.routines); assert.equal(f.reads.routineHistory, reads.routineHistory);
  assert.equal(f.reads.occurrences, reads.occurrences); assert.equal(f.operations.length, operations);
  assert.deepEqual(f.state(), before);
  for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    for (const overdueMode of ["none", "limited", "all"]) {
      for (const overdueDays of [1, 365]) {
        const entries = (await f.request("GET", `?view=backlog&timezone=${timezone}&overdueMode=${overdueMode}&overdueDays=${overdueDays}`)).body;
        assert.deepEqual(entries.map((entry: { id: string }) => entry.id), result.body.map((entry: { id: string }) => entry.id));
      }
    }
  }
  const id = result.body[0].id;
  assert.equal((await f.request("PATCH", `/${id}`, { archived: true })).body.isBacklog, false);
  assert.equal((await f.request("GET", "?archived=true")).body[0].isBacklog, false);
  await f.request("DELETE", `/${result.body[1].id}`);
  assert.deepEqual((await f.request("GET", "?view=backlog")).body, []);
});

test("backlog query rejects archive conflicts, unknown/duplicate views and computed inputs", async (t) => {
  const f = await fixture(t); f.setTime(now);
  const body = { title: "Validation", dueAt: now.toISOString(), estimatedDurationMinutes: 10 };
  const id = (await f.request("POST", "", body)).body.id;
  const before = structuredClone(f.state()), attempts = f.attempts();
  for (const query of ["?archived=true&view=backlog", "?archived=true&view=today", "?view=unknown", "?view=", "?view=backlog&view=today", "?view=backlog&view=backlog"]) {
    assert.equal((await f.request("GET", query)).status, 400, query);
  }
  assert.equal((await f.request("GET", `/${id}?view=backlog`)).status, 400);
  assert.equal((await f.request("POST", "?view=backlog", body)).status, 400);
  assert.equal((await f.request("PATCH", `/${id}?view=backlog`, { title: "Invalid" })).status, 400);
  assert.equal((await f.request("POST", "", { ...body, isBacklog: true })).status, 400);
  assert.equal((await f.request("PATCH", `/${id}`, { isBacklog: true })).status, 400);
  assert.equal(f.attempts(), attempts); assert.deepEqual(f.state(), before);
  assert.equal((await f.request("GET", "?archived=false&view=backlog")).status, 200);
});

test("saved Routine windows ignore localTime/instant and survive template pause/delete", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
  const routine = (await f.routineRequest("POST", "", {
    title: "Window", estimatedDurationMinutes: 10, timezone: "Europe/Kyiv", startDate: "2026-10-01",
    schedule: { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1,
      selection: { type: "WINDOW", startDay: 15, endDay: 25, shortMonthPolicy: "SKIP" } }, localTime: "09:00" },
  })).body;
  const generated = await f.routineRequest("POST", `/${routine.id}/generate`, { from: "2026-10-20", to: "2026-10-20" });
  assert.equal(generated.status, 200);
  const id = generated.body.created[0].taskId;
  const original = (await f.request("GET", `/${id}`)).body;
  assert.equal(original.isBacklog, false);
  assert.equal(original.routineOccurrence.localTime, "09:00");
  assert.ok(original.routineOccurrence.instant);
  for (const [asOf, expected] of [["2026-10-14T12:00:00Z", false], ["2026-10-25T21:59:59.999Z", false], ["2026-10-25T22:00:00Z", true]] as const) {
    f.setTime(new Date(asOf));
    assert.equal((await f.request("GET", `/${id}?timezone=America%2FLos_Angeles&overdueMode=none`)).body.isBacklog, expected);
  }
  for (const action of ["pause", "delete"]) {
    if (action === "pause") await f.routineRequest("PATCH", `/${routine.id}`, { paused: true });
    else await f.routineRequest("DELETE", `/${routine.id}`);
    const before = structuredClone(f.state()), reads = { ...f.reads };
    const result = (await f.request("GET", "?view=backlog&timezone=America%2FLos_Angeles&overdueMode=none")).body;
    assert.equal(result[0].id, id); assert.equal(result[0].isBacklog, true);
    assert.deepEqual(result[0].routineOccurrence, original.routineOccurrence);
    assert.equal(f.reads.routines, reads.routines); assert.equal(f.reads.routineHistory, reads.routineHistory);
    assert.deepEqual(f.state(), before);
  }
  const future = (await f.request("PATCH", `/${id}`, { plannedAt: "2026-10-26T09:00:00+02:00" })).body;
  assert.equal(future.isBacklog, false); assert.deepEqual(future.routineOccurrence, original.routineOccurrence);
  assert.deepEqual((await f.request("GET", "?view=backlog")).body, []);
});

test("automatic parent status changes from subtasks are reflected in subsequent full Task GET", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-24T12:00:00Z"));
  const parent = (await f.request("POST", "", {
    title: "Parent", dueAt: "2026-10-24T12:00:00Z", subtasks: [{ title: "Child", estimatedDurationMinutes: 10 }],
  })).body;
  const child = parent.subtasks[0].id;
  assert.equal(parent.isBacklog, true);
  for (const [status, isBacklog] of [["IN_PROGRESS", false], ["DONE", false], ["TODO", true]] as const) {
    f.setTime(new Date(f.state().tasks[0].updatedAt.getTime() + 60000));
    assert.equal((await f.request("PATCH", `/${parent.id}/subtasks/${child}`, { status })).status, 200);
    const detail = (await f.request("GET", `/${parent.id}`)).body;
    assert.equal(detail.status, status); assert.equal(detail.isBacklog, isBacklog);
    assert.equal(detail.isCompleted, status === "DONE"); assert.equal(detail.isToday, true);
    assert.equal(detail.summary.historyIncomplete, false);
    assert.equal(detail.completedAt, status === "DONE" ? f.state().tasks[0].updatedAt.toISOString() : null);
    assert.deepEqual((await f.request("GET")).body, [detail]);
  }
});
