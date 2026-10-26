import type { RoutineAction } from "../../generated/prisma/client";
import type { GenerationRange, GenerationRoutine } from "./routines.generate";
import { readGenerationHistory, generationConflict } from "./routines.generate";
import { normalizePreviewHistory } from "./routines.preview-history";
import { calculateVersionedCandidates, type ScheduleVersion } from "./routines.versions";
import { reconcileVersionWindows, type StoredVersionOccurrence } from "./routines.version-conflicts";
import type { ResolvedGenerationOccurrence } from "./routines.generation-resolver";

/** Multi-version materialization uses a Routine-wide COUNT budget, reserving every saved execution. */
export function resolveVersionedCalendar(
  routine: GenerationRoutine, actions: readonly RoutineAction[], versions: readonly ScheduleVersion[],
  stored: readonly StoredVersionOccurrence[], range: GenerationRange, strict: boolean,
) {
  if (strict) readGenerationHistory(routine, actions, true);
  if (stored.length > 10_000) generationConflict("Stored occurrence budget exceeded; partial overlap checks are not allowed.");
  if (stored.some((entry) => !entry.task)) generationConflict("Stored Routine occurrence has no Task. Generation requires repair.");
  // COUNT is a lifetime cap across all materialized versions, not a new ordinal per version.
  const countPreview = calculateVersionedCandidates(routine, versions.map((version) => version.endCondition.type === "COUNT"
    ? { ...version, endCondition: { type: "NEVER" as const } } : version), range.from, range.to,
  (version) => normalizePreviewHistory({ ...routine, ...version }, actions, true));
  if (strict && (countPreview.truncated || countPreview.limitations.some((code) => code !== "CURRENT_CONFIGURATION_PROJECTION"))) {
    generationConflict(`Versioned calendar is incomplete: ${countPreview.limitations.join(", ")}.`);
  }
  // Restore actual end conditions after calendar enumeration.
  const candidates = countPreview.candidates.map((entry) => ({ ...entry, version: versions.find((version) => version.id === entry.version.id)! }));
  const { accepted, conflicts, retained } = reconcileVersionWindows(candidates, stored, (entry, acceptedCount) =>
    entry.version.endCondition.type !== "COUNT" || stored.length + acceptedCount < entry.version.endCondition.count);
  const resolved: ResolvedGenerationOccurrence[] = stored.filter((entry) => retained.has(entry.id)
    || (entry.startDate <= range.to && entry.endDate >= range.from)).map((entry) => ({
    existingTaskId: entry.task!.id,
    occurrence: { occurrenceKey: entry.occurrenceKey, startDate: entry.startDate, endDate: entry.endDate,
      timezone: entry.timezone, localTime: entry.localTime, instant: entry.instant?.toISOString() ?? null, diagnostics: [] },
    scheduleVersion: versions.find((version) => version.id === entry.scheduleVersionId),
  }));
  for (const entry of accepted) {
    if (strict && entry.occurrence.diagnostics.length) generationConflict("Routine has unresolved DST local times. No Tasks were generated.");
    resolved.push({ occurrence: entry.occurrence, scheduleVersion: entry.version, existingTaskId: null });
  }
  resolved.sort((a, b) => a.occurrence.startDate.localeCompare(b.occurrence.startDate)
    || a.occurrence.occurrenceKey.localeCompare(b.occurrence.occurrenceKey));
  if (strict && resolved.filter((entry) => entry.existingTaskId === null).length > 100) generationConflict("Generation would create more than 100 new Tasks.");
  return { candidates: resolved, conflicts, truncated: countPreview.truncated, limitations: countPreview.limitations };
}
