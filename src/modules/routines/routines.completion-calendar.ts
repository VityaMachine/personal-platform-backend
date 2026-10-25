import { Temporal } from "@js-temporal/polyfill";
import type { CompletionPreviewContext } from "./routines.preview.schemas";

/** Shared pure arithmetic for preview simulations and persisted completion-based generation. */
export function completionCalendarDate(
  routine: { startDate: string; timezone: string }, intervalDays: number, context?: CompletionPreviewContext,
) {
  if (!context) return { date: routine.startDate, occurrenceNumber: 1, limitation: null };
  const local = Temporal.Instant.from(context.completedAt).toZonedDateTimeISO(routine.timezone).toPlainDate();
  if (Temporal.PlainDate.compare(local, routine.startDate) < 0) throw new RangeError("Completion must not precede Routine startDate.");
  if (local.until(Temporal.PlainDate.from("9999-12-31")).days < intervalDays) {
    return { date: null, occurrenceNumber: context.completedOccurrenceNumber + 1, limitation: "CALENDAR_RANGE_EXCEEDED" };
  }
  return { date: local.add({ days: intervalDays }).toString(), occurrenceNumber: context.completedOccurrenceNumber + 1, limitation: null };
}
