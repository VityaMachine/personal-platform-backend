import type { Area, Prisma } from "../../generated/prisma/client";
import { createRoutineQueries } from "./routines/routines.repository";
import { toRoutineResponse } from "./routines/routines.mapper";

function createAreaLinkQueries(db: Prisma.TransactionClient) {
  return {
    routines: createRoutineQueries(db),
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
  };
}

/** The caller owns the transaction, Area lock and retries. Preserve Tasks-before-Routines writes. */
export async function detachAreaLinks(client: Prisma.TransactionClient, area: Pick<Area, "id" | "name">) {
  const tx = createAreaLinkQueries(client);
  const tasks = await tx.findLinkedTasks(area.id);
  for (const task of tasks) {
    await tx.clearTaskArea(task.id);
    await tx.createAreaChanged(task.id, area);
  }
  const routines = await tx.routines.findLinked(area.id);
  for (const routine of routines) {
    const before = toRoutineResponse(routine);
    const after = toRoutineResponse(await tx.routines.update(routine.id, { areaId: null }));
    await tx.routines.createAction(routine.id, "UPDATED", { before, after });
  }
}
