import { Prisma, type PrismaClient, type TaskActionType } from "../../generated/prisma/client";
import { getPrisma } from "../../lib/prisma";

function createTaskQueries(db: Prisma.TransactionClient) {
  return {
    findMany(where: Prisma.TaskWhereInput) {
      return db.task.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    },
    findFirst(where: Prisma.TaskWhereInput) {
      return db.task.findFirst({ where });
    },
    create(data: Prisma.TaskCreateInput) {
      return db.task.create({ data });
    },
    update(id: string, data: Prisma.TaskUpdateInput) {
      return db.task.update({ where: { id }, data });
    },
    createAction(taskId: string, type: TaskActionType, metadata: unknown) {
      const json: Prisma.InputJsonValue = JSON.parse(JSON.stringify(metadata));
      return db.taskAction.create({ data: { taskId, type, metadata: json } });
    },
    findHistory(taskId: string) {
      return db.taskAction.findMany({
        where: { taskId },
        orderBy: [{ timestamp: "asc" }, { id: "asc" }],
      });
    },
  };
}

export type TasksTransactionRepository = ReturnType<typeof createTaskQueries>;

export class TasksTransactionConflictError extends Error {}

export function createTasksRepository(client: () => PrismaClient = getPrisma) {
  return {
    findMany(where: Prisma.TaskWhereInput) {
      return createTaskQueries(client()).findMany(where);
    },
    findFirst(where: Prisma.TaskWhereInput) {
      return createTaskQueries(client()).findFirst(where);
    },
    // Retry serialization conflicts to preserve consistent before/after values.
    // Every callback receives queries bound to the same Prisma transaction.
    async transaction<T>(work: (repository: TasksTransactionRepository) => Promise<T>): Promise<T> {
      const db = client();
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction((tx) => work(createTaskQueries(tx)), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          });
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") throw error;
          if (attempt >= 2) throw new TasksTransactionConflictError();
        }
      }
    },
  };
}

export type TasksRepository = ReturnType<typeof createTasksRepository>;
