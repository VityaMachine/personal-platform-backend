import type { RoutineAction } from "../../generated/prisma/client";
import { COMPLETION_HISTORY_BUDGET, verifiedTaskCompletion } from "../tasks/tasks.completion";
import { completionCalendarDate } from "./routines.completion-calendar";
import { calculateRoutinePreview } from "./routines.preview";
import { generationConflict, readGenerationHistory, type GenerationRange, type GenerationRoutine } from "./routines.generate";
import type { RoutinesTransactionRepository } from "./routines.repository";
import type { ResolvedGenerationOccurrence } from "./routines.generation-resolver";

export const COMPLETION_CHAIN_BUDGET = 10_000;
export type CompletionChainFields = { occurrenceNumber: number; previousOccurrenceId: string | null; basisCompletedAt: Date | null };

export async function resolveCompletionGeneration(
  routine: GenerationRoutine, actions: readonly RoutineAction[], range: GenerationRange,
  tx: RoutinesTransactionRepository, asOf: Date,
): Promise<ResolvedGenerationOccurrence[]> {
  const { history, effectiveDate } = readGenerationHistory(routine, actions);
  const blocking = history.limitations.filter((code) => code !== "CONFIGURATION_CHANGED");
  if (blocking.length) generationConflict(`Routine history is uncertain: ${blocking.join(", ")}.`);
  const chain = await tx.findCompletionChain(routine.id, COMPLETION_CHAIN_BUDGET + 1);
  if (chain.length > COMPLETION_CHAIN_BUDGET) generationConflict("Completion chain budget exceeded. A partial chain cannot be generated.");
  for (const [index, occurrence] of chain.entries()) {
    if (occurrence.occurrenceNumber !== index + 1 || occurrence.previousOccurrenceId !== (chain[index - 1]?.id ?? null)
      || occurrence.occurrenceKey !== `v1:${routine.id}:completion:${index + 1}`
      || !occurrence.task || (index === 0 ? occurrence.basisCompletedAt !== null : occurrence.basisCompletedAt === null)) {
      generationConflict("Stored completion chain is inconsistent. Generation requires repair.");
    }
  }
  const existing: ResolvedGenerationOccurrence[] = chain.filter((entry) => entry.startDate <= range.to && entry.endDate >= range.from)
    .map((entry) => ({ existingTaskId: entry.task!.id, occurrence: { occurrenceKey: entry.occurrenceKey,
      startDate: entry.startDate, endDate: entry.endDate, timezone: entry.timezone, localTime: entry.localTime,
      instant: entry.instant?.toISOString() ?? null, diagnostics: [] } }));
  // COUNT counts persisted executions, including canceled/deleted tasks, not projected days.
  if (routine.endCondition.type === "COUNT" && chain.length >= routine.endCondition.count) return existing;
  if (routine.endCondition.type === "UNTIL_DATE" && range.from > routine.endCondition.date) return existing;
  if (range.to < routine.startDate) return existing;
  const latest = chain.at(-1);
  let completionContext: { completedAt: string; completedOccurrenceNumber: number } | undefined;
  let basisCompletedAt: Date | null = null;
  if (latest) {
    await tx.tasks.lock(latest.task!.id);
    // Include soft-deleted tasks so they stop the chain instead of becoming a missing/replaced task.
    const task = await tx.tasks.findFirst({ id: latest.task!.id });
    if (!task) generationConflict("The latest completion Task is missing. Generation requires repair.");
    if (task.deletedAt || task.status !== "DONE") {
      // A network retry finds its saved result even if that result is TODO/canceled/deleted now.
      if (existing.length) return existing;
      if (task.deletedAt) generationConflict("The latest Task is deleted. The completion chain is stopped; Tasks are not replaced.");
      if (task.status === "CANCELED") generationConflict("The latest Task is canceled. The completion chain is stopped.");
      generationConflict("The latest Task is not DONE. The completion chain is waiting for its completion.");
    }
    const completion = verifiedTaskCompletion(task, await tx.tasks.findCompletionActions(task.id, COMPLETION_HISTORY_BUDGET + 1), asOf);
    if (completion.completedAt === null) generationConflict(`Task completion history is uncertain: ${completion.issues.join(", ")}.`);
    basisCompletedAt = completion.completedAt;
    completionContext = { completedAt: basisCompletedAt.toISOString(), completedOccurrenceNumber: latest.occurrenceNumber! };
  }
  const rule = routine.schedule.recurrence;
  if (rule.type !== "AFTER_COMPLETION") throw new Error("Expected completion-based Routine.");
  let calendar: ReturnType<typeof completionCalendarDate>;
  try { calendar = completionCalendarDate(routine, rule.intervalDays, completionContext); }
  catch { return generationConflict("Completion precedes Routine startDate or is outside the supported calendar."); }
  if (calendar.date === null) generationConflict(`Completion calendar is incomplete: ${calendar.limitation}.`);
  const date = calendar.date;
  if (routine.endCondition.type === "UNTIL_DATE" && date > routine.endCondition.date) return existing;
  if (date < range.from || date > range.to) return existing;
  if (effectiveDate && date <= effectiveDate) generationConflict("Occurrence starts on or before the latest configuration change. Generation requires a later start.");
  if (history.pauses.some((pause) => pause.startDate <= date && (pause.endDate === null || date < pause.endDate))) {
    generationConflict("The completion occurrence falls in a past pause. A separate decision is required; its date is not shifted or skipped.");
  }
  const preview = calculateRoutinePreview(routine, range.from, range.to, 1, { ...history, countReliable: true, completionContext });
  const limitations = preview.limitations.filter((code) => !["CURRENT_CONFIGURATION_PROJECTION", "CONFIGURATION_CHANGED", "FUTURE_COMPLETIONS_REQUIRED"].includes(code));
  if (limitations.length || preview.truncated || preview.occurrences.length !== 1) {
    generationConflict(`Completion calendar is incomplete: ${limitations.join(", ") || "MISSING_CANDIDATE"}.`);
  }
  const candidate = preview.occurrences[0];
  if (candidate.diagnostics.length) generationConflict("Routine has unresolved DST local times. No Task was generated.");
  if (chain.length >= COMPLETION_CHAIN_BUDGET) generationConflict("Completion chain budget reached. Further generation requires a separate decision.");
  return [...existing, { occurrence: candidate, existingTaskId: null, chain: { occurrenceNumber: calendar.occurrenceNumber,
    previousOccurrenceId: latest?.id ?? null, basisCompletedAt } }];
}
