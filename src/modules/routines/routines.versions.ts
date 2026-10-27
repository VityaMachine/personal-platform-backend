import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import type { RoutineScheduleVersion, RoutineAction } from "../../generated/prisma/client";
import { ApiError } from "../../lib/api-error";
import { endConditionSchema, localDateSchema, scheduleSchema, timezoneSchema } from "./routines.schedule";
import { calculateRoutinePreview, type PreviewOccurrence, type PreviewOptions, type PreviewRoutine } from "./routines.preview";
import type { CompletionPreviewContext } from "./routines.preview.schemas";
import { routineActionMetadataSchema } from "./routines.mapper";

export const VERSION_BUDGET = 100;
export const calendarVersionSchema = z.strictObject({
  timezone: timezoneSchema, startDate: localDateSchema, schedule: scheduleSchema, endCondition: endConditionSchema,
}).refine((value) => value.endCondition.type !== "UNTIL_DATE" || value.endCondition.date >= value.startDate,
  "End date must not precede startDate.");
export const createScheduleVersionSchema = calendarVersionSchema.safeExtend({ effectiveDate: localDateSchema });
export type CalendarConfiguration = z.output<typeof calendarVersionSchema>;
export type CreateScheduleVersionInput = z.output<typeof createScheduleVersionSchema>;
export type ScheduleVersion = Omit<RoutineScheduleVersion, "schedule" | "endCondition"> & CalendarConfiguration;
export type VersionedOccurrence = { occurrence: PreviewOccurrence; version: ScheduleVersion };
export function calendarSnapshot(value: { timezone: string; startDate: string; schedule: unknown; endCondition: unknown }) {
  return calendarVersionSchema.parse({ timezone: value.timezone, startDate: value.startDate,
    schedule: value.schedule, endCondition: value.endCondition });
}
export function versionConflict(message: string): never { throw new ApiError(409, message); }

export function versionMidnight(date: string, timezone: string) {
  return Temporal.PlainDate.from(date).toZonedDateTime(timezone).toInstant();
}
export function parseScheduleVersions(rows: readonly RoutineScheduleVersion[]): ScheduleVersion[] {
  if (!rows.length || rows.length > VERSION_BUDGET) versionConflict("Schedule version history is missing or exceeds its budget.");
  const versions = rows.map((row) => ({ ...row, ...calendarVersionSchema.parse({
    timezone: row.timezone, startDate: row.startDate, schedule: row.schedule, endCondition: row.endCondition,
  }) }));
  for (const [index, version] of versions.entries()) {
    const previous = versions[index - 1];
    if (version.number !== index + 1 || (previous && (version.effectiveDate <= previous.effectiveDate
      || version.effectiveAt <= previous.effectiveAt || version.effectiveTimezone !== previous.effectiveTimezone))) {
      versionConflict("Schedule version history is inconsistent.");
    }
  }
  return versions;
}

export function validateScheduleVersionHistory(routine: PreviewRoutine, versions: readonly ScheduleVersion[], actions: readonly RoutineAction[]) {
  if (JSON.stringify(calendarSnapshot(routine)) !== JSON.stringify(calendarSnapshot(versions.at(-1)!))) {
    versionConflict("Routine calendar does not match its latest stored version.");
  }
  for (const [index, version] of versions.entries()) {
    if (index === 0) continue; // Backfilled first versions deliberately do not fabricate journal events.
    const events = actions.filter((action) => action.type === "SCHEDULE_VERSION_CREATED")
      .map((action) => routineActionMetadataSchema.parse(action.metadata)).filter((metadata) => metadata.scheduleVersionId === version.id);
    if (events.length !== 1 || events[0].effectiveDate !== version.effectiveDate || events[0].versionNumber !== version.number
      || JSON.stringify(calendarSnapshot(events[0].after)) !== JSON.stringify(calendarSnapshot(version))
      || !events[0].before || JSON.stringify(calendarSnapshot(events[0].before)) !== JSON.stringify(calendarSnapshot(versions[index - 1]))) {
      versionConflict("Stored schedule version is missing its matching configuration history.");
    }
  }
}

/** Ownership is determined by the whole window's local midnight, never by clipping its end. */
export function ownsWindow(versions: readonly ScheduleVersion[], index: number, occurrence: Pick<PreviewOccurrence, "startDate" | "timezone">) {
  const start = versionMidnight(occurrence.startDate, occurrence.timezone).epochMilliseconds;
  return (index === 0 || start >= versions[index].effectiveAt.getTime())
    && (index + 1 === versions.length || start < versions[index + 1].effectiveAt.getTime());
}
export function versionedKey(key: string, version: ScheduleVersion) {
  // Keep legacy keys. New version keys also invalidate stale completion planning;
  // chain uniqueness remains enforced by occurrenceNumber and previousOccurrenceId.
  return version.number === 1 ? key : `${key}:schedule:${version.number}`;
}

/** Shared version resolver for simulations and persisted generation. */
export function calculateVersionedCandidates(
  routine: PreviewRoutine, versions: readonly ScheduleVersion[], from: string, to: string,
  optionsFor: (version: ScheduleVersion) => PreviewOptions,
  rangeFor?: (version: ScheduleVersion) => { from: string; to: string },
) {
  const candidates: VersionedOccurrence[] = [], limitations = new Set<string>();
  let truncated = false;
  for (const [index, version] of versions.entries()) {
    const range = rangeFor?.(version) ?? { from, to };
    const result = calculateRoutinePreview({ ...routine, ...version, id: routine.id }, range.from, range.to, 500, optionsFor(version));
    for (const limitation of result.limitations) limitations.add(limitation);
    truncated ||= result.truncated;
    for (const occurrence of result.occurrences) if (ownsWindow(versions, index, occurrence)) {
      candidates.push({ occurrence: { ...occurrence, occurrenceKey: versionedKey(occurrence.occurrenceKey, version) }, version });
    }
  }
  candidates.sort((a, b) => Temporal.Instant.compare(versionMidnight(a.occurrence.startDate, a.occurrence.timezone),
    versionMidnight(b.occurrence.startDate, b.occurrence.timezone)) || a.version.number - b.version.number
    || a.occurrence.occurrenceKey.localeCompare(b.occurrence.occurrenceKey));
  return { candidates, limitations: [...limitations], truncated };
}

export function resolveCompletionVersion(
  routine: PreviewRoutine, versions: readonly ScheduleVersion[], optionsFor: (version: ScheduleVersion) => PreviewOptions,
  completionContext?: CompletionPreviewContext,
) {
  const selectionVersions = versions.map((version) => ({ ...version, endCondition: { type: "NEVER" as const } }));
  const result = calculateVersionedCandidates(routine, selectionVersions, "0001-01-01", "9999-12-31",
    (version) => ({ ...optionsFor(version), pauses: [], countReliable: true, completionContext }));
  const selected = result.candidates[0];
  const candidate = selected ? { ...selected, version: versions.find((version) => version.id === selected.version.id)! } : undefined;
  if (!candidate && result.limitations.includes("CALENDAR_RANGE_EXCEEDED")) versionConflict("Completion calendar is outside the supported range.");
  return { ...result, candidate };
}
