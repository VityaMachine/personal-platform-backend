import { ApiError } from "../../http/api-error";
import { AreasTransactionConflictError, type AreasRepository, type AreasTransactionRepository } from "./areas.repository";
import type { CreateAreaInput, UpdateAreaInput } from "./http/areas.schemas";

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
  };
}
export type AreasService = ReturnType<typeof createAreasService>;
