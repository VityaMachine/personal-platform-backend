import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers/api-fixture";

const daily = (intervalDays = 1, localTime: string | null = null) => ({ version: 1, recurrence: { type: "DAILY", intervalDays }, localTime });
const initial = { title: "Versioned", timezone: "Europe/Kyiv", startDate: "2026-10-25", estimatedDurationMinutes: 10,
  schedule: daily(2), endCondition: { type: "NEVER" } };
const next = { effectiveDate: "2026-11-01", timezone: "Europe/Kyiv", startDate: "2026-11-01", schedule: daily(), endCondition: { type: "NEVER" } };
async function setup(t: TestContext, patch: Record<string, unknown> = {}) {
  const f = await fixture(t); f.setTime(new Date("2026-10-01T12:00:00Z"));
  const created = await f.routineRequest("POST", "", { ...initial, ...patch });
  assert.equal(created.status, 201);
  f.setTime(new Date("2026-10-20T12:00:00Z"));
  return { f, id: created.body.id as string };
}

test("schedule version API validates explicit future dates, strict ordering, modes and immutable calendar PATCH", async (t) => {
  const { f, id } = await setup(t);
  const v1 = (await f.routineRequest("GET", `/${id}/schedule-versions`)).body;
  assert.equal(v1.length, 1); assert.equal(v1[0].number, 1); assert.equal(v1[0].effectiveTimezone, "Europe/Kyiv");
  const before = structuredClone(f.state());
  for (const body of [{ ...next, effectiveDate: "2026-10-20" }, { ...next, effectiveDate: "2026-10-25" },
    { ...next, schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } } }]) {
    assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, body)).status, 409);
  }
  for (const body of [{ ...next, effectiveDate: "2026-02-30" }, { ...next, unknown: true }, { ...next, timezone: "Mars/Unknown" },
    { ...next, endCondition: { type: "UNTIL_DATE", date: "2026-10-01" } }, { effectiveDate: "2026-11-01" }]) {
    assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, body)).status, 400);
  }
  assert.equal((await f.routineRequest("PATCH", `/${id}`, { schedule: daily(3) })).status, 409);
  assert.deepEqual(f.state(), before);
  const version = await f.routineRequest("POST", `/${id}/schedule-versions`, next);
  assert.equal(version.status, 201); assert.equal(version.body.number, 2);
  assert.equal(version.body.effectiveAt, "2026-10-31T22:00:00.000Z");
  const after = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, next)).status, 409);
  assert.equal((await f.routineRequest("PATCH", `/${id}/schedule-versions/${version.body.id}`, { schedule: daily(5) })).status, 404);
  assert.equal((await f.routineRequest("DELETE", `/${id}/schedule-versions/${version.body.id}`)).status, 404);
  assert.deepEqual(f.state(), after);
  const history = (await f.routineRequest("GET", `/${id}/history`)).body;
  const event = history.at(-1);
  assert.equal(event.type, "SCHEDULE_VERSION_CREATED"); assert.equal(event.metadata.effectiveDate, next.effectiveDate);
  assert.equal(event.metadata.scheduleVersionId, version.body.id);
  assert.deepEqual(event.metadata.before.schedule, initial.schedule); assert.deepEqual(event.metadata.after.schedule, next.schedule);
  assert.equal((await f.routineRequest("PATCH", `/${id}`, { title: "Renamed", description: "Details", priority: "HIGH",
    subtasks: [{ title: "New template", estimatedDurationMinutes: 8 }] })).status, 200);
});

test("preview/generation-preview/generate share versions before/after/across the boundary with zero GET writes", async (t) => {
  const { f, id } = await setup(t);
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, next)).status, 201);
  for (const [from, to, expected] of [
    ["2026-10-29", "2026-10-31", ["2026-10-29", "2026-10-31"]],
    ["2026-11-01", "2026-11-03", ["2026-11-01", "2026-11-02", "2026-11-03"]],
    ["2026-10-29", "2026-11-03", ["2026-10-29", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]],
  ] as const) {
    const before = structuredClone(f.state());
    const preview = await f.routineRequest("GET", `/${id}/preview?from=${from}&to=${to}`);
    const generation = await f.routineRequest("GET", `/${id}/generation-preview?from=${from}&to=${to}`);
    assert.equal(preview.status, 200); assert.equal(generation.status, 200, JSON.stringify(generation.body));
    assert.deepEqual(preview.body.occurrences.map((entry: { startDate: string }) => entry.startDate), expected);
    assert.deepEqual(generation.body.occurrences.map((entry: { startDate: string }) => entry.startDate), expected);
    assert.deepEqual(f.state(), before);
  }
  const result = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-10-29", to: "2026-11-03" });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.createdCount, 5);
  const versions = f.state().scheduleVersions;
  for (const occurrence of f.state().occurrences) assert.equal(occurrence.scheduleVersionId,
    versions.find((version) => version.number === (occurrence.startDate < "2026-11-01" ? 1 : 2))!.id);
  const snapshot = structuredClone(f.state());
  const repeat = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-10-29", to: "2026-11-03" });
  assert.equal(repeat.body.createdCount, 0); assert.deepEqual(repeat.body.existing, result.body.created);
  assert.deepEqual(f.state(), snapshot);
});

test("future existing, planning, children and DONE/SKIPPED/deleted records survive version changes unchanged", async (t) => {
  const { f, id } = await setup(t, { subtasks: [{ title: "Saved child", estimatedDurationMinutes: 8 }] });
  const generated = (await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-02", to: "2026-11-06" })).body;
  const statuses = ["DONE", "SKIPPED", "deleted"];
  for (const [index, entry] of generated.created.entries()) {
    await f.request("PATCH", `/${entry.taskId}`, { plannedAt: "2026-12-20T09:00:00Z" });
    f.setTime(new Date(`2026-10-20T12:0${index + 1}:00Z`));
    if (statuses[index] === "deleted") await f.request("DELETE", `/${entry.taskId}`);
    else await f.request("PATCH", `/${entry.taskId}`, { status: statuses[index] });
  }
  const saved = structuredClone({ tasks: f.state().tasks, children: f.state().subtasks, occurrences: f.state().occurrences, actions: f.state().actions });
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, next)).status, 201);
  const preview = await f.routineRequest("GET", `/${id}/generation-preview?from=2026-11-01&to=2026-11-06`);
  assert.equal(preview.status, 200); assert.equal(preview.body.conflicts.length, 3);
  assert.ok(preview.body.conflicts.every((entry: { code: string }) => entry.code === "STORED_WINDOW_CONFLICT"));
  const result = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-01", to: "2026-11-06" });
  assert.equal(result.body.existingCount, 3); assert.equal(result.body.createdCount, 3);
  assert.deepEqual(f.state().tasks.filter((entry) => saved.tasks.some((old) => old.id === entry.id)), saved.tasks);
  assert.deepEqual(f.state().subtasks.filter((entry) => saved.children.some((old) => old.id === entry.id)), saved.children);
  assert.deepEqual(f.state().occurrences.filter((entry) => saved.occurrences.some((old) => old.id === entry.id)), saved.occurrences);
  assert.deepEqual(f.state().actions.slice(0, saved.actions.length), saved.actions);
});

test("monthly and weekly windows belong to their start version, remain whole and suppress overlapping new windows", async (t) => {
  for (const schedule of [
    { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1, selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } } },
    { version: 1, recurrence: { type: "WEEKLY", intervalWeeks: 1, selection: { type: "WINDOW", startWeekday: 1, endWeekday: 5 } } },
  ]) {
    const { f, id } = await setup(t, { startDate: "2026-10-01", schedule });
    f.setTime(new Date("2026-10-10T12:00:00Z"));
    assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, effectiveDate: "2026-10-21", startDate: "2026-10-21" })).status, 201);
    const result = await f.routineRequest("GET", `/${id}/generation-preview?from=2026-10-21&to=2026-10-25`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const window = result.body.occurrences[0];
    assert.equal(window.startDate, schedule.recurrence.type === "MONTHLY" ? "2026-10-15" : "2026-10-19");
    assert.equal(window.endDate, "2026-10-23");
    assert.deepEqual(result.body.occurrences.slice(1).map((entry: { startDate: string }) => entry.startDate), ["2026-10-24", "2026-10-25"]);
    assert.equal(result.body.conflicts.length, 3);
    assert.equal((await f.routineRequest("POST", `/${id}/generate`, { from: "2026-10-21", to: "2026-10-25" })).body.createdCount, 3);
  }
});

test("stale planning cannot materialize an old configuration; current keys apply only to new Tasks", async (t) => {
  const { f, id } = await setup(t);
  const stale = (await f.routineRequest("GET", `/${id}/generation-preview?from=2026-11-02&to=2026-11-02`)).body.occurrences[0];
  await f.routineRequest("POST", `/${id}/schedule-versions`, next);
  const before = structuredClone(f.state());
  const plannedAt = "2026-12-20T09:00:00Z";
  assert.equal((await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-02", to: "2026-11-02",
    planning: [{ occurrenceKey: stale.occurrenceKey, plannedAt }] })).status, 400);
  assert.deepEqual(f.state(), before);
  const fresh = (await f.routineRequest("GET", `/${id}/generation-preview?from=2026-11-02&to=2026-11-02`)).body.occurrences[0];
  assert.notEqual(fresh.occurrenceKey, stale.occurrenceKey);
  const generated = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-02", to: "2026-11-02",
    planning: [{ occurrenceKey: fresh.occurrenceKey, plannedAt }] });
  const taskId = generated.body.created[0].taskId;
  assert.equal((await f.request("GET", `/${taskId}`)).body.plannedAt, plannedAt.replace("Z", ".000Z"));
  const saved = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-02", to: "2026-11-02",
    planning: [{ occurrenceKey: fresh.occurrenceKey, plannedAt: "2027-01-01T09:00:00Z" }] })).body.createdCount, 0);
  assert.deepEqual(f.state(), saved);
});

test("COUNT is a lifetime materialization budget across versions, including skipped and future saved executions", async (t) => {
  const { f, id } = await setup(t, { endCondition: { type: "COUNT", count: 3 } });
  const first = (await f.routineRequest("POST", `/${id}/generate`, { from: "2026-10-25", to: "2026-10-25" })).body.created[0];
  await f.request("PATCH", `/${first.taskId}`, { status: "SKIPPED" });
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, endCondition: { type: "COUNT", count: 3 } })).status, 201);
  const generated = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-01", to: "2026-11-05" });
  assert.equal(generated.status, 200); assert.equal(generated.body.createdCount, 2);
  const before = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, effectiveDate: "2026-11-06", endCondition: { type: "COUNT", count: 2 } })).status, 409);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, effectiveDate: "2026-11-06", startDate: "2026-11-06", endCondition: { type: "COUNT", count: 5 } })).status, 201);
  assert.equal((await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-06", to: "2026-11-10" })).body.createdCount, 2);
  assert.equal(f.state().occurrences.length, 5);
});

test("one AFTER_COMPLETION chain crosses versions after DONE/SKIPPED, preserving saved successors on reopen", async (t) => {
  for (const status of ["DONE", "SKIPPED"] as const) {
    const schedule = { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 }, localTime: "09:00" };
    const { f, id } = await setup(t, { schedule });
    const first = (await f.routineRequest("POST", `/${id}/generate`, { from: "2026-10-25", to: "2026-10-25" })).body.created[0];
    assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, effectiveDate: "2026-10-27", startDate: "2026-10-25",
      schedule: { ...schedule, recurrence: { type: "AFTER_COMPLETION", intervalDays: 3 } }, endCondition: { type: "COUNT", count: 3 } })).status, 201);
    f.setTime(new Date("2026-10-25T12:00:00Z"));
    const outcome = (await f.request("PATCH", `/${first.taskId}`, { status })).body;
    const range = { from: "2026-10-27", to: "2026-11-02" };
    const preview = await f.routineRequest("GET", `/${id}/generation-preview?from=${range.from}&to=${range.to}`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.occurrences[0].startDate, "2026-10-28");
    const generated = await f.routineRequest("POST", `/${id}/generate`, range);
    assert.equal(generated.body.createdCount, 1);
    const saved = structuredClone(f.state().occurrences);
    assert.equal(saved[1].occurrenceNumber, 2); assert.equal(saved[1].previousOccurrenceId, saved[0].id);
    assert.equal(saved[1].basisType, status === "DONE" ? "COMPLETED" : "SKIPPED");
    assert.equal(saved[1].basisAt!.toISOString(), outcome.completedAt ?? outcome.skippedAt);
    assert.notEqual(saved[1].scheduleVersionId, saved[0].scheduleVersionId);
    f.setTime(new Date("2026-10-26T12:00:00Z"));
    await f.request("PATCH", `/${first.taskId}`, { status: "TODO" });
    assert.equal((await f.routineRequest("POST", `/${id}/generate`, range)).body.createdCount, 0);
    assert.deepEqual(f.state().occurrences, saved);
    f.setTime(new Date("2026-10-28T12:00:00Z"));
    await f.request("PATCH", `/${generated.body.created[0].taskId}`, { status: "SKIPPED" });
    assert.equal((await f.routineRequest("POST", `/${id}/generate`, range)).body.createdCount, 1);
    assert.equal(f.state().occurrences[2].occurrenceNumber, 3);
    assert.equal((await f.routineRequest("POST", `/${id}/generate`, range)).body.createdCount, 0);
  }
});

test("version boundary uses the original timezone even when the new schedule changes timezone; DST remains explicit", async (t) => {
  const { f, id } = await setup(t);
  const version = await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, timezone: "America/Los_Angeles", schedule: daily(1, "09:00") });
  assert.equal(version.status, 201); assert.equal(version.body.effectiveTimezone, "Europe/Kyiv");
  assert.equal(version.body.effectiveAt, "2026-10-31T22:00:00.000Z");
  const preview = await f.routineRequest("GET", `/${id}/generation-preview?from=2026-11-01&to=2026-11-01`);
  assert.equal(preview.body.occurrences[0].timezone, "America/Los_Angeles");
  assert.equal(new Date(preview.body.occurrences[0].instant).toISOString(), "2026-11-01T17:00:00.000Z");
  const other = await setup(t, { startDate: "2026-03-25" });
  other.f.setTime(new Date("2026-03-20T12:00:00Z"));
  assert.equal((await other.f.routineRequest("POST", `/${other.id}/schedule-versions`, { ...next, effectiveDate: "2026-03-29", startDate: "2026-03-29", schedule: daily(1, "03:30") })).status, 201);
  const dst = await other.f.routineRequest("GET", `/${other.id}/preview?from=2026-03-29&to=2026-03-29`);
  assert.deepEqual(dst.body.occurrences[0].diagnostics, ["NONEXISTENT_LOCAL_TIME"]);
  const before = structuredClone(other.f.state());
  assert.equal((await other.f.routineRequest("POST", `/${other.id}/generate`, { from: "2026-03-29", to: "2026-03-29" })).status, 409);
  assert.deepEqual(other.f.state(), before);
});

test("version append and generation roll back fully on journal failure, and concurrency does not duplicate windows", async (t) => {
  const { f, id } = await setup(t);
  const before = structuredClone(f.state()); f.failEvents();
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, next)).status, 500);
  assert.deepEqual(f.state(), before);
  const other = await setup(t);
  other.f.commitConflicts(1);
  const results = await Promise.all([
    other.f.routineRequest("POST", `/${other.id}/schedule-versions`, next),
    other.f.routineRequest("POST", `/${other.id}/generate`, { from: "2026-11-01", to: "2026-11-05" }),
  ]);
  assert.equal(results[0].status, 201); assert.equal(results[1].status, 200);
  const generated = await Promise.all([1, 2].map(() => other.f.routineRequest("POST", `/${other.id}/generate`, { from: "2026-11-01", to: "2026-11-05" })));
  assert.ok(generated.every((entry) => entry.status === 200));
  assert.equal(new Set(other.f.state().occurrences.map((entry) => entry.startDate)).size, other.f.state().occurrences.length);
  assert.equal(other.f.state().scheduleVersions.length, 2);
});

test("UNTIL_DATE stops new materialization but never removes old future occurrences; pause/delete semantics survive", async (t) => {
  const { f, id } = await setup(t);
  const old = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-02", to: "2026-11-06" });
  assert.equal(old.status, 200);
  const saved = structuredClone(f.state().occurrences);
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next,
    endCondition: { type: "UNTIL_DATE", date: "2026-11-03" } })).status, 201);
  const result = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-01", to: "2026-11-10" });
  assert.equal(result.status, 200); assert.equal(result.body.createdCount, 2); assert.equal(result.body.existingCount, 3);
  assert.ok(f.state().occurrences.filter((entry) => !saved.some((old) => old.id === entry.id)).every((entry) => entry.startDate <= "2026-11-03"));
  assert.deepEqual(f.state().occurrences.filter((entry) => saved.some((old) => old.id === entry.id)), saved);
  f.setTime(new Date("2026-10-21T12:00:00Z"));
  await f.routineRequest("PATCH", `/${id}`, { paused: true });
  const before = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-01", to: "2026-11-10" })).status, 409);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.routineRequest("GET", `/${id}/preview?from=2026-11-01&to=2026-11-10`)).status, 200);
  await f.routineRequest("DELETE", `/${id}`);
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, effectiveDate: "2026-12-01" })).status, 404);
});

test("AFTER_COMPLETION rejects a boundary without a consistent candidate and invalidates stale completion planning", async (t) => {
  const schedule = { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 4 } };
  const { f, id } = await setup(t, { schedule });
  const first = (await f.routineRequest("POST", `/${id}/generate`, { from: "2026-10-25", to: "2026-10-25" })).body.created[0];
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, effectiveDate: "2026-10-28", startDate: "2026-10-25",
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 1 } } })).status, 201);
  f.setTime(new Date("2026-10-25T12:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
  const before = structuredClone(f.state());
  const gap = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-10-26", to: "2026-11-02" });
  assert.equal(gap.status, 409); assert.match(gap.body.error.message, /VERSION_BOUNDARY_NO_CANDIDATE/); assert.deepEqual(f.state(), before);
  const other = await setup(t, { schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } } });
  const one = (await other.f.routineRequest("POST", `/${other.id}/generate`, { from: "2026-10-25", to: "2026-10-25" })).body.created[0];
  other.f.setTime(new Date("2026-10-25T12:00:00Z")); await other.f.request("PATCH", `/${one.taskId}`, { status: "SKIPPED" });
  const stale = (await other.f.routineRequest("GET", `/${other.id}/generation-preview?from=2026-10-27&to=2026-10-30`)).body.occurrences[0].occurrenceKey;
  assert.equal((await other.f.routineRequest("POST", `/${other.id}/schedule-versions`, { ...next, effectiveDate: "2026-10-27", startDate: "2026-10-25",
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 3 } } })).status, 201);
  const fresh = (await other.f.routineRequest("GET", `/${other.id}/generation-preview?from=2026-10-27&to=2026-10-30`)).body.occurrences[0];
  assert.notEqual(fresh.occurrenceKey, stale);
  assert.equal((await other.f.routineRequest("POST", `/${other.id}/generate`, { from: "2026-10-27", to: "2026-10-30",
    planning: [{ occurrenceKey: stale, plannedAt: "2026-12-01T09:00:00Z" }] })).status, 400);
});

test("retrospective appends and missing version events are explicit conflicts, including read-only preview", async (t) => {
  const { f, id } = await setup(t, { startDate: "2026-10-01" });
  const retrospective = await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, effectiveDate: "2026-10-20" });
  assert.equal(retrospective.status, 409); assert.match(retrospective.body.error.message, /Retroactive/);
  await f.routineRequest("POST", `/${id}/schedule-versions`, next);
  f.state().routineActions = f.state().routineActions.filter((entry) => entry.type !== "SCHEDULE_VERSION_CREATED");
  const before = structuredClone(f.state());
  for (const route of ["preview", "generation-preview"]) {
    assert.equal((await f.routineRequest("GET", `/${id}/${route}?from=2026-11-01&to=2026-11-02`)).status, 409);
  }
  assert.equal((await f.routineRequest("POST", `/${id}/generate`, { from: "2026-11-01", to: "2026-11-02" })).status, 409);
  assert.deepEqual(f.state(), before);
});

test("a window excluded by its version COUNT cannot suppress new-version windows with remaining budget", async (t) => {
  const { f, id } = await setup(t, { startDate: "2026-09-01", endCondition: { type: "COUNT", count: 1 },
    schedule: { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1,
      selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } } } });
  assert.equal((await f.routineRequest("POST", `/${id}/generate`, { from: "2026-09-15", to: "2026-09-15" })).body.createdCount, 1);
  assert.equal((await f.routineRequest("POST", `/${id}/schedule-versions`, { ...next, effectiveDate: "2026-10-21", startDate: "2026-10-21",
    endCondition: { type: "COUNT", count: 3 } })).status, 201);
  const preview = await f.routineRequest("GET", `/${id}/generation-preview?from=2026-10-21&to=2026-10-24`);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.occurrences.map((entry: { startDate: string }) => entry.startDate), ["2026-10-21", "2026-10-22"]);
  assert.equal(preview.body.conflicts, undefined);
  const generated = await f.routineRequest("POST", `/${id}/generate`, { from: "2026-10-21", to: "2026-10-24" });
  assert.equal(generated.body.createdCount, 2); assert.equal(f.state().occurrences.length, 3);
});
