import { Prisma, type PrismaClient, type RoutineActionType } from "../../generated/prisma/client";
import { getPrisma } from "../../lib/prisma";
import { lockArea } from "../../lib/area-lock";

const routineInclude = {
  area: { select: { id: true, name: true } },
  subtasks: { orderBy: [{ position: "asc" }, { id: "asc" }] },
} satisfies Prisma.RoutineInclude;
export type RoutineWithRelations = Prisma.RoutineGetPayload<{ include: typeof routineInclude }>;

export function createRoutineQueries(db: Prisma.TransactionClient) {
  return {
    findMany(where: Prisma.RoutineWhereInput) {
      return db.routine.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], include: routineInclude });
    },
    findFirst(id: string) { return db.routine.findFirst({ where: { id, deletedAt: null }, include: routineInclude }); },
    findLinked(areaId: string) {
      return db.routine.findMany({ where: { areaId }, orderBy: { id: "asc" }, include: routineInclude });
    },
    findArea(id: string) { return lockArea(db, id); },
    create(data: Prisma.RoutineUncheckedCreateInput) { return db.routine.create({ data, include: routineInclude }); },
    update(id: string, data: Prisma.RoutineUncheckedUpdateInput) {
      return db.routine.update({ where: { id }, data, include: routineInclude });
    },
    async replaceSubtasks(routineId: string, subtasks: readonly { title: string; estimatedDurationMinutes: number }[]) {
      await db.routineSubtask.deleteMany({ where: { routineId } });
      if (subtasks.length) await db.routineSubtask.createMany({
        data: subtasks.map((subtask, position) => ({ ...subtask, routineId, position })),
      });
    },
    createAction(routineId: string, type: RoutineActionType, metadata: unknown) {
      const json: Prisma.InputJsonValue = JSON.parse(JSON.stringify(metadata));
      return db.routineAction.create({ data: { routineId, type, metadata: json } });
    },
    findHistory(routineId: string, take?: number) {
      return db.routineAction.findMany({ where: { routineId }, orderBy: [{ timestamp: "asc" }, { id: "asc" }],
        ...(take === undefined ? {} : { take }) });
    },
  };
}
export type RoutinesTransactionRepository = ReturnType<typeof createRoutineQueries>;
export class RoutinesTransactionConflictError extends Error {}
export function createRoutinesRepository(client: () => PrismaClient = getPrisma) {
  return {
    async transaction<T>(work: (tx: RoutinesTransactionRepository) => Promise<T>): Promise<T> {
      const db = client();
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction((tx) => work(createRoutineQueries(tx)), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          });
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") throw error;
          if (attempt >= 2) throw new RoutinesTransactionConflictError();
        }
      }
    },
  };
}
export type RoutinesRepository = ReturnType<typeof createRoutinesRepository>;
