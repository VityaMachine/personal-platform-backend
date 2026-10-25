import assert from "node:assert/strict";
import { test } from "node:test";
import { clipLocalDateWindow, endConditionSchema, localDateSchema, monthlySelectionSchema, monthlyWindow,
  scheduleSchema, timezoneSchema, weeklySelectionSchema, weeklyWindows } from "../src/modules/routines/routines.schedule";

const recurrences = [
  { type: "DAILY", intervalDays: 2 },
  { type: "WEEKLY", intervalWeeks: 2, selection: { type: "DAYS", weekdays: [1, 4] } },
  { type: "WEEKLY", intervalWeeks: 1, selection: { type: "WINDOW", startWeekday: 6, endWeekday: 7 } },
  { type: "MONTHLY", intervalMonths: 1, selection: { type: "DAY", day: 31, shortMonthPolicy: "SKIP" } },
  { type: "MONTHLY", intervalMonths: 2, selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "CLAMP" } },
  { type: "MONTHLY", intervalMonths: 1, selection: { type: "LAST_DAY" } },
  { type: "AFTER_COMPLETION", intervalDays: 90 },
] as const;

test("schedule v1 validates every recurrence and end-condition variant without generating occurrences", () => {
  for (const recurrence of recurrences) {
    for (const localTime of [undefined, null, "02:30", "23:59"]) {
      const result = scheduleSchema.parse({ version: 1, recurrence, localTime });
      assert.deepEqual(result.recurrence, recurrence);
      assert.equal(result.localTime, localTime ?? null);
    }
  }
  for (const end of [{ type: "NEVER" }, { type: "UNTIL_DATE", date: "2028-02-29" }, { type: "COUNT", count: 7 }]) {
    assert.deepEqual(endConditionSchema.parse(end), end);
  }
});

test("weekly selection distinguishes separate weekdays from a single Monday-based window", () => {
  const days = weeklySelectionSchema.parse({ type: "DAYS", weekdays: [4, 1] });
  assert.deepEqual(weeklyWindows(days), [{ startWeekday: 1, endWeekday: 1 }, { startWeekday: 4, endWeekday: 4 }]);
  const weekend = weeklySelectionSchema.parse({ type: "WINDOW", startWeekday: 6, endWeekday: 7 });
  assert.deepEqual(weeklyWindows(weekend), [{ startWeekday: 6, endWeekday: 7 }]);
  for (const selection of [{ type: "DAYS", weekdays: [] }, { type: "DAYS", weekdays: [1, 1] },
    { type: "DAYS", weekdays: [0, 8] }, { type: "WINDOW", startWeekday: 7, endWeekday: 1 },
    { type: "WINDOW", startWeekday: 6, endWeekday: 7, weekdays: [1] }]) {
    assert.equal(weeklySelectionSchema.safeParse(selection).success, false);
  }
});

test("monthly helpers resolve supplied 15–23 windows and explicit short-month policies, including Gregorian leap years", () => {
  for (const shortMonthPolicy of ["SKIP", "CLAMP"]) {
    const selection = monthlySelectionSchema.parse({ type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy });
    assert.deepEqual(monthlyWindow(2026, 2, selection), { startDay: 15, endDay: 23 });
    assert.deepEqual(monthlyWindow(2026, 4, selection), { startDay: 15, endDay: 23 });
  }
  const selection = (shortMonthPolicy: "SKIP" | "CLAMP") => monthlySelectionSchema.parse({
    type: "WINDOW", startDay: 30, endDay: 31, shortMonthPolicy,
  });
  assert.equal(monthlyWindow(2026, 2, selection("SKIP")), null);
  assert.deepEqual(monthlyWindow(2026, 2, selection("CLAMP")), { startDay: 28, endDay: 28 });
  assert.deepEqual(monthlyWindow(2028, 2, selection("CLAMP")), { startDay: 29, endDay: 29 });
  assert.equal(monthlyWindow(2026, 4, selection("SKIP")), null);
  assert.deepEqual(monthlyWindow(2026, 4, selection("CLAMP")), { startDay: 30, endDay: 30 });
  const last = monthlySelectionSchema.parse({ type: "LAST_DAY" });
  assert.deepEqual(monthlyWindow(2000, 2, last), { startDay: 29, endDay: 29 });
  assert.deepEqual(monthlyWindow(2100, 2, last), { startDay: 28, endDay: 28 });
  assert.equal(monthlyWindow(2026, 2, monthlySelectionSchema.parse({ type: "DAY", day: 31, shortMonthPolicy: "SKIP" })), null);
  assert.throws(() => monthlyWindow(2026, 13, last), RangeError);
});

test("date windows clip inclusively to Routine boundaries and empty intersections return null", () => {
  const window = { startDate: "2026-10-15", endDate: "2026-10-23" };
  assert.deepEqual(clipLocalDateWindow(window, "2026-10-17", { type: "UNTIL_DATE", date: "2026-10-20" }),
    { startDate: "2026-10-17", endDate: "2026-10-20" });
  assert.deepEqual(clipLocalDateWindow(window, "2026-10-23", { type: "UNTIL_DATE", date: "2026-10-23" }),
    { startDate: "2026-10-23", endDate: "2026-10-23" });
  assert.equal(clipLocalDateWindow(window, "2026-10-24", { type: "NEVER" }), null);
  assert.equal(clipLocalDateWindow(window, "2026-10-01", { type: "UNTIL_DATE", date: "2026-10-14" }), null);
  assert.deepEqual(clipLocalDateWindow(window, "2026-10-01", { type: "COUNT", count: 2 }), window);
});

test("invalid, contradictory and unversioned rules, dates, times and non-IANA offsets are rejected", () => {
  const invalid = [{}, { version: 2, recurrence: recurrences[0] },
    ...[0, -1, 1.5, "2", null, 2_147_483_648].map((intervalDays) => ({ version: 1, recurrence: { type: "DAILY", intervalDays } })),
    { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1, selection: { type: "DAY", day: 31 } } },
    { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1, selection: { type: "WINDOW", startDay: 23, endDay: 15, shortMonthPolicy: "CLAMP" } } },
    { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 90, windowDays: 2 } },
    { version: 1, recurrence: { type: "DAILY", intervalDays: 1 }, cron: "* * * * *" },
    ...["24:00", "12:60", "9:00", "12:00Z", "12:00:00"].map((localTime) => ({ version: 1, recurrence: recurrences[0], localTime })),
  ];
  for (const value of invalid) assert.equal(scheduleSchema.safeParse(value).success, false, JSON.stringify(value));
  for (const value of [{ type: "COUNT", count: 0 }, { type: "COUNT", count: 1.5 }, { type: "UNTIL_DATE", date: "2026-02-29" },
    { type: "NEVER", count: 1 }]) assert.equal(endConditionSchema.safeParse(value).success, false);
  for (const zone of ["Europe/Kyiv", "America/New_York", "UTC", "Asia/Kathmandu"]) assert.equal(timezoneSchema.safeParse(zone).success, true);
  for (const zone of ["+03:00", "UTC+03:00", "Mars/Unknown", "", " Europe/Kyiv "]) assert.equal(timezoneSchema.safeParse(zone).success, false);
  for (const date of ["2026-02-30", "2026-10-25T00:00:00Z", "0000-01-01"]) assert.equal(localDateSchema.safeParse(date).success, false);
});
