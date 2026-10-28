import { ApiError } from "../../http/api-error";
import { AreasTransactionConflictError, type AreasRepository, type AreasTransactionRepository } from "./areas.repository";
import type { CreateAreaInput, UpdateAreaInput } from "./areas.schemas";
import { toRoutineResponse } from "../routines/routines.mapper";

export function createAreasService(repository: AreasRepository) {
  async function transaction<T>(work: (tx: AreasTransactionRepository) => Promise<T>): Promise<T> {
    try {
      return await repository.transaction(work);
    } catch (error) {
      if (error instanceof AreasTransactionConflictError) {
        throw new ApiError(409, "Area changed concurrently. Retry the request.");
      }
      throw error;
    }
  }
  return {
    list() {
      return repository.findMany();
    },
    create(data: CreateAreaInput) { return transaction((tx) => tx.create(data)); },
    update(id: string, input: UpdateAreaInput) {
      return transaction(async (tx) => {
        const before = await tx.findForUpdate(id);
        if (!before) throw new ApiError(404, "Area not found.");
        return tx.update(id, { name: input.name });
      });
    },
    remove(id: string) {
      return transaction(async (tx) => {
        const area = await tx.findForUpdate(id);
        if (!area) throw new ApiError(404, "Area not found.");
        const tasks = await tx.findLinkedTasks(id);
        for (const task of tasks) {
          await tx.clearTaskArea(task.id);
          await tx.createAreaChanged(task.id, area);
        }
        const routines = await tx.routines.findLinked(id);
        for (const routine of routines) {
          const before = toRoutineResponse(routine);
          const after = toRoutineResponse(await tx.routines.update(routine.id, { areaId: null }));
          await tx.routines.createAction(routine.id, "UPDATED", { before, after });
        }
        await tx.remove(id);
      });
    },
  };
}
export type AreasService = ReturnType<typeof createAreasService>;
