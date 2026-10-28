import type { Area, Prisma } from "../generated/prisma/client";
import { ApiError } from "../http/api-error";
import { AreasTransactionConflictError, type AreasRepository } from "../modules/areas/areas.repository";

export function createDeleteArea(
  repository: Pick<AreasRepository, "transaction">,
  detachAreaLinks: (client: Prisma.TransactionClient, area: Pick<Area, "id" | "name">) => Promise<void>,
) {
  return async function deleteArea(id: string): Promise<void> {
    try {
      await repository.transaction(async (areas, client) => {
        const area = await areas.findForUpdate(id);
        if (!area) throw new ApiError(404, "Area not found.");
        await detachAreaLinks(client, area);
        await areas.remove(id);
      });
    } catch (error) {
      if (error instanceof AreasTransactionConflictError) {
        throw new ApiError(409, "Area changed concurrently. Retry the request.");
      }
      throw error;
    }
  };
}
