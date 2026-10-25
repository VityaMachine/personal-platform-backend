import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { calculateRoutinePreview, type PreviewOptions, type PreviewRoutine } from "../src/modules/routines/routines.preview";
import { scheduleSchema } from "../src/modules/routines/routines.schedule";
import { fixture } from "./helpers/api-fixture";

const input = { title: "Масаж", timezone: "Europe/Kyiv", startDate: "2026-10-25", estimatedDurationMinutes: 30,
  schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 2 } } };
const routine = (recurrence: unknown, patch: Partial<PreviewRoutine> = {}): PreviewRoutine => ({
  id: "00000000-0000-4000-8000-000000000001", timezone: "Europe/Kyiv", startDate: "2026-01-01",
  schedule: scheduleSchema.parse({ version: 1, recurrence }), endCondition: { type: "NEVER" }, ...patch,
});
const preview = (r: PreviewRoutine, from: string, to = from, limit = 100, options: Partial<PreviewOptions> = {}) =>
  calculateRoutinePreview(r, from, to, limit, { pauses: [], countReliable: true, ...options });
const dates = (result: ReturnType<typeof preview>) => result.occurrences.map((o) => [o.startDate, o.endDate]);
const daily = { type: "DAILY", intervalDays: 2 };

test("massage dates, stable keys, all-day instants, exact limit and real truncation", () => {
  const r = routine(daily, { startDate: "2026-10-25" });
  const all = preview(r, "2026-10-25", "2026-11-07", 7);
  assert.deepEqual(all.occurrences.map((o) => o.startDate),
    ["2026-10-25", "2026-10-27", "2026-10-29", "2026-10-31", "2026-11-02", "2026-11-04", "2026-11-06"]);
  assert.equal(all.truncated, false);
  assert.ok(all.occurrences.every((o) => o.instant === null && o.localTime === null && o.timezone === "Europe/Kyiv"));
  const limited = preview(r, "2026-10-25", "2026-11-07", 6);
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.occurrences, all.occurrences.slice(0, 6));
  assert.deepEqual(preview(r, "2026-11-02", "2026-11-02").occurrences, all.occurrences.slice(4, 5));
});

test("monthly intersections preserve real windows, clipping only to Routine boundaries", () => {
  const r = routine({ type: "MONTHLY", intervalMonths: 1,
    selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } });
  const inside = preview(r, "2026-02-20", "2026-02-21");
  assert.deepEqual(dates(inside), [["2026-02-15", "2026-02-23"]]);
  assert.deepEqual(preview(r, "2026-02-01", "2026-02-28").occurrences, inside.occurrences);
  assert.deepEqual(dates(preview({ ...r, startDate: "2026-02-18", endCondition: { type: "UNTIL_DATE", date: "2026-02-22" } },
    "2026-02-20", "2026-02-21")), [["2026-02-18", "2026-02-22"]]);
});

test("weekly days count separately; windows count once; Monday anchor is retained", () => {
  const r = routine({ type: "WEEKLY", intervalWeeks: 2, selection: { type: "DAYS", weekdays: [1, 4] } },
    { startDate: "2026-10-28", endCondition: { type: "COUNT", count: 3 } });
  assert.deepEqual(dates(preview(r, "2026-10-28", "2026-11-30")),
    [["2026-10-29", "2026-10-29"], ["2026-11-09", "2026-11-09"], ["2026-11-12", "2026-11-12"]]);
  assert.deepEqual(dates(preview(r, "2026-11-10", "2026-11-30")), [["2026-11-12", "2026-11-12"]]);
  const windows = routine({ type: "WEEKLY", intervalWeeks: 2,
    selection: { type: "WINDOW", startWeekday: 1, endWeekday: 7 } },
  { startDate: "2026-10-28", endCondition: { type: "COUNT", count: 2 } });
  assert.deepEqual(dates(preview(windows, "2026-10-30", "2026-11-30")),
    [["2026-10-28", "2026-11-01"], ["2026-11-09", "2026-11-15"]]);
});

test("monthly interval anchoring, SKIP vs CLAMP, leap year and last day with COUNT", () => {
  const r = routine({ type: "MONTHLY", intervalMonths: 1,
    selection: { type: "DAY", day: 31, shortMonthPolicy: "SKIP" } },
  { endCondition: { type: "COUNT", count: 3 } });
  assert.deepEqual(dates(preview(r, "2026-02-01", "2026-06-30")), [["2026-03-31", "2026-03-31"], ["2026-05-31", "2026-05-31"]]);
  for (const [year, last] of [[2026, 28], [2028, 29], [2100, 28], [2000, 29]]) {
    for (const selection of [{ type: "DAY", day: 31, shortMonthPolicy: "CLAMP" }, { type: "LAST_DAY" }]) {
      assert.deepEqual(dates(preview(routine({ type: "MONTHLY", intervalMonths: 1, selection }, { startDate: `${year}-01-01` }),
        `${year}-02-01`, `${year}-02-${last}`)), [[`${year}-02-${last}`, `${year}-02-${last}`]]);
    }
  }
  const anchored = routine({ type: "MONTHLY", intervalMonths: 2, selection: { type: "LAST_DAY" } }, { startDate: "2026-01-30" });
  assert.deepEqual(dates(preview(anchored, "2026-02-01", "2026-06-30")), [["2026-03-31", "2026-03-31"], ["2026-05-31", "2026-05-31"]]);
});

test("pauses exclude starts, retain earlier windows, preserve anchor, and do not consume COUNT", () => {
  const r = routine(daily, { startDate: "2026-10-25", endCondition: { type: "COUNT", count: 4 } });
  assert.deepEqual(dates(preview(r, "2026-10-29", "2026-11-10", 100,
    { pauses: [{ startDate: "2026-10-27", endDate: "2026-10-30" }] })),
  [["2026-10-31", "2026-10-31"], ["2026-11-02", "2026-11-02"], ["2026-11-04", "2026-11-04"]]);
  const window = routine({ type: "MONTHLY", intervalMonths: 1,
    selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } });
  assert.deepEqual(dates(preview(window, "2026-02-20", "2026-02-21", 100,
    { pauses: [{ startDate: "2026-02-20", endDate: null }] })), [["2026-02-15", "2026-02-23"]]);
  assert.deepEqual(preview(window, "2026-03-01", "2026-04-30", 100,
    { pauses: [{ startDate: "2026-02-20", endDate: null }] }).occurrences, []);
});

test("completion preview returns only first or one explicit next date, converts timezone, applies count/end/pause", () => {
  const r = routine({ type: "AFTER_COMPLETION", intervalDays: 2 }, { startDate: "2026-10-25" });
  assert.deepEqual(dates(preview(r, "2026-10-25", "2026-12-31")), [["2026-10-25", "2026-10-25"]]);
  assert.deepEqual(preview(r, "2026-10-26", "2026-12-31").occurrences, []);
  const context = { completedAt: "2026-10-25T23:30:00Z", completedOccurrenceNumber: 3 };
  assert.deepEqual(dates(preview(r, "2026-10-25", "2026-12-31", 100, { completionContext: context })), [["2026-10-28", "2026-10-28"]]);
  for (const endCondition of [{ type: "COUNT", count: 3 }, { type: "UNTIL_DATE", date: "2026-10-27" }] as const) {
    assert.deepEqual(preview({ ...r, endCondition }, "2026-10-25", "2026-12-31", 100, { completionContext: context }).occurrences, []);
  }
  assert.deepEqual(preview(r, "2026-10-25", "2026-12-31", 100,
    { completionContext: context, pauses: [{ startDate: "2026-10-28", endDate: null }] }).occurrences, []);
  assert.throws(() => preview(r, "2026-10-25", "2026-12-31", 100,
    { completionContext: { completedAt: "2026-10-24T00:00:00Z", completedOccurrenceNumber: 1 } }));
});

test("Kyiv DST keeps calendar dates and reports missing and ambiguous local times without offset selection", () => {
  const r = routine({ type: "DAILY", intervalDays: 1 });
  r.schedule.localTime = "03:30";
  const spring = preview(r, "2026-03-29").occurrences[0];
  assert.equal(spring.instant, null);
  assert.deepEqual(spring.diagnostics, ["NONEXISTENT_LOCAL_TIME"]);
  const fall = preview(r, "2026-10-25").occurrences[0];
  assert.equal(fall.instant, null);
  assert.deepEqual(fall.diagnostics, ["AMBIGUOUS_LOCAL_TIME"]);
  assert.equal(preview(r, "2026-03-30").occurrences[0].instant, "2026-03-30T00:30:00Z");
  assert.equal(preview(r, "2026-10-26").occurrences[0].instant, "2026-10-26T01:30:00Z");
});

test("period seeking and explicit computation budget, including COUNT before requested range", () => {
  const r = routine({ type: "DAILY", intervalDays: 1 }, { startDate: "0001-01-01" });
  assert.equal(preview(r, "9999-12-31", "9999-12-31", 100, { periodBudget: 1 }).occurrences.length, 1);
  const counted = preview({ ...r, endCondition: { type: "COUNT", count: 2_147_483_647 } }, "9999-12-31");
  assert.ok(counted.limitations.includes("COMPUTATION_BUDGET_EXCEEDED"));
  assert.equal(counted.truncated, false);
  const partial = preview(r, "0001-01-01", "0001-01-05", 100, { periodBudget: 2 });
  assert.equal(partial.occurrences.length, 2);
  assert.ok(partial.limitations.includes("COMPUTATION_BUDGET_EXCEEDED"));
  assert.equal(preview(r, "0001-01-01", "0001-01-02", 2, { periodBudget: 2 }).truncated, false);
});

test("preview API validation, route compatibility, defaults and zero writes", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-25T12:00:00Z"));
  const created = (await f.routineRequest("POST", "", input)).body;
  const base = `/${created.id}/preview`;
  for (const query of ["", "?from=2026-10-25", "?from=2026-02-30&to=2026-03-01", "?from=2026-10-26&to=2026-10-25",
    "?from=2026-01-01&to=2027-01-02", ...["0", "501", "1.5", "1e2", "", "-1"].map((limit) => `?from=2026-10-25&to=2026-11-07&limit=${limit}`),
    "?from=2026-10-25&to=2026-11-07&limit=1&limit=2", "?from=2026-10-25&to=2026-11-07&unknown=x",
    "?from=2026-10-25&to=2026-11-07&completedAt=2026-10-25T12:00:00Z",
    "?from=2026-10-25&to=2026-11-07&completedOccurrenceNumber=1",
    "?from=2026-10-25&to=2026-11-07&completedAt=2026-10-25T12:00:00&completedOccurrenceNumber=1"]) {
    assert.equal((await f.routineRequest("GET", base + query)).status, 400, query);
  }
  const before = structuredClone(f.state());
  const operations = f.operations.length;
  const reads = { ...f.reads };
  const result = await f.routineRequest("GET", base + "?from=2026-10-25&to=2026-11-07");
  assert.equal(result.status, 200);
  assert.equal(result.body.occurrences.length, 7);
  assert.equal(result.body.truncated, false);
  assert.deepEqual(result.body.limitations, ["CURRENT_CONFIGURATION_PROJECTION"]);
  assert.deepEqual(f.state(), before);
  assert.equal(f.operations.length, operations);
  assert.equal(f.reads.routines - reads.routines, 1);
  assert.equal(f.reads.routineHistory - reads.routineHistory, 1);
  assert.equal((await f.routineRequest("GET", base + "?from=2026-01-01&to=2027-01-01")).status, 200); // 366 inclusive
  assert.equal((await f.routineRequest("GET", "/invalid/preview?from=2026-10-25&to=2026-10-25")).status, 400);
  assert.equal((await f.routineRequest("GET", `/${randomUUID()}/preview?from=2026-10-25&to=2026-10-25`)).status, 404);
  assert.equal((await f.routineRequest("GET", `/${created.id}`)).status, 200);
  assert.equal((await f.routineRequest("GET", `/${created.id}/history`)).status, 200);
  await f.routineRequest("DELETE", `/${created.id}`);
  assert.equal((await f.routineRequest("GET", base + "?from=2026-10-25&to=2026-11-07")).status, 404);
});

test("history pause normalization uses timezone, resume-exclusive dates and an open current pause", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-24T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, endCondition: { type: "COUNT", count: 4 } })).body;
  const get = () => f.routineRequest("GET", `/${r.id}/preview?from=2026-10-25&to=2026-11-15`);
  f.setTime(new Date("2026-10-26T23:00:00Z")); // local Oct 27
  await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
  assert.deepEqual((await get()).body.occurrences.map((o: { startDate: string }) => o.startDate), ["2026-10-25"]);
  f.setTime(new Date("2026-10-30T23:00:00Z")); // local Oct 31, active again
  await f.routineRequest("PATCH", `/${r.id}`, { paused: false });
  assert.deepEqual((await get()).body.occurrences.map((o: { startDate: string }) => o.startDate),
    ["2026-10-25", "2026-10-31", "2026-11-02", "2026-11-04"]);
  f.setTime(new Date("2026-11-02T05:00:00Z"));
  await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
  f.setTime(new Date("2026-11-02T09:00:00Z"));
  await f.routineRequest("PATCH", `/${r.id}`, { paused: false });
  assert.equal((await get()).body.occurrences.length, 4, "same-day pause/resume excludes no local dates");
  await f.routineRequest("PATCH", `/${r.id}`, { title: "Updated title" });
  assert.deepEqual((await get()).body.limitations, ["CURRENT_CONFIGURATION_PROJECTION"]);
});

test("configuration changes, missing events and timestamp ties report COUNT uncertainty", async (t) => {
  for (const mode of ["schedule", "timezone", "startDate", "endCondition", "missing", "tie"] as const) {
    const f = await fixture(t);
    f.setTime(new Date("2026-10-25T12:00:00Z"));
    const r = (await f.routineRequest("POST", "", { ...input, endCondition: { type: "COUNT", count: 4 } })).body;
    f.setTime(new Date("2026-10-26T12:00:00Z"));
    if (mode === "missing") f.state().routineActions = [];
    else if (mode === "tie") {
      await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
      await f.routineRequest("PATCH", `/${r.id}`, { paused: false });
    } else await f.routineRequest("PATCH", `/${r.id}`, mode === "schedule"
      ? { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 3 } } }
      : mode === "timezone" ? { timezone: "UTC" } : mode === "startDate" ? { startDate: "2026-10-24" }
      : { endCondition: { type: "COUNT", count: 5 } });
    const result = await f.routineRequest("GET", `/${r.id}/preview?from=2026-10-25&to=2026-11-07`);
    assert.equal(result.status, 200, mode);
    assert.deepEqual(result.body.occurrences, [], mode);
    assert.ok(result.body.limitations.includes("COUNT_HISTORY_UNCERTAIN"), mode);
    assert.ok(result.body.limitations.includes(mode === "missing" || mode === "tie" ? "PAUSE_HISTORY_UNCERTAIN" : "CONFIGURATION_CHANGED"), mode);
  }
});

test("completion query context is validated, read-only, and only simulates the next occurrence", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", { ...input,
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } } })).body;
  const base = `/${r.id}/preview?from=2026-10-25&to=2026-11-07`;
  const before = structuredClone(f.state());
  const result = await f.routineRequest("GET", base + "&completedAt=2026-10-25T23%3A30%3A00%2B00%3A00&completedOccurrenceNumber=2");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.occurrences.map((o: { startDate: string }) => o.startDate), ["2026-10-28"]);
  assert.ok(result.body.limitations.includes("FUTURE_COMPLETIONS_REQUIRED"));
  assert.deepEqual(f.state(), before);
  for (const extra of ["&completedAt=2026-10-24T00:00:00Z&completedOccurrenceNumber=1",
    "&completedAt=invalid&completedOccurrenceNumber=1", "&completedAt=2026-10-25T00:00:00Z&completedOccurrenceNumber=0"]) {
    assert.equal((await f.routineRequest("GET", base + extra)).status, 400);
  }
  const calendar = (await f.routineRequest("POST", "", input)).body;
  assert.equal((await f.routineRequest("GET", `/${calendar.id}/preview?from=2026-10-25&to=2026-11-07&completedAt=2026-10-25T00:00:00Z&completedOccurrenceNumber=1`)).status, 400);
});

test("API exposes period and history budgets instead of claiming a complete empty preview", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", { ...input, startDate: "0001-01-01",
    schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 1 } },
    endCondition: { type: "COUNT", count: 2_147_483_647 } })).body;
  const base = `/${r.id}/preview?from=9999-12-31&to=9999-12-31`;
  const result = await f.routineRequest("GET", base);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.occurrences, []);
  assert.ok(result.body.limitations.includes("COMPUTATION_BUDGET_EXCEEDED"));
  const action = f.state().routineActions[0];
  f.state().routineActions = Array.from({ length: 10_002 }, (_, index) => ({ ...action,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
  const before = structuredClone(f.state());
  const limited = await f.routineRequest("GET", base);
  assert.equal(limited.status, 200);
  assert.deepEqual(limited.body.occurrences, []);
  assert.ok(limited.body.limitations.includes("HISTORY_BUDGET_EXCEEDED"));
  assert.deepEqual(f.state(), before);
});

test("non-COUNT previews expose projection/history uncertainty and still apply a missing current pause", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-25T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", input)).body;
  f.setTime(new Date("2026-10-27T12:00:00Z"));
  await f.routineRequest("PATCH", `/${r.id}`, { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 3 } } });
  const base = `/${r.id}/preview?from=2026-10-25&to=2026-11-07`;
  const changed = await f.routineRequest("GET", base);
  assert.ok(changed.body.limitations.includes("CONFIGURATION_CHANGED"));
  assert.deepEqual(changed.body.occurrences.map((o: { startDate: string }) => o.startDate),
    ["2026-10-25", "2026-10-28", "2026-10-31", "2026-11-03", "2026-11-06"]);
  await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
  f.state().routineActions = f.state().routineActions.filter((a) => a.type !== "PAUSED");
  const missing = await f.routineRequest("GET", base);
  assert.ok(missing.body.limitations.includes("PAUSE_HISTORY_UNCERTAIN"));
  assert.deepEqual(missing.body.occurrences.map((o: { startDate: string }) => o.startDate), ["2026-10-25"]);
});

test("calendar bounds and huge valid intervals do not overflow date arithmetic", () => {
  for (const recurrence of [{ type: "DAILY", intervalDays: 2_147_483_647 },
    { type: "WEEKLY", intervalWeeks: 2_147_483_647, selection: { type: "DAYS", weekdays: [1, 7] } },
    { type: "MONTHLY", intervalMonths: 2_147_483_647, selection: { type: "LAST_DAY" } }]) {
    assert.equal(preview(routine(recurrence), "9999-12-31").occurrences.length, 0);
  }
  const completion = routine({ type: "AFTER_COMPLETION", intervalDays: 2_147_483_647 });
  assert.ok(preview(completion, "9999-12-31", "9999-12-31", 100, { completionContext: {
    completedAt: "2026-10-25T12:00:00Z", completedOccurrenceNumber: 1,
  } }).limitations.includes("CALENDAR_RANGE_EXCEEDED"));
  const finalWeek = routine({ type: "WEEKLY", intervalWeeks: 1, selection: { type: "WINDOW", startWeekday: 1, endWeekday: 7 } });
  assert.ok(preview(finalWeek, "9999-12-31").limitations.includes("CALENDAR_RANGE_EXCEEDED"));
  assert.deepEqual(dates(preview({ ...finalWeek, endCondition: { type: "UNTIL_DATE", date: "9999-12-31" } }, "9999-12-31")),
    [["9999-12-27", "9999-12-31"]]);
});
