import { Temporal } from "@js-temporal/polyfill";

/** Local calendar arithmetic at an explicitly supplied instant, including DST. */
export function taskLocalDate(instant: Temporal.Instant, timezone: string) {
  return instant.toZonedDateTimeISO(timezone).toPlainDate();
}

export function daysSinceOccurrenceEnd(
  occurrence: { endDate: string; timezone: string }, instant: Temporal.Instant,
) {
  return Temporal.PlainDate.from(occurrence.endDate).until(taskLocalDate(instant, occurrence.timezone)).days;
}
