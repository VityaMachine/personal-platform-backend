import { ApiError } from "../../lib/api-error";
import type { RoutineAction } from "../../generated/prisma/client";
import { MAX_NEW_ROUTINE_TASKS, generationConflict, planRoutineGeneration, type GenerationRange, type GenerationRoutine, type GenerateRoutineInput } from "./routines.generate";
import { resolveCompletionGeneration, type CompletionChainFields } from "./routines.generate-completion";
import type { PreviewOccurrence } from "./routines.preview";
import type { RoutinesTransactionRepository } from "./routines.repository";
import { parseScheduleVersions, validateScheduleVersionHistory, type ScheduleVersion } from "./routines.versions";
import { resolveVersionedCalendar } from "./routines.versioned-calendar";
import type { WindowConflict } from "./routines.version-conflicts";
import type { AutomaticGeneration } from "./routines.auto-range";

export type ResolvedGenerationOccurrence = {
  occurrence: PreviewOccurrence;
  existingTaskId: string | null;
  chain?: CompletionChainFields;
  scheduleVersion?: ScheduleVersion;
};

/** Candidate resolution only: queries/locks in the caller's transaction, never writes. */
export async function resolveRoutineGeneration(
  routine: GenerationRoutine, actions: readonly RoutineAction[], range: GenerationRange,
  tx: RoutinesTransactionRepository, asOf: Date,
  automatic?: AutomaticGeneration,
): Promise<{ candidates: ResolvedGenerationOccurrence[]; conflicts: WindowConflict[] }> {
  const versions = parseScheduleVersions(await tx.findScheduleVersions(routine.id));
  validateScheduleVersionHistory(routine, versions, actions);
  if (routine.schedule.recurrence.type === "AFTER_COMPLETION") {
    return { candidates: await resolveCompletionGeneration(routine, actions, range, tx, asOf, versions, Boolean(automatic)), conflicts: [] };
  }
  if (versions.length > 1) return resolveVersionedCalendar(routine, actions, versions,
    await tx.findCompletionChain(routine.id, 10_001), range, true, automatic);
  const candidates = planRoutineGeneration(routine, actions, range);
  const stored = candidates.length ? await tx.findOccurrences(routine.id, candidates.map((entry) => entry.occurrenceKey)) : [];
  const byKey = new Map(stored.map((entry) => [entry.occurrenceKey, entry]));
  if (candidates.filter((entry) => !byKey.has(entry.occurrenceKey)).length > MAX_NEW_ROUTINE_TASKS) {
    generationConflict("Generation would create more than 100 new Tasks. Request a smaller range.");
  }
  if (stored.some((entry) => !entry.task)) generationConflict("Stored Routine occurrence has no Task. Generation requires repair.");
  return { candidates: candidates.map((occurrence) => ({ occurrence, scheduleVersion: versions[0],
    existingTaskId: byKey.get(occurrence.occurrenceKey)?.task?.id ?? null })), conflicts: [] };
}

export function validateGenerationPlanning(
  routine: GenerationRoutine, candidates: readonly ResolvedGenerationOccurrence[], planning: GenerateRoutineInput["planning"],
) {
  if (routine.schedule.recurrence.type === "AFTER_COMPLETION" && (planning?.length ?? 0) > 1) {
    throw new ApiError(400, "AFTER_COMPLETION planning accepts at most one occurrence.");
  }
  const allowed = new Set(candidates.map((entry) => entry.occurrence.occurrenceKey));
  if (planning?.some((entry) => !allowed.has(entry.occurrenceKey))) {
    throw new ApiError(400, "Planning contains an occurrence not available for this Routine and range. Refresh generation-preview and retry.");
  }
  return new Map(planning?.map((entry) => [entry.occurrenceKey, entry.plannedAt]) ?? []);
}
