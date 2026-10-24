import { Prisma, type PrismaClient, type TaskActionType } from "../../generated/prisma/client";
import { getPrisma } from "../../lib/prisma";

const taskInclude = {
  subtasks: {
    where: { deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.TaskInclude;

export type TaskWithSubtasks = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

function createTaskQueries(db: Prisma.TransactionClient) {
  return {
    findMany(where: Prisma.TaskWhereInput) {
      return db.task.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: taskInclude });
    },
    findFirst(where: Prisma.TaskWhereInput) {
      return db.task.findFirst({ where, include: taskInclude });
    },
    create(data: Prisma.TaskCreateInput) {
      return db.task.create({ data });
    },
    update(id: string, data: Prisma.TaskUpdateInput) {
      return db.task.update({ where: { id }, data, include: taskInclude });
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
    findSummaryActions(taskIds: string[]) {
      return db.taskAction.findMany({
        where: { taskId: { in: taskIds }, type: { in: ["CREATED", "STATUS_CHANGED"] } },
        orderBy: [{ timestamp: "asc" }, { id: "asc" }],
        select: { id: true, taskId: true, type: true, timestamp: true, metadata: true },
      });
    },
    findSubtasks(taskId: string) {
      return db.subtask.findMany({
        where: { taskId, deletedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    },
    findSubtask(taskId: string, id: string) {
      return db.subtask.findFirst({ where: { id, taskId, deletedAt: null } });
    },
    createSubtask(taskId: string, data: Omit<Prisma.SubtaskUncheckedCreateInput, "taskId">) {
      return db.subtask.create({ data: { ...data, taskId } });
    },
    updateSubtask(id: string, data: Prisma.SubtaskUpdateInput) {
      return db.subtask.update({ where: { id }, data });
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
