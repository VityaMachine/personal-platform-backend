import { Temporal } from "@js-temporal/polyfill";
import { clipLocalDateWindow, monthlyWindow, weeklyWindows, type RoutineEndCondition, type RoutineSchedule } from "./routines.schedule";
import { completionPreviewContextSchema, type CompletionPreviewContext } from "../routines.preview.schemas";
import { completionCalendarDate } from "./routines.completion-calendar";

export const PREVIEW_PERIOD_BUDGET = 10_000;
export type PauseInterval = { startDate: string; endDate: string | null }; // [start, end), local dates
export type PreviewRoutine = {
  id: string; timezone: string; startDate: string; schedule: RoutineSchedule; endCondition: RoutineEndCondition;
};
export type PreviewOccurrence = {
  occurrenceKey: string; startDate: string; endDate: string; timezone: string; localTime: string | null;
  instant: string | null; diagnostics: ("NONEXISTENT_LOCAL_TIME" | "AMBIGUOUS_LOCAL_TIME")[];
};
export type PreviewOptions = {
  pauses: readonly PauseInterval[]; // normalized, sorted, disjoint intervals
  countReliable: boolean;
  limitations?: readonly string[];
  completionContext?: CompletionPreviewContext;
  periodBudget?: number;
};

function scheduledInstant(date: string, time: string | null, timezone: string): Pick<PreviewOccurrence, "instant" | "diagnostics"> {
  if (time === null) return { instant: null, diagnostics: [] };
  const local = Temporal.PlainDate.from(date).toPlainDateTime(time);
  const earlier = local.toZonedDateTime(timezone, { disambiguation: "earlier" });
  const later = local.toZonedDateTime(timezone, { disambiguation: "later" });
  if (earlier.epochNanoseconds !== later.epochNanoseconds) {
    return { instant: null, diagnostics: [earlier.toPlainDateTime().equals(local)
      ? "AMBIGUOUS_LOCAL_TIME" : "NONEXISTENT_LOCAL_TIME"] };
  }
  return { instant: earlier.toInstant().toString(), diagnostics: [] };
}

/** Read-only projection of the current configuration, never a reconstruction of historical executions.
 * Inputs are validated Routine/query data and normalized local pause intervals. No clock or I/O.
 */
export function calculateRoutinePreview(routine: PreviewRoutine, from: string, to: string, limit: number, options: PreviewOptions) {
  const limitations = new Set(["CURRENT_CONFIGURATION_PROJECTION", ...options.limitations ?? []]);
  const occurrences: PreviewOccurrence[] = [];
  let truncated = false;
  const result = () => ({ routineId: routine.id, timezone: routine.timezone, from, to,
    occurrences, truncated, limitations: [...limitations] });
  const rule = routine.schedule.recurrence;
  const context = options.completionContext ? completionPreviewContextSchema.parse(options.completionContext) : undefined;
  if (context && rule.type !== "AFTER_COMPLETION") throw new RangeError("Completion context requires AFTER_COMPLETION.");
  const completedDate = context ? Temporal.Instant.from(context.completedAt).toZonedDateTimeISO(routine.timezone).toPlainDate() : undefined;
  if (completedDate && Temporal.PlainDate.compare(completedDate, routine.startDate) < 0) {
    throw new RangeError("Completion must not precede Routine startDate.");
  }
  if (rule.type === "AFTER_COMPLETION") limitations.add("FUTURE_COMPLETIONS_REQUIRED");
  if (routine.endCondition.type === "COUNT" && !options.countReliable) {
    limitations.add("COUNT_HISTORY_UNCERTAIN");
    return result();
  }
  function paused(date: string) {
    let low = 0, high = options.pauses.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (options.pauses[middle].startDate <= date) low = middle + 1;
      else high = middle;
    }
    const interval = options.pauses[low - 1];
    return Boolean(interval && (interval.endDate === null || date < interval.endDate));
  }
  let number = 0;
  function accept(start: string, end: string, identity: string) {
    const window = clipLocalDateWindow({ startDate: start, endDate: end }, routine.startDate, routine.endCondition);
    if (!window || paused(window.startDate)) return false;
    number++;
    if (routine.endCondition.type === "COUNT" && number > routine.endCondition.count) return true;
    if (window.startDate <= to && window.endDate >= from) {
      if (occurrences.length === limit) { truncated = true; return true; }
      occurrences.push({ occurrenceKey: `v1:${routine.id}:${identity}`, ...window, timezone: routine.timezone,
        localTime: routine.schedule.localTime, ...scheduledInstant(window.startDate, routine.schedule.localTime, routine.timezone) });
    }
    return routine.endCondition.type === "COUNT" && number === routine.endCondition.count;
  }
  if (rule.type === "AFTER_COMPLETION") {
    const candidate = completionCalendarDate(routine, rule.intervalDays, context);
    if (candidate.date === null) { limitations.add(candidate.limitation!); return result(); }
    number = candidate.occurrenceNumber - 1;
    accept(candidate.date, candidate.date, `completion:${candidate.occurrenceNumber}`);
    return result();
  }
  const start = Temporal.PlainDate.from(routine.startDate);
  const upper = routine.endCondition.type === "UNTIL_DATE" && routine.endCondition.date < to ? routine.endCondition.date : to;
  if (upper < routine.startDate) return result();
  const lower = from < routine.startDate ? routine.startDate : from;
  const first = Temporal.PlainDate.from(lower);
  const last = Temporal.PlainDate.from(upper);
  const anchor = rule.type === "WEEKLY" ? start.subtract({ days: start.dayOfWeek - 1 })
    : rule.type === "MONTHLY" ? start.with({ day: 1 }) : start;
  const distance = (date: Temporal.PlainDate) => rule.type === "MONTHLY"
    ? (date.year - anchor.year) * 12 + date.month - anchor.month : anchor.until(date).days;
  const step = rule.type === "DAILY" ? rule.intervalDays : rule.type === "WEEKLY" ? rule.intervalWeeks * 7 : rule.intervalMonths;
  // COUNT needs the ordinal from the origin; other modes seek directly to the intersecting period.
  let period = routine.endCondition.type === "COUNT" ? 0 : Math.max(0, Math.floor(distance(first) / step));
  const lastPeriod = Math.floor(distance(last) / step);
  let remaining = options.periodBudget ?? PREVIEW_PERIOD_BUDGET;
  for (; period <= lastPeriod; period++) {
    if (remaining-- <= 0) { limitations.add("COMPUTATION_BUDGET_EXCEEDED"); break; }
    const base = rule.type === "MONTHLY" ? anchor.add({ months: period * step }) : anchor.add({ days: period * step });
    if (rule.type === "DAILY") {
      if (accept(base.toString(), base.toString(), `daily:${base}`)) break;
    } else if (rule.type === "WEEKLY") {
      for (const window of weeklyWindows(rule.selection)) {
        const a = base.add({ days: window.startWeekday - 1 });
        // The last ISO week may extend beyond the public YYYY-MM-DD date domain.
        if (a.year > 9999) break;
        const b = base.add({ days: window.endWeekday - 1 });
        if (b.year > 9999 && routine.endCondition.type !== "UNTIL_DATE") {
          limitations.add("CALENDAR_RANGE_EXCEEDED"); continue;
        }
        const end = b.year > 9999 && routine.endCondition.type === "UNTIL_DATE" ? routine.endCondition.date : b.toString();
        if (accept(a.toString(), end, `weekly:${base}:${window.startWeekday}-${window.endWeekday}`)) return result();
      }
    } else {
      const window = monthlyWindow(base.year, base.month, rule.selection);
      if (window && accept(base.with({ day: window.startDay }).toString(), base.with({ day: window.endDay }).toString(), `monthly:${base}`)) break;
    }
  }
  return result();
}
