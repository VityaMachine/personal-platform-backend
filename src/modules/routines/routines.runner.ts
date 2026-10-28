import type { Logger } from "pino";
import { ApiError } from "../../http/api-error";
import type { RoutinesRepository } from "./routines.repository";
import type { RoutinesService } from "./routines.service";

export const RUNNER_LIMITS = { batchSize: 20, concurrency: 2, maxRoutines: 100, maxDurationMs: 60_000 } as const;
export type PassResult = { processed: number; created: number; existing: number; conflicts: number; errors: number;
  skipped: number; budgetExhausted: boolean; durationMs: number };
type Timer = { set: (callback: () => void, delay: number) => unknown; clear: (timer: unknown) => void };
const timers: Timer = { set: (callback, delay) => setTimeout(callback, delay), clear: (timer) => clearTimeout(timer as NodeJS.Timeout) };

/** Bounded admission; already admitted transactions drain before stop resolves. */
export function createRoutineRunner(dependencies: {
  repository: Pick<RoutinesRepository, "findAutomaticCandidates">;
  service: Pick<RoutinesService, "generateAutomatically">;
  logger: Pick<Logger, "info" | "warn">;
  clock?: () => number;
  timers?: Timer;
  limits?: { batchSize: number; concurrency: number; maxRoutines: number; maxDurationMs: number };
}) {
  const { repository, service, logger } = dependencies;
  const clock = dependencies.clock ?? Date.now;
  const timerApi = dependencies.timers ?? timers;
  const limits = dependencies.limits ?? RUNNER_LIMITS;
  let cursor: string | undefined;
  let stopped = false, started = false;
  let timer: unknown;
  let pending: Promise<PassResult> | undefined;
  // Bounded diagnostic suppression; expected waits return zero normally.
  const diagnostics = new Map<string, string>();
  function diagnose(routineId: string, error: unknown) {
    const diagnostic = error instanceof ApiError ? error.message : "GENERATION_FAILED";
    if (diagnostics.get(routineId) === diagnostic) return;
    if (diagnostics.size >= 1000) diagnostics.delete(diagnostics.keys().next().value!);
    diagnostics.set(routineId, diagnostic);
    logger.warn({ routineId, diagnostic }, "Routine automatic generation blocked");
  }
  async function pass(): Promise<PassResult> {
    const start = clock();
    const result: PassResult = { processed: 0, created: 0, existing: 0, conflicts: 0, errors: 0,
      skipped: 0, budgetExhausted: false, durationMs: 0 };
    const hasBudget = () => !stopped && result.processed < limits.maxRoutines && clock() - start < limits.maxDurationMs;
    try {
      while (hasBudget()) {
        const batch = await repository.findAutomaticCandidates(cursor, Math.min(limits.batchSize, limits.maxRoutines - result.processed));
        if (!batch.length) { cursor = undefined; break; }
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(limits.concurrency, batch.length) }, async () => {
          while (next < batch.length && hasBudget()) {
            const { id } = batch[next++];
            cursor = id; // Advance even on failure; never restart at the first failing Routine.
            result.processed++;
            try {
              const generated = await service.generateAutomatically(id);
              diagnostics.delete(id);
              if (!generated) { result.skipped++; continue; }
              result.created += generated.createdCount;
              result.existing += generated.existingCount;
              result.conflicts += generated.conflicts?.length ?? 0;
            } catch (error) { result.errors++; diagnose(id, error); }
          }
        }));
      }
      result.budgetExhausted = !stopped && (result.processed >= limits.maxRoutines || clock() - start >= limits.maxDurationMs);
    } catch (error) { result.errors++; diagnose("candidate-scan", error); }
    result.durationMs = Math.max(0, clock() - start);
    logger.info(result, "Routine automatic generation pass");
    return result;
  }
  function runOnce(): Promise<PassResult> {
    if (pending) return pending;
    pending = pass().finally(() => { pending = undefined; });
    return pending;
  }
  return {
    runOnce,
    start(intervalMs: number) {
      if (started || stopped) return;
      started = true;
      const tick = async () => {
        try { await runOnce(); }
        finally { if (!stopped) timer = timerApi.set(() => { void tick(); }, intervalMs); }
      };
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) timerApi.clear(timer);
      await pending;
    },
  };
}
