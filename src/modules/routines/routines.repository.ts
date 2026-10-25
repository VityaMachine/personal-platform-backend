import { Prisma, type PrismaClient, type RoutineActionType } from "../../generated/prisma/client";
import { getPrisma } from "../../lib/prisma";
import { lockArea } from "../../lib/area-lock";
import { lockRoutine } from "../../lib/routine-lock";
import { createTaskQueries } from "../tasks/tasks.repository";

const routineInclude = {
  area: { select: { id: true, name: true } },
  subtasks: { orderBy: [{ position: "asc" }, { id: "asc" }] },
} satisfies Prisma.RoutineInclude;
export type RoutineWithRelations = Prisma.RoutineGetPayload<{ include: typeof routineInclude }>;

export function createRoutineQueries(db: Prisma.TransactionClient) {
  return {
    tasks: createTaskQueries(db),
    lock(id: string) { return lockRoutine(db, id); },
    hasOccurrences(routineId: string) { return db.routineOccurrence.findFirst({ where: { routineId }, select: { id: true } }); },
    findOccurrences(routineId: string, occurrenceKeys: string[]) {
      return db.routineOccurrence.findMany({ where: { routineId, occurrenceKey: { in: occurrenceKeys } },
        select: { occurrenceKey: true, task: { select: { id: true } } } });
    },
    createOccurrence(data: Prisma.RoutineOccurrenceUncheckedCreateInput) { return db.routineOccurrence.create({ data }); },
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
export function isRoutineOccurrenceUniqueConflict(error: Prisma.PrismaClientKnownRequestError) {
  const target = error.meta?.target;
  const adapter = error.meta?.driverAdapterError as {
    cause?: { kind?: string; constraint?: { index?: string; fields?: string[] } };
  } | undefined;
  const constraint = adapter?.cause?.kind === "UniqueConstraintViolation" ? adapter.cause.constraint : undefined;
  const index = constraint?.index;
  const fields = constraint?.fields ?? (Array.isArray(target) ? target : []);
  return error.code === "P2002" && (
    fields.includes("routineOccurrenceId") || (fields.includes("routineId") && fields.includes("occurrenceKey"))
    || [target, index].some((name) => name === "RoutineOccurrence_routineId_occurrenceKey_key" || name === "Task_routineOccurrenceId_key"));
}
export function createRoutinesRepository(client: () => PrismaClient = getPrisma) {
  return {
    async transaction<T>(work: (tx: RoutinesTransactionRepository) => Promise<T>): Promise<T> {
      const db = client();
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction((tx) => work(createRoutineQueries(tx)), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 30_000,
          });
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
          if (error.code !== "P2034" && !isRoutineOccurrenceUniqueConflict(error)) throw error;
          if (attempt >= 2) throw new RoutinesTransactionConflictError();
        }
      }
    },
  };
}
export type RoutinesRepository = ReturnType<typeof createRoutinesRepository>;
