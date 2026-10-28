import { Temporal } from "@js-temporal/polyfill";
import type { PreviewOccurrence } from "./routines.preview";
import { versionMidnight, type VersionedOccurrence } from "./routines.versions";

type Window = Pick<PreviewOccurrence, "startDate" | "endDate" | "timezone">;
export type StoredVersionOccurrence = Window & { id: string; occurrenceKey: string; scheduleVersionId: string;
  localTime: string | null; instant: Date | null; task: { id: string } | null };
export type WindowConflict = { code: "STORED_WINDOW_CONFLICT" | "VERSION_WINDOW_CONFLICT";
  occurrenceKey: string; retainedOccurrenceKey: string; retainedTaskId: string | null };
function calendarWindow(value: Window) {
  return { start: versionMidnight(value.startDate, value.timezone),
    end: Temporal.PlainDate.from(value.endDate).add({ days: 1 }).toZonedDateTime(value.timezone).toInstant() };
}
export function windowsOverlap(a: Window, b: Window) {
  const left = calendarWindow(a), right = calendarWindow(b);
  return Temporal.Instant.compare(left.start, right.end) < 0 && Temporal.Instant.compare(right.start, left.end) < 0;
}
/** Stored windows always win; otherwise the earliest candidate wins. No Task state is consulted. */
export function reconcileVersionWindows(candidates: readonly VersionedOccurrence[], stored: readonly StoredVersionOccurrence[],
  canAccept: (candidate: VersionedOccurrence, acceptedCount: number) => boolean = () => true,
) {
  const accepted: VersionedOccurrence[] = [], conflicts: WindowConflict[] = [];
  const retained = new Set<string>();
  const orderedStored = [...stored].sort((a, b) => Temporal.Instant.compare(versionMidnight(a.startDate, a.timezone),
    versionMidnight(b.startDate, b.timezone)) || a.occurrenceKey.localeCompare(b.occurrenceKey) || a.id.localeCompare(b.id));
  for (const candidate of candidates) {
    const same = orderedStored.find((entry) => entry.occurrenceKey === candidate.occurrence.occurrenceKey);
    if (same) { retained.add(same.id); continue; }
    if (!canAccept(candidate, accepted.length)) continue;
    const occupied = orderedStored.find((entry) => windowsOverlap(candidate.occurrence, entry));
    const earlier = accepted.find((entry) => windowsOverlap(candidate.occurrence, entry.occurrence));
    if (occupied || earlier) {
      if (occupied) retained.add(occupied.id);
      conflicts.push({ code: occupied ? "STORED_WINDOW_CONFLICT" : "VERSION_WINDOW_CONFLICT",
        occurrenceKey: candidate.occurrence.occurrenceKey,
        retainedOccurrenceKey: occupied?.occurrenceKey ?? earlier!.occurrence.occurrenceKey,
        retainedTaskId: occupied?.task?.id ?? null });
    } else accepted.push(candidate);
  }
  return { accepted, conflicts, retained };
}
