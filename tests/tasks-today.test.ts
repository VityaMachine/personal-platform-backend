import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TODAY_CONTEXT, isTaskToday, type TaskTodayContext, type TaskTodayInput } from "../src/modules/tasks/tasks.today";
import { fixture } from "./helpers/api-fixture";

const now = new Date("2026-10-25T12:00:00Z");
const task = (patch: Partial<TaskTodayInput> = {}): TaskTodayInput => ({
  status: "TODO", archivedAt: null, deletedAt: null, plannedAt: null, dueAt: null, routineOccurrence: null, completedAt: null, ...patch,
});
const context = (patch: Partial<TaskTodayContext> = {}): TaskTodayContext => ({ ...DEFAULT_TODAY_CONTEXT, ...patch });
const date = (day: string) => new Date(`${day}T12:00:00Z`);

test("ordinary date selection: none/limited/all, N and N+1, future/null and plannedAt OR dueAt", () => {
  for (const [day, expected] of [
    ["2026-10-21", [false, false, true]], ["2026-10-22", [false, true, true]],
    ["2026-10-25", [true, true, true]], ["2026-10-26", [false, false, false]],
  ] as const) {
    for (const [index, overdueMode] of (["none", "limited", "all"] as const).entries()) {
      for (const field of ["plannedAt", "dueAt"] as const) {
        assert.equal(isTaskToday(task({ [field]: date(day) }), context({ overdueMode }), now), expected[index], `${day} ${field} ${overdueMode}`);
      }
    }
  }
  assert.equal(isTaskToday(task(), context(), now), false);
  assert.equal(isTaskToday(task({ plannedAt: date("2026-10-26"), dueAt: date("2026-10-25") }), context({ overdueMode: "none" }), now), true);
  assert.equal(isTaskToday(task({ plannedAt: date("2026-10-25"), dueAt: date("2026-10-26") }), context({ overdueMode: "none" }), now), true);
  assert.equal(isTaskToday(task({ plannedAt: new Date("2026-10-25T23:59:00Z") }), context({ overdueMode: "none" }), now), true, "later hours of today still belong to the calendar day");
});

test("all six statuses and archive/delete exclusions apply to ordinary tasks and occurrences", () => {
  for (const status of ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"] as const) {
    for (const routineOccurrence of [null, { startDate: "2026-10-25", endDate: "2026-10-25", timezone: "UTC" }]) {
      const value = task({ status, dueAt: date("2026-10-25"), routineOccurrence });
      assert.equal(isTaskToday(value, context(), now), status !== "DONE" && status !== "CANCELED");
      assert.equal(isTaskToday({ ...value, archivedAt: now }, context(), now), false);
      assert.equal(isTaskToday({ ...value, deletedAt: now }, context(), now), false);
    }
  }
});

test("Routine window 15–23 is inclusive; future and overdue windows use their own calendar dates", () => {
  const value = task({ routineOccurrence: { startDate: "2026-10-15", endDate: "2026-10-23", timezone: "Europe/Kyiv" } });
  for (const day of ["2026-10-15", "2026-10-20", "2026-10-23"]) {
    assert.equal(isTaskToday(value, context({ overdueMode: "none" }), date(day)), true);
  }
  assert.equal(isTaskToday(value, context({ overdueMode: "all" }), date("2026-10-14")), false);
  assert.equal(isTaskToday(value, context({ overdueMode: "none" }), date("2026-10-24")), false);
  assert.equal(isTaskToday(value, context(), date("2026-10-26")), true, "exactly 3 overdue calendar days");
  assert.equal(isTaskToday(value, context(), date("2026-10-27")), false, "4 overdue days");
  assert.equal(isTaskToday(value, context({ overdueMode: "all" }), date("2027-01-01")), true);
});

test("personal planning replaces the occurrence window, while dueAt remains an independent reason", () => {
  const active = task({ routineOccurrence: { startDate: "2026-10-15", endDate: "2026-10-30", timezone: "UTC" } });
  assert.equal(isTaskToday(active, context({ overdueMode: "none" }), now), true);
  assert.equal(isTaskToday({ ...active, plannedAt: date("2026-10-26") }, context({ overdueMode: "none" }), now), false);
  assert.equal(isTaskToday({ ...active, plannedAt: date("2026-10-21") }, context(), now), false);
  assert.equal(isTaskToday({ ...active, plannedAt: date("2026-10-22") }, context(), now), true);
  assert.equal(isTaskToday({ ...active, plannedAt: date("2026-10-26"), dueAt: date("2026-10-25") }, context({ overdueMode: "none" }), now), true);
  const future = task({ routineOccurrence: { startDate: "2026-11-15", endDate: "2026-11-23", timezone: "UTC" } });
  assert.equal(isTaskToday({ ...future, plannedAt: date("2026-10-25") }, context({ overdueMode: "none" }), now), true);
  assert.equal(isTaskToday({ ...future, dueAt: date("2026-10-25") }, context({ overdueMode: "none" }), now), true);
});

test("request and occurrence timezones are independent and use one instant across midnight", () => {
  const midnight = new Date("2026-10-24T22:30:00Z"); // Kyiv Oct 25, UTC/LA Oct 24
  const value = task({ routineOccurrence: { startDate: "2026-10-25", endDate: "2026-10-25", timezone: "Europe/Kyiv" } });
  assert.equal(isTaskToday(value, context({ timezone: "America/Los_Angeles", overdueMode: "none" }), midnight), true);
  assert.equal(isTaskToday({ ...value, routineOccurrence: { ...value.routineOccurrence!, timezone: "UTC" } }, context({ timezone: "Europe/Kyiv", overdueMode: "none" }), midnight), false);
  const ordinary = task({ dueAt: new Date("2026-10-25T00:30:00Z") });
  assert.equal(isTaskToday(ordinary, context({ overdueMode: "none" }), midnight), false);
  assert.equal(isTaskToday(ordinary, context({ timezone: "Europe/Kyiv", overdueMode: "none" }), midnight), true);
  assert.equal(isTaskToday(ordinary, context({ overdueMode: "none" }), new Date("2026-10-25T00:00:00Z")), true);
});

test("calendar overdue arithmetic handles Kyiv spring/fall DST without 24-hour arithmetic", () => {
  for (const [asOf, previous] of [["2026-03-30T00:30:00Z", "2026-03-28T22:30:00Z"],
    ["2026-10-26T00:30:00Z", "2026-10-24T22:00:00Z"]]) {
    assert.equal(isTaskToday(task({ dueAt: new Date(previous) }), context({ timezone: "Europe/Kyiv", overdueDays: 1 }), new Date(asOf)), true);
  }
  const occurrence = task({ routineOccurrence: { startDate: "2026-03-29", endDate: "2026-03-29", timezone: "Europe/Kyiv" } });
  assert.equal(isTaskToday(occurrence, context({ overdueDays: 1 }), new Date("2026-03-30T20:59:59Z")), true);
  assert.equal(isTaskToday(occurrence, context({ overdueDays: 1 }), new Date("2026-03-30T21:00:00Z")), false);
});

test("POST/GET/list/PATCH share validated context; default UTC and summary remain independent", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-24T22:30:00Z"));
  const query = "?timezone=Europe%2FKyiv&overdueMode=none&overdueDays=3";
  f.commitConflicts(2);
  let clock = f.taskClockCalls();
  const created = await f.request("POST", query, { title: "Tomorrow in UTC, today in Kyiv", dueAt: "2026-10-25T00:30:00Z", estimatedDurationMinutes: 10 });
  assert.equal(created.status, 201); assert.equal(created.body.isToday, true);
  assert.equal(f.taskClockCalls() - clock, 1, "one response clock read across all serialization attempts");
  assert.equal("isToday" in f.state().tasks[0], false);
  assert.equal("timezone" in f.state().tasks[0], false);
  const before = structuredClone(f.state());
  for (const path of [`/${created.body.id}${query}`, query]) {
    clock = f.taskClockCalls();
    const result = (await f.request("GET", path)).body;
    const value = Array.isArray(result) ? result[0] : result;
    assert.equal(value.isToday, true); assert.deepEqual(value.summary, created.body.summary);
    assert.equal(f.taskClockCalls() - clock, 1);
  }
  const defaultResult = (await f.request("GET", `/${created.body.id}`)).body;
  assert.equal(defaultResult.isToday, false); assert.deepEqual(defaultResult.summary, created.body.summary);
  assert.equal((await f.request("GET", `/${created.body.id}?overdueMode=none`)).body.isToday, false);
  assert.deepEqual(f.state(), before, "GET context does not persist preferences or alter records");
  clock = f.taskClockCalls();
  const changed = await f.request("PATCH", `/${created.body.id}${query}`, { title: "Changed" });
  assert.equal(changed.body.isToday, true); assert.equal(f.taskClockCalls() - clock, 1);
  assert.deepEqual(changed.body.summary, created.body.summary);
  assert.equal((await f.request("PATCH", `/${created.body.id}?overdueMode=none`, { title: "Again" })).body.isToday, false);
});

test("view=today filters the existing ordered array with no writes, generation or per-task history requests", async (t) => {
  const f = await fixture(t); f.setTime(now);
  const ids: string[] = [];
  for (const dueAt of ["2026-10-25", "2026-10-26", "2026-10-22", "2026-10-21"]) {
    ids.push((await f.request("POST", "", { title: dueAt, dueAt: `${dueAt}T12:00:00Z`, estimatedDurationMinutes: 10 })).body.id);
  }
  await f.request("PATCH", `/${ids[0]}`, { status: "PAUSED" });
  const all = (await f.request("GET")).body;
  const before = structuredClone(f.state()), reads = { ...f.reads }, operations = f.operations.length;
  const today = await f.request("GET", "?view=today");
  assert.equal(today.status, 200); assert.ok(Array.isArray(today.body));
  assert.deepEqual(today.body, all.filter((entry: { isToday: boolean }) => entry.isToday));
  assert.deepEqual(new Set(today.body.map((entry: { id: string }) => entry.id)), new Set([ids[0], ids[2]]));
  assert.equal(f.reads.tasks - reads.tasks, 1); assert.equal(f.reads.history - reads.history, 1);
  assert.equal(f.reads.routines, reads.routines); assert.equal(f.reads.occurrences, reads.occurrences);
  assert.deepEqual(f.state(), before); assert.equal(f.operations.length, operations);
  assert.equal((await f.request("GET", "?view=today&overdueMode=all")).body.length, 3);
  assert.equal((await f.request("GET", "?view=today&overdueMode=none")).body.length, 1);
  assert.equal((await f.request("GET", "?archived=false&view=today")).body.length, 2);
  await f.request("PATCH", `/${ids[0]}`, { archived: true });
  assert.equal((await f.request("GET", `/${ids[0]}`)).body.isToday, false);
  assert.equal((await f.request("GET", "?archived=true")).body[0].isToday, false);
  await f.request("DELETE", `/${ids[2]}`);
  assert.equal((await f.request("GET", `/${ids[2]}`)).status, 404);
  assert.deepEqual((await f.request("GET", "?view=today")).body, []);
});

test("query rejects invalid context, unknown views, duplicates, archive conflict and client-supplied clocks before writes", async (t) => {
  const f = await fixture(t); f.setTime(now);
  const created = (await f.request("POST", "", { title: "Validation", dueAt: now.toISOString(), estimatedDurationMinutes: 10 })).body;
  const invalid = ["?timezone=", "?timezone=Mars%2FUnknown", "?timezone=%2B03%3A00", "?timezone=UTC&timezone=Europe%2FKyiv",
    "?overdueMode=", "?overdueMode=other", "?overdueMode=none&overdueMode=all", "?overdueDays=1&overdueDays=2",
    ...["0", "366", "-1", "1.5", "1e2", "", "NaN"].map((days) => `?overdueDays=${days}`),
    "?now=2026-10-25T12:00:00Z", "?date=2026-10-25", "?unknown=true", "?view=all", "?view=today&view=today"];
  const before = structuredClone(f.state()), attempts = f.attempts();
  for (const query of invalid) {
    for (const [method, path, body] of [["GET", query, undefined], ["GET", `/${created.id}${query}`, undefined],
      ["POST", query, { title: "Invalid context", dueAt: now.toISOString(), estimatedDurationMinutes: 10 }],
      ["PATCH", `/${created.id}${query}`, { title: "No write" }]] as const) {
      assert.equal((await f.request(method, path, body)).status, 400, `${method} ${query}`);
    }
  }
  assert.equal((await f.request("GET", "?archived=true&view=today")).status, 400);
  assert.equal((await f.request("POST", "", { title: "No computed inputs", dueAt: now.toISOString(), estimatedDurationMinutes: 10, isToday: true })).status, 400);
  assert.equal((await f.request("PATCH", `/${created.id}`, { isToday: true })).status, 400);
  assert.equal(f.attempts(), attempts); assert.deepEqual(f.state(), before);
  for (const query of ["?overdueDays=1", "?overdueDays=365", "?timezone=UTC", "?timezone=Asia%2FKathmandu"]) {
    assert.equal((await f.request("GET", query)).status, 200);
  }
});

test("saved Massage and monthly windows survive Routine pause/delete; personal plan overrides without changing occurrence", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-24T12:00:00Z"));
  const massage = (await f.routineRequest("POST", "", { title: "Масаж", estimatedDurationMinutes: 30, timezone: "Europe/Kyiv", startDate: "2026-10-25",
    schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 2 }, localTime: "18:00" } })).body;
  const generated = (await f.routineRequest("POST", `/${massage.id}/generate`, { from: "2026-10-25", to: "2026-10-25" })).body;
  const id = generated.created[0].taskId;
  f.setTime(new Date("2026-10-24T22:30:00Z")); // Kyiv Oct 25, long before occurrence localTime
  const detail = (await f.request("GET", `/${id}?timezone=America%2FLos_Angeles&overdueMode=none`)).body;
  assert.equal(detail.isToday, true); assert.equal(detail.plannedAt, null); assert.equal(detail.dueAt, null);
  const occurrence = structuredClone(detail.routineOccurrence);
  await f.routineRequest("PATCH", `/${massage.id}`, { paused: true });
  assert.equal((await f.request("GET", `/${id}?overdueMode=none`)).body.isToday, true);
  await f.routineRequest("DELETE", `/${massage.id}`);
  const before = structuredClone(f.state()), reads = { ...f.reads };
  assert.equal((await f.request("GET", "?view=today&overdueMode=none")).body[0].id, id);
  assert.deepEqual(f.state(), before); assert.equal(f.reads.routines, reads.routines);
  assert.equal((await f.request("PATCH", `/${id}?timezone=Europe%2FKyiv&overdueMode=none`, { plannedAt: "2026-10-26T09:00:00+02:00" })).body.isToday, false);
  const deadline = (await f.request("PATCH", `/${id}?timezone=Europe%2FKyiv&overdueMode=none`, { dueAt: "2026-10-25T18:00:00+02:00" })).body;
  assert.equal(deadline.isToday, true); assert.deepEqual(deadline.routineOccurrence, occurrence);

  f.setTime(new Date("2026-11-01T12:00:00Z"));
  const monthly = (await f.routineRequest("POST", "", { title: "Показники", estimatedDurationMinutes: 10, timezone: "Europe/Kyiv", startDate: "2026-11-01",
    schedule: { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1, selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } } } })).body;
  const monthlyId = (await f.routineRequest("POST", `/${monthly.id}/generate`, { from: "2026-11-20", to: "2026-11-21" })).body.created[0].taskId;
  for (const [day, expected] of [["2026-11-14", false], ["2026-11-15", true], ["2026-11-23", true], ["2026-11-24", false]] as const) {
    f.setTime(date(day));
    assert.equal((await f.request("GET", `/${monthlyId}?overdueMode=none`)).body.isToday, expected);
  }
});

test("verified DONE today ignores task dates and overdue mode; yesterday DONE ignores today's deadline and occurrence", () => {
  for (const overdueMode of ["none", "limited", "all"] as const) {
    for (const dates of [{ plannedAt: null, dueAt: null, routineOccurrence: null },
      { plannedAt: date("2027-01-01"), dueAt: date("2027-01-02"), routineOccurrence: { startDate: "2027-01-01", endDate: "2027-01-03", timezone: "Pacific/Auckland" } },
      { plannedAt: date("2026-10-25"), dueAt: date("2026-10-25"), routineOccurrence: { startDate: "2026-10-15", endDate: "2026-10-30", timezone: "Europe/Kyiv" } }]) {
      const value = task({ ...dates, status: "DONE", completedAt: "2026-10-25T10:00:00.000Z" });
      assert.equal(isTaskToday(value, context({ overdueMode }), now), true);
      assert.equal(isTaskToday({ ...value, completedAt: "2026-10-24T10:00:00.000Z" }, context({ overdueMode }), now), false);
      assert.equal(isTaskToday({ ...value, completedAt: null }, context({ overdueMode }), now), false);
      assert.equal(isTaskToday({ ...value, archivedAt: now }, context({ overdueMode }), now), false);
      assert.equal(isTaskToday({ ...value, deletedAt: now }, context({ overdueMode }), now), false);
      assert.equal(isTaskToday({ ...value, status: "CANCELED" }, context({ overdueMode }), now), false);
    }
  }
});

test("DONE uses the request timezone at midnight, independently from the occurrence timezone", async (t) => {
  const completedAt = "2026-10-24T22:30:00.000Z";
  const asOf = new Date("2026-10-25T00:30:00Z");
  const value = task({ status: "DONE", completedAt, routineOccurrence: { startDate: "2026-10-25", endDate: "2026-10-25", timezone: "Europe/Kyiv" } });
  assert.equal(isTaskToday(value, context({ timezone: "UTC" }), asOf), false);
  assert.equal(isTaskToday(value, context({ timezone: "Europe/Kyiv" }), asOf), true);
  assert.equal(isTaskToday(value, context({ timezone: "America/Los_Angeles" }), asOf), true);
  assert.equal(isTaskToday(value, context({ timezone: "America/Los_Angeles" }), new Date("2026-10-25T07:00:00Z")), false);
  const f = await fixture(t); f.setTime(date("2026-10-20"));
  const created = (await f.request("POST", "", { title: "Midnight", dueAt: "2026-10-25T12:00:00Z", estimatedDurationMinutes: 5 })).body;
  f.setTime(new Date(completedAt)); await f.request("PATCH", `/${created.id}`, { status: "DONE" });
  f.setTime(asOf);
  const utc = (await f.request("GET", `/${created.id}`)).body;
  const kyiv = (await f.request("GET", `/${created.id}?timezone=Europe%2FKyiv`)).body;
  assert.equal(utc.isToday, false); assert.equal(kyiv.isToday, true);
  assert.equal(utc.completedAt, completedAt); assert.equal(kyiv.completedAt, completedAt);
  assert.deepEqual(utc.summary, kyiv.summary);
});

test("just-written DONE is consistent in PATCH/detail/list, with one clock and one batched history query", async (t) => {
  const f = await fixture(t); f.setTime(date("2026-10-20"));
  const created = (await f.request("POST", "?timezone=Europe%2FKyiv", {
    title: "Not planned today", dueAt: "2027-01-01T12:00:00Z", plannedAt: "2027-01-02T12:00:00Z", estimatedDurationMinutes: 5,
  })).body;
  assert.equal(created.completedAt, null); assert.equal(created.isToday, false);
  f.setTime(now); f.commitConflicts(2);
  const clock = f.taskClockCalls(), history = f.reads.history;
  const changed = await f.request("PATCH", `/${created.id}?timezone=Europe%2FKyiv&overdueMode=none`, { status: "DONE" });
  assert.equal(changed.status, 200); assert.equal(changed.body.isCompleted, true); assert.equal(changed.body.isToday, true);
  assert.equal(changed.body.completedAt, now.toISOString()); assert.equal(changed.body.summary.historyIncomplete, false);
  assert.equal(f.taskClockCalls() - clock, 1); assert.equal(f.reads.history - history, 3, "one history query per transaction attempt");
  const detail = (await f.request("GET", `/${created.id}?timezone=Europe%2FKyiv&overdueMode=none`)).body;
  assert.deepEqual(detail, changed.body);
  for (let index = 0; index < 3; index++) {
    const taskId = (await f.request("POST", "", { title: `Other ${index}`, dueAt: "2027-01-01T12:00:00Z", estimatedDurationMinutes: 5 })).body.id;
    await f.request("PATCH", `/${taskId}`, { status: "DONE" });
  }
  const before = structuredClone(f.state()), reads = { ...f.reads }, clocks = f.taskClockCalls();
  const list = (await f.request("GET", "?view=today&timezone=Europe%2FKyiv&overdueMode=none")).body;
  assert.equal(list.length, 4); assert.deepEqual(list.find((entry: { id: string }) => entry.id === created.id), detail);
  assert.ok(list.every((entry: { completedAt: string; isToday: boolean }) => entry.completedAt === now.toISOString() && entry.isToday));
  assert.equal(f.reads.tasks - reads.tasks, 1); assert.equal(f.reads.history - reads.history, 1); assert.equal(f.taskClockCalls() - clocks, 1);
  assert.deepEqual(f.state(), before); assert.equal("completedAt" in f.state().tasks[0], false);
  assert.equal((await f.request("PATCH", `/${created.id}`, { completedAt: now.toISOString() })).status, 400);
});

test("edits and unchanged DONE do not refresh completion; reopening and completing again do", async (t) => {
  const f = await fixture(t); f.setTime(date("2026-10-20"));
  const id = (await f.request("POST", "", { title: "Lifecycle", dueAt: "2026-10-25T12:00:00Z", estimatedDurationMinutes: 5 })).body.id;
  f.setTime(date("2026-10-24"));
  const done = (await f.request("PATCH", `/${id}`, { status: "DONE" })).body;
  assert.equal(done.completedAt, "2026-10-24T12:00:00.000Z");
  f.setTime(now);
  const edited = (await f.request("PATCH", `/${id}`, { title: "Edited today" })).body;
  assert.equal(edited.isToday, false); assert.equal(edited.completedAt, done.completedAt);
  assert.notEqual(edited.updatedAt, done.updatedAt);
  const transitions = f.state().actions.filter((action) => action.type === "STATUS_CHANGED").length;
  const unchanged = (await f.request("PATCH", `/${id}`, { status: "DONE" })).body;
  assert.equal(unchanged.isToday, false); assert.equal(unchanged.completedAt, done.completedAt);
  assert.equal(unchanged.summary.timeToCompletionSeconds, done.summary.timeToCompletionSeconds);
  assert.equal(f.state().actions.filter((action) => action.type === "STATUS_CHANGED").length, transitions);
  const reopened = (await f.request("PATCH", `/${id}`, { status: "TODO" })).body;
  assert.equal(reopened.completedAt, null); assert.equal(reopened.isToday, true, "ordinary deadline rules resume");
  f.setTime(new Date("2026-10-25T12:00:01Z"));
  const recompleted = (await f.request("PATCH", `/${id}`, { status: "DONE" })).body;
  assert.equal(recompleted.completedAt, "2026-10-25T12:00:01.000Z"); assert.equal(recompleted.isToday, true);
  const archived = (await f.request("PATCH", `/${id}`, { archived: true })).body;
  assert.equal(archived.completedAt, recompleted.completedAt); assert.equal(archived.isToday, false);
  assert.equal((await f.request("GET", "?archived=true")).body[0].completedAt, recompleted.completedAt);
  assert.equal((await f.request("PATCH", `/${id}`, { archived: false })).body.isToday, true);
  f.setTime(new Date("2026-10-25T12:00:02Z"));
  const canceled = (await f.request("PATCH", `/${id}`, { status: "CANCELED", cancellationNote: "Canceled" })).body;
  assert.equal(canceled.completedAt, null); assert.equal(canceled.isToday, false);
  await f.request("DELETE", `/${id}`);
  assert.equal((await f.request("GET", `/${id}`)).status, 404);
  assert.deepEqual((await f.request("GET", "?view=today")).body, []);
});

test("automatic Subtask DONE includes a future Routine occurrence today using the parent's real transition", async (t) => {
  const f = await fixture(t); f.setTime(date("2026-10-20"));
  const routine = (await f.routineRequest("POST", "", { title: "Future execution", timezone: "Europe/Kyiv", startDate: "2026-11-01",
    subtasks: [{ title: "Finish", estimatedDurationMinutes: 10 }], schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 1 } } })).body;
  const id = (await f.routineRequest("POST", `/${routine.id}/generate`, { from: "2026-11-01", to: "2026-11-01" })).body.created[0].taskId;
  const parent = (await f.request("GET", `/${id}`)).body;
  assert.equal(parent.completedAt, null); assert.equal(parent.isToday, false);
  f.setTime(now);
  assert.equal((await f.request("PATCH", `/${id}/subtasks/${parent.subtasks[0].id}`, { status: "DONE" })).status, 200);
  const completed = (await f.request("GET", `/${id}?overdueMode=none`)).body;
  assert.equal(completed.completedAt, now.toISOString()); assert.equal(completed.isToday, true);
  assert.equal(completed.summary.historyIncomplete, false); assert.deepEqual(completed.routineOccurrence, parent.routineOccurrence);
  const action = f.state().actions.find((entry) => entry.taskId === id && entry.type === "STATUS_CHANGED")!;
  assert.equal(completed.completedAt, action.timestamp.toISOString());
  assert.equal((action.metadata as { subtaskId: string }).subtaskId, parent.subtasks[0].id);
});

test("untrustworthy DONE has null completedAt and isToday=false without hiding existing summary diagnostics", async (t) => {
  for (const mode of ["missing_creation", "missing_transition", "broken_chain", "malformed", "tied", "budget"] as const) {
    const f = await fixture(t); f.setTime(date("2026-10-20"));
    const id = (await f.request("POST", "", { title: mode, dueAt: now.toISOString(), estimatedDurationMinutes: 5 })).body.id;
    f.setTime(now); await f.request("PATCH", `/${id}`, { status: "DONE" });
    if (mode === "missing_creation") f.state().actions.splice(0, 1);
    if (mode === "missing_transition") f.state().actions.splice(1, 1);
    if (mode === "broken_chain") (f.state().actions[1].metadata as { before: { status: string } }).before.status = "IN_PROGRESS";
    if (mode === "malformed") f.state().actions[1].metadata = { before: {}, after: {} };
    if (mode === "tied") {
      await f.request("PATCH", `/${id}`, { status: "TODO" });
      await f.request("PATCH", `/${id}`, { status: "DONE" });
    }
    if (mode === "budget") f.state().actions.push(...Array.from({ length: 10000 }, (_, index) => ({ ...f.state().actions[1], id: `budget-${index}` })));
    const before = structuredClone(f.state());
    const result = (await f.request("GET", `/${id}?overdueMode=all`)).body;
    assert.equal(result.completedAt, null, mode); assert.equal(result.isToday, false, mode);
    if (mode !== "tied") assert.equal(result.summary.historyIncomplete, true, mode);
    assert.deepEqual((await f.request("GET", "?view=today&overdueMode=all")).body, [], mode);
    assert.deepEqual(f.state(), before, mode);
  }
});
