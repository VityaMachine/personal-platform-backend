import { ApiError } from "../../lib/api-error";
import type { RoutineAction } from "../../generated/prisma/client";
import { MAX_NEW_ROUTINE_TASKS, generationConflict, planRoutineGeneration, type GenerationRange, type GenerationRoutine, type GenerateRoutineInput } from "./routines.generate";
import { resolveCompletionGeneration, type CompletionChainFields } from "./routines.generate-completion";
import type { PreviewOccurrence } from "./routines.preview";
import type { RoutinesTransactionRepository } from "./routines.repository";

export type ResolvedGenerationOccurrence = {
  occurrence: PreviewOccurrence;
  existingTaskId: string | null;
  chain?: CompletionChainFields;
};

/** Candidate resolution only: queries/locks in the caller's transaction, never writes. */
export async function resolveRoutineGeneration(
  routine: GenerationRoutine, actions: readonly RoutineAction[], range: GenerationRange,
  tx: RoutinesTransactionRepository, asOf: Date,
): Promise<ResolvedGenerationOccurrence[]> {
  if (routine.schedule.recurrence.type === "AFTER_COMPLETION") return resolveCompletionGeneration(routine, actions, range, tx, asOf);
  const candidates = planRoutineGeneration(routine, actions, range);
  const stored = candidates.length ? await tx.findOccurrences(routine.id, candidates.map((entry) => entry.occurrenceKey)) : [];
  const byKey = new Map(stored.map((entry) => [entry.occurrenceKey, entry]));
  if (candidates.filter((entry) => !byKey.has(entry.occurrenceKey)).length > MAX_NEW_ROUTINE_TASKS) {
    generationConflict("Generation would create more than 100 new Tasks. Request a smaller range.");
  }
  if (stored.some((entry) => !entry.task)) generationConflict("Stored Routine occurrence has no Task. Generation requires repair.");
  return candidates.map((occurrence) => ({ occurrence, existingTaskId: byKey.get(occurrence.occurrenceKey)?.task?.id ?? null }));
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
