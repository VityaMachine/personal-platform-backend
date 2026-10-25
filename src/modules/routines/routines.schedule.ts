import { z } from "zod";

export const localDateSchema = z.iso.date().refine((value) => !value.startsWith("0000"), "Year must be between 0001 and 9999.");
export const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  if (!/^[A-Za-z][A-Za-z0-9._+\-/]*$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Expected an IANA timezone identifier.");
const interval = z.number().int().positive().max(2_147_483_647);
const weekday = z.number().int().min(1).max(7);
const monthDay = z.number().int().min(1).max(31);
const shortMonthPolicy = z.enum(["SKIP", "CLAMP"]);

export const weeklySelectionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("DAYS"), weekdays: z.array(weekday).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, "Weekdays must be unique.")
    .transform((days) => [...days].sort((a, b) => a - b)) }),
  z.strictObject({ type: z.literal("WINDOW"), startWeekday: weekday, endWeekday: weekday })
    .refine((value) => value.startWeekday <= value.endWeekday, "Window must stay within one Monday-based week."),
]);
export const monthlySelectionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("DAY"), day: monthDay, shortMonthPolicy }),
  z.strictObject({ type: z.literal("WINDOW"), startDay: monthDay, endDay: monthDay, shortMonthPolicy })
    .refine((value) => value.startDay <= value.endDay, "startDay must not exceed endDay."),
  z.strictObject({ type: z.literal("LAST_DAY") }),
]);
export const scheduleSchema = z.strictObject({
  version: z.literal(1),
  recurrence: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("DAILY"), intervalDays: interval }),
    z.strictObject({ type: z.literal("WEEKLY"), intervalWeeks: interval, selection: weeklySelectionSchema }),
    z.strictObject({ type: z.literal("MONTHLY"), intervalMonths: interval, selection: monthlySelectionSchema }),
    z.strictObject({ type: z.literal("AFTER_COMPLETION"), intervalDays: interval }),
  ]),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
});
export const endConditionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("NEVER") }),
  z.strictObject({ type: z.literal("UNTIL_DATE"), date: localDateSchema }),
  z.strictObject({ type: z.literal("COUNT"), count: interval }),
]);
export type RoutineSchedule = z.output<typeof scheduleSchema>;
export type RoutineEndCondition = z.output<typeof endConditionSchema>;
export type WeeklySelection = z.output<typeof weeklySelectionSchema>;
export type MonthlySelection = z.output<typeof monthlySelectionSchema>;

// These helpers normalize a single supplied window; they do not enumerate occurrences.
export function weeklyWindows(selection: WeeklySelection) {
  return selection.type === "DAYS"
    ? selection.weekdays.map((day) => ({ startWeekday: day, endWeekday: day }))
    : [{ startWeekday: selection.startWeekday, endWeekday: selection.endWeekday }];
}
export function monthlyWindow(year: number, month: number, selection: MonthlySelection) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("Invalid calendar month.");
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (selection.type === "LAST_DAY") return { startDay: last, endDay: last };
  const start = selection.type === "DAY" ? selection.day : selection.startDay;
  const end = selection.type === "DAY" ? selection.day : selection.endDay;
  if (selection.shortMonthPolicy === "SKIP" && end > last) return null;
  return { startDay: Math.min(start, last), endDay: Math.min(end, last) };
}
export function clipLocalDateWindow(window: { startDate: string; endDate: string }, startDate: string, end: RoutineEndCondition) {
  localDateSchema.parse(window.startDate);
  localDateSchema.parse(window.endDate);
  localDateSchema.parse(startDate);
  const lower = window.startDate > startDate ? window.startDate : startDate;
  const upper = end.type === "UNTIL_DATE" && end.date < window.endDate ? end.date : window.endDate;
  return lower <= upper ? { startDate: lower, endDate: upper } : null;
}
