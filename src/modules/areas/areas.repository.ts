import { Prisma, type Area, type PrismaClient } from "../../generated/prisma/client";
import { getPrisma } from "../../infrastructure/database/prisma";
import { lockArea } from "./area-lock";
import { createRoutineQueries } from "../tasks/routines/routines.repository";

function createAreaQueries(db: Prisma.TransactionClient) {
  return {
    routines: createRoutineQueries(db),
    findForUpdate(id: string) { return lockArea(db, id); },
    create(data: Prisma.AreaCreateInput) { return db.area.create({ data }); },
    update(id: string, data: Prisma.AreaUpdateInput) { return db.area.update({ where: { id }, data }); },
    findLinkedTasks(areaId: string) {
      // Include archived and soft-deleted tasks; write-lock in stable ID order.
      return db.task.findMany({ where: { areaId }, orderBy: { id: "asc" }, select: { id: true } });
    },
    clearTaskArea(id: string) {
      // Prisma updates updatedAt as part of this write.
      return db.task.update({ where: { id }, data: { areaId: null } });
    },
    createAreaChanged(taskId: string, area: Pick<Area, "id" | "name">) {
      return db.taskAction.create({ data: {
        taskId, type: "AREA_CHANGED",
        metadata: {
          before: { areaId: area.id, area: { id: area.id, name: area.name } },
          after: { areaId: null, area: null },
        },
      } });
    },
    remove(id: string) { return db.area.delete({ where: { id } }); },
  };
}
export type AreasTransactionRepository = ReturnType<typeof createAreaQueries>;
export class AreasTransactionConflictError extends Error {}

export function createAreasRepository(client: () => PrismaClient = getPrisma) {
  return {
    findMany() {
      return client().area.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] });
    },
    async transaction<T>(work: (tx: AreasTransactionRepository) => Promise<T>): Promise<T> {
      const db = client();
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction((tx) => work(createAreaQueries(tx)), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          });
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") throw error;
          if (attempt >= 2) throw new AreasTransactionConflictError();
        }
      }
    },
  };
}
export type AreasRepository = ReturnType<typeof createAreasRepository>;
