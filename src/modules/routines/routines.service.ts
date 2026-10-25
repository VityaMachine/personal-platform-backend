import { ApiError } from "../../lib/api-error";
import { toRoutineActionResponse, toRoutineResponse } from "./routines.mapper";
import { RoutinesTransactionConflictError, type RoutinesRepository, type RoutinesTransactionRepository } from "./routines.repository";
import { routineStateSchema, type CreateRoutineInput, type UpdateRoutineInput, type RoutineState } from "./routines.schemas";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function createRoutinesService(repository: RoutinesRepository, now: () => Date = () => new Date()) {
  async function transaction<T>(work: (tx: RoutinesTransactionRepository) => Promise<T>): Promise<T> {
    try { return await repository.transaction(work); }
    catch (error) {
      if (error instanceof RoutinesTransactionConflictError) throw new ApiError(409, "Routine changed concurrently. Retry the request.");
      throw error;
    }
  }
  async function find(id: string, tx: RoutinesTransactionRepository) {
    const routine = await tx.findFirst(id);
    if (!routine) throw new ApiError(404, "Routine not found.");
    return toRoutineResponse(routine);
  }
  async function checkArea(areaId: string | null, tx: RoutinesTransactionRepository) {
    if (areaId && !await tx.findArea(areaId)) throw new ApiError(404, "Area not found.");
  }
  function state(routine: Awaited<ReturnType<typeof find>>): RoutineState {
    return routineStateSchema.parse({
      title: routine.title, description: routine.description, priority: routine.priority, areaId: routine.areaId,
      estimatedDurationMinutes: routine.estimatedDurationMinutes, timezone: routine.timezone,
      startDate: routine.startDate, schedule: routine.schedule, endCondition: routine.endCondition,
      subtasks: routine.subtasks.map(({ title, estimatedDurationMinutes }) => ({ title, estimatedDurationMinutes })),
    });
  }
  return {
    list() { return transaction(async (tx) => (await tx.findMany({ deletedAt: null })).map(toRoutineResponse)); },
    get(id: string) { return transaction((tx) => find(id, tx)); },
    create(input: CreateRoutineInput) {
      return transaction(async (tx) => {
        const { subtasks, ...fields } = routineStateSchema.parse(input);
        await checkArea(fields.areaId, tx);
        const routine = await tx.create(fields);
        if (subtasks.length) await tx.replaceSubtasks(routine.id, subtasks);
        const after = await find(routine.id, tx);
        await tx.createAction(routine.id, "CREATED", { before: null, after });
        return after;
      });
    },
    update(id: string, input: UpdateRoutineInput) {
      return transaction(async (tx) => {
        const before = await find(id, tx);
        const previous = state(before);
        const { paused, ...patch } = input;
        // Validate the entire merged state before any writes, including overflow.
        const next = routineStateSchema.parse({ ...previous, ...patch });
        if (patch.areaId) await checkArea(patch.areaId, tx);
        const changed = !same(previous, next);
        const pauseChanged = paused !== undefined && paused !== Boolean(before.pausedAt);
        if (!changed && !pauseChanged) return before;
        const { subtasks, areaId, ...fields } = next;
        await tx.update(id, { ...fields, ...(patch.areaId !== undefined ? { areaId } : {}),
          ...(pauseChanged ? { pausedAt: paused ? now() : null } : {}) });
        if (!same(previous.subtasks, subtasks)) await tx.replaceSubtasks(id, subtasks);
        const after = await find(id, tx);
        if (changed) await tx.createAction(id, "UPDATED", { before, after });
        if (pauseChanged) await tx.createAction(id, paused ? "PAUSED" : "RESUMED", { before, after });
        return after;
      });
    },
    remove(id: string) {
      return transaction(async (tx) => {
        const before = await find(id, tx);
        const after = toRoutineResponse(await tx.update(id, { deletedAt: now() }));
        await tx.createAction(id, "DELETED", { before, after });
      });
    },
    history(id: string) {
      return transaction(async (tx) => { await find(id, tx); return (await tx.findHistory(id)).map(toRoutineActionResponse); });
    },
  };
}
export type RoutinesService = ReturnType<typeof createRoutinesService>;
