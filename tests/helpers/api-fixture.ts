import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import express from "express";

import { Prisma, type PrismaClient, type Task, type TaskAction, type Subtask, type Area, type Routine, type RoutineSubtask, type RoutineAction, type RoutineOccurrence } from "../../src/generated/prisma/client";
import { errorHandler } from "../../src/middleware/error-handler";
import { createRequestLogger } from "../../src/middleware/request-logger";
import { createLogger } from "../../src/lib/logger";
import { createTasksRouter } from "../../src/modules/tasks/tasks.routes";
import { createAreasRouter } from "../../src/modules/areas/areas.routes";
import { createRoutinesRouter } from "../../src/modules/routines/routines.routes";

export const input = {
  title: "Write the proposal",
  plannedAt: "2026-10-22T09:00:00+03:00",
  dueAt: "2026-10-23T17:00:00Z",
  estimatedDurationMinutes: 45,
};

// Transactional in-memory Prisma boundary: HTTP tests need no database credentials.
// Writes are available only on tx; a failed event discards the entire draft.
export async function fixture(t: TestContext, initialSubtaskIds: string[] = []) {
  const tieSubtaskTimestamps = initialSubtaskIds.length > 0;
  let state: { tasks: Task[]; actions: TaskAction[]; subtasks: Subtask[]; areas: Area[];
    routines: Routine[]; routineSubtasks: RoutineSubtask[]; routineActions: RoutineAction[];
    occurrences: RoutineOccurrence[];
  } = { tasks: [], actions: [], subtasks: [], areas: [], routines: [], routineSubtasks: [], routineActions: [], occurrences: [] };
  let revision = 0;
  let occurrenceConflicts = 0;
  let occurrencesBeforeFailure: number | undefined;
  let writesBeforeFailure: number | undefined;
  let conflicts = 0;
  let commitConflicts = 0;
  let subtasksBeforeFailure: number | undefined;
  let taskWritesBeforeFailure: number | undefined;
  let areaDeleteFailure = false;
  let routineWritesBeforeFailure: number | undefined;
  let routineChildrenBeforeFailure: number | undefined;
  let attempts = 0;
  let fixedTime: Date | undefined;
  let taskClockCalls = 0;
  let deleteOnAssignmentConflict: string | undefined;
  let rawConflictCode = "P2034";
  const now = () => fixedTime ? new Date(fixedTime) : new Date();
  const reads = { tasks: 0, subtasks: 0, history: 0, areas: 0, areaLocks: 0, routines: 0, routineHistory: 0, occurrences: 0 };
  const operations: string[] = [];
  function taskResult(db: typeof state, task: Task, include?: Prisma.TaskInclude) {
    if (!include) return structuredClone(task);
    assert.deepEqual(include, {
      area: { select: { id: true, name: true } },
      routineOccurrence: { select: { id: true, routineId: true, occurrenceKey: true, startDate: true, endDate: true,
        timezone: true, localTime: true, instant: true, occurrenceNumber: true, previousOccurrenceId: true, basisCompletedAt: true, basisType: true, basisAt: true } },
      subtasks: { where: { deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    });
    return structuredClone({
      ...task,
      routineOccurrence: (() => {
        const occurrence = db.occurrences.find((entry) => entry.id === task.routineOccurrenceId);
        if (!occurrence) return null;
        const { snapshot: _snapshot, createdAt: _createdAt, ...fields } = occurrence;
        return fields;
      })(),
      area: (() => {
        const area = db.areas.find((area) => area.id === task.areaId);
        return area ? { id: area.id, name: area.name } : null;
      })(),
      subtasks: db.subtasks.filter((child) => child.taskId === task.id && child.deletedAt === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)),
    });
  }
  function routineResult(db: typeof state, routine: Routine, include: unknown) {
    assert.deepEqual(include, {
      area: { select: { id: true, name: true } },
      subtasks: { orderBy: [{ position: "asc" }, { id: "asc" }] },
    });
    const area = db.areas.find((area) => area.id === routine.areaId);
    return structuredClone({ ...routine, area: area ? { id: area.id, name: area.name } : null,
      subtasks: db.routineSubtasks.filter((child) => child.routineId === routine.id)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    });
  }
  const delegates = (db: typeof state) => ({
    async $queryRaw(strings: TemplateStringsArray, id: string) {
      if (strings.join("?").includes('FROM "Routine"')) {
        operations.push(`routine-lock:${id}`);
        assert.match(strings.join("?"), /WHERE "id" = \?::uuid FOR UPDATE/);
        return db.routines.filter((routine) => routine.id === id).map(({ id }) => ({ id }));
      }
      if (strings.join("?").includes('FROM "Task"')) {
        operations.push(`task-lock:${id}`);
        assert.match(strings.join("?"), /WHERE "id" = \?::uuid FOR UPDATE/);
        return db.tasks.filter((task) => task.id === id).map(({ id }) => ({ id }));
      }
      reads.areaLocks++;
      operations.push(`area-lock:${id}`);
      assert.match(strings.join("?"), /FROM "Area" WHERE "id" = \?::uuid FOR UPDATE/);
      if (deleteOnAssignmentConflict === id) {
        deleteOnAssignmentConflict = undefined;
        const area = state.areas.find((area) => area.id === id)!;
        for (const task of state.tasks.filter((task) => task.areaId === id)) {
          task.areaId = null;
          task.updatedAt = now();
          state.actions.push({ id: randomUUID(), taskId: task.id, type: "AREA_CHANGED", timestamp: now(), metadata: {
            before: { areaId: id, area: { id, name: area.name } }, after: { areaId: null, area: null },
          } });
        }
        for (const routine of state.routines.filter((routine) => routine.areaId === id)) {
          const before = routineResult(state, routine, {
            area: { select: { id: true, name: true } }, subtasks: { orderBy: [{ position: "asc" }, { id: "asc" }] },
          });
          routine.areaId = null;
          routine.updatedAt = now();
          state.routineActions.push({ id: randomUUID(), routineId: routine.id, type: "UPDATED", timestamp: now(),
            metadata: JSON.parse(JSON.stringify({ before, after: { ...before, areaId: null, area: null, updatedAt: routine.updatedAt } })) });
        }
        state.areas = state.areas.filter((area) => area.id !== id);
        throw new Prisma.PrismaClientKnownRequestError("Concurrent deletion", {
          code: rawConflictCode, clientVersion: "7.10.1",
          meta: rawConflictCode === "P2010" ? { driverAdapterError: { cause: { kind: "TransactionWriteConflict", originalCode: "40001" } } } : undefined,
        });
      }
      return structuredClone(db.areas.filter((area) => area.id === id));
    },
    routineOccurrence: {
      async findFirst({ where }: { where: { routineId: string } }) {
        reads.occurrences++;
        const entry = db.occurrences.find((entry) => entry.routineId === where.routineId);
        return entry ? { id: entry.id } : null;
      },
      async findMany({ where, take }: { where: { routineId: string; occurrenceKey?: { in: string[] } }; take?: number; orderBy?: unknown }) {
        reads.occurrences++;
        if (where.occurrenceKey === undefined) {
          return db.occurrences.filter((entry) => entry.routineId === where.routineId)
            .sort((a, b) => (a.occurrenceNumber ?? Infinity) - (b.occurrenceNumber ?? Infinity)).slice(0, take)
            .map((entry) => ({ ...structuredClone(entry), task: (() => {
              const task = db.tasks.find((task) => task.routineOccurrenceId === entry.id);
              return task ? { id: task.id } : null;
            })() }));
        }
        return db.occurrences.filter((entry) => entry.routineId === where.routineId && where.occurrenceKey?.in.includes(entry.occurrenceKey))
          .map((entry) => ({ occurrenceKey: entry.occurrenceKey, task: (() => {
            const task = db.tasks.find((task) => task.routineOccurrenceId === entry.id);
            return task ? { id: task.id } : null;
          })() }));
      },
      async create({ data }: { data: Omit<RoutineOccurrence, "id" | "createdAt" | "occurrenceNumber" | "previousOccurrenceId" | "basisCompletedAt" | "basisType" | "basisAt"> & Partial<RoutineOccurrence> }) {
        operations.push(`occurrence-create:${data.routineId}`);
        if (occurrencesBeforeFailure !== undefined && occurrencesBeforeFailure-- <= 0) throw new Error("Simulated occurrence write failure");
        if (occurrenceConflicts-- > 0 || db.occurrences.some((entry) => entry.routineId === data.routineId && entry.occurrenceKey === data.occurrenceKey)
          || (data.occurrenceNumber != null && db.occurrences.some((entry) => entry.routineId === data.routineId && entry.occurrenceNumber === data.occurrenceNumber))
          || (data.previousOccurrenceId != null && db.occurrences.some((entry) => entry.previousOccurrenceId === data.previousOccurrenceId))) {
          throw new Prisma.PrismaClientKnownRequestError("Duplicate occurrence", {
            code: "P2002", clientVersion: "7.10.1", meta: { target: ["routineId", "occurrenceKey"] },
          });
        }
        assert.ok(db.routines.some((routine) => routine.id === data.routineId));
        const entry = { occurrenceNumber: null, previousOccurrenceId: null, basisCompletedAt: null, basisType: null, basisAt: null, ...data, id: randomUUID(), createdAt: now() };
        db.occurrences.push(entry);
        return structuredClone(entry);
      },
    },
    area: {
      async findMany({ orderBy }: { orderBy: unknown }) {
        reads.areas++;
        assert.deepEqual(orderBy, [{ name: "asc" }, { id: "asc" }]);
        return structuredClone([...db.areas]
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
      },
      async create({ data }: { data: { name: string } }) {
        const area: Area = { id: randomUUID(), createdAt: now(), updatedAt: now(), ...data };
        db.areas.push(area);
        return structuredClone(area);
      },
      async update({ where, data }: { where: { id: string }; data: Partial<Area> }) {
        const area = db.areas.find((area) => area.id === where.id)!;
        Object.assign(area, data, { updatedAt: now() });
        return structuredClone(area);
      },
      async delete({ where }: { where: { id: string } }) {
        operations.push(`area-delete:${where.id}`);
        if (areaDeleteFailure) throw new Error("Simulated area deletion failure");
        assert.ok(!db.tasks.some((task) => task.areaId === where.id), "FK RESTRICT: every task must be detached first");
        assert.ok(!db.routines.some((routine) => routine.areaId === where.id), "FK RESTRICT: every routine must be detached first");
        const area = db.areas.find((area) => area.id === where.id)!;
        db.areas = db.areas.filter((area) => area.id !== where.id);
        return structuredClone(area);
      },
    },
    routine: {
      async findMany({ where, include, orderBy }: { where: { deletedAt?: null; areaId?: string }; include: unknown; orderBy: unknown }) {
        reads.routines++;
        const linked = where.areaId !== undefined;
        assert.deepEqual(orderBy, linked ? { id: "asc" } : [{ createdAt: "desc" }, { id: "asc" }]);
        const routines = db.routines.filter((routine) => linked ? routine.areaId === where.areaId : routine.deletedAt === null);
        return routines.sort((a, b) => (linked ? 0 : b.createdAt.getTime() - a.createdAt.getTime()) || a.id.localeCompare(b.id))
          .map((routine) => routineResult(db, routine, include));
      },
      async findFirst({ where, include }: { where: { id: string; deletedAt: null }; include: unknown }) {
        reads.routines++;
        const routine = db.routines.find((routine) => routine.id === where.id && routine.deletedAt === null);
        return routine ? routineResult(db, routine, include) : null;
      },
      async create({ data, include }: { data: Omit<Routine, "id" | "createdAt" | "updatedAt" | "pausedAt" | "deletedAt">; include: unknown }) {
        const routine: Routine = { id: randomUUID(), createdAt: now(), updatedAt: now(), pausedAt: null, deletedAt: null, ...data };
        if (data.areaId) assert.ok(db.areas.some((area) => area.id === data.areaId));
        db.routines.push(routine);
        return routineResult(db, routine, include);
      },
      async update({ where, data, include }: { where: { id: string }; data: Partial<Routine>; include: unknown }) {
        operations.push(`routine-update:${where.id}`);
        if (routineWritesBeforeFailure !== undefined && routineWritesBeforeFailure-- <= 0) throw new Error("Simulated routine write failure");
        if (data.areaId) assert.ok(db.areas.some((area) => area.id === data.areaId));
        const routine = db.routines.find((routine) => routine.id === where.id)!;
        Object.assign(routine, data, { updatedAt: now() });
        return routineResult(db, routine, include);
      },
    },
    routineSubtask: {
      async deleteMany({ where }: { where: { routineId: string } }) {
        db.routineSubtasks = db.routineSubtasks.filter((child) => child.routineId !== where.routineId);
      },
      async createMany({ data }: { data: Omit<RoutineSubtask, "id">[] }) {
        for (const child of data) {
          if (routineChildrenBeforeFailure !== undefined && routineChildrenBeforeFailure-- <= 0) throw new Error("Simulated routine child failure");
          db.routineSubtasks.push({ id: randomUUID(), ...child });
        }
      },
    },
    routineAction: {
      async create({ data }: { data: Omit<RoutineAction, "id" | "timestamp"> }) {
        operations.push(`routine-event:${data.routineId}:${data.type}`);
        if (writesBeforeFailure !== undefined && writesBeforeFailure-- <= 0) throw new Error("Simulated event write failure");
        const action = { id: randomUUID(), timestamp: now(), ...data };
        db.routineActions.push(action);
        return structuredClone(action);
      },
      async findMany({ where, orderBy, take }: { where: { routineId: string }; orderBy: unknown; take?: number }) {
        reads.routineHistory++;
        assert.deepEqual(orderBy, [{ timestamp: "asc" }, { id: "asc" }]);
        return structuredClone(db.routineActions.filter((action) => action.routineId === where.routineId)
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id)).slice(0, take));
      },
    },
    task: {
      async findFirst({ where, include }: { where: { id: string; deletedAt?: null }; include?: Prisma.TaskInclude }) {
        reads.tasks++;
        const task = db.tasks.find((task) => task.id === where.id && (where.deletedAt === undefined || task.deletedAt === where.deletedAt));
        return task ? taskResult(db, task, include) : null;
      },
      async findMany({ where, include, select, orderBy }: {
        where: { deletedAt?: null; archivedAt?: null | { not: null }; areaId?: string };
        include?: Prisma.TaskInclude; select?: unknown; orderBy?: unknown;
      }) {
        reads.tasks++;
        if (where.areaId !== undefined) {
          operations.push(`linked-tasks:${where.areaId}`);
          assert.deepEqual(where, { areaId: where.areaId });
          assert.deepEqual(orderBy, { id: "asc" });
          assert.deepEqual(select, { id: true });
          return db.tasks.filter((task) => task.areaId === where.areaId)
            .sort((a, b) => a.id.localeCompare(b.id)).map((task) => ({ id: task.id }));
        }
        return db.tasks.filter((task) => task.deletedAt === where.deletedAt &&
          (where.archivedAt === null ? task.archivedAt === null : task.archivedAt !== null))
          .map((task) => taskResult(db, task, include));
      },
      async create({ data }: { data: Partial<Task> }) {
        if (taskWritesBeforeFailure !== undefined && taskWritesBeforeFailure-- <= 0) throw new Error("Simulated task write failure");
        if (data.routineOccurrenceId) {
          assert.ok(db.occurrences.some((entry) => entry.id === data.routineOccurrenceId));
          if (db.tasks.some((task) => task.routineOccurrenceId === data.routineOccurrenceId)) {
            throw new Prisma.PrismaClientKnownRequestError("Duplicate Task occurrence", {
              code: "P2002", clientVersion: "7.10.1", meta: { target: ["routineOccurrenceId"] },
            });
          }
        }
        const task: Task = {
          id: randomUUID(), title: "", description: null, status: "TODO", priority: "MEDIUM",
          areaId: null,
          routineOccurrenceId: null,
          plannedAt: null, dueAt: null, estimatedDurationMinutes: 1,
          cancellationNote: null, skipNote: null, archivedAt: null, deletedAt: null,
          createdAt: now(), updatedAt: now(), ...data,
        };
        db.tasks.push(task);
        return structuredClone(task);
      },
      async update({ where, data, include }: { where: { id: string }; data: Partial<Task>; include?: Prisma.TaskInclude }) {
        operations.push(`task-update:${where.id}`);
        if (taskWritesBeforeFailure !== undefined && taskWritesBeforeFailure-- <= 0) throw new Error("Simulated task write failure");
        if (data.areaId) assert.ok(db.areas.some((area) => area.id === data.areaId), "FK target must exist");
        const task = db.tasks.find((task) => task.id === where.id)!;
        Object.assign(task, data, { updatedAt: now() });
        return taskResult(db, task, include);
      },
    },
    taskAction: {
      async create({ data }: { data: Omit<TaskAction, "id" | "timestamp"> }) {
        operations.push(`event:${data.taskId}:${data.type}`);
        if (writesBeforeFailure !== undefined && writesBeforeFailure-- <= 0) throw new Error("Simulated event write failure");
        const action = { id: randomUUID(), timestamp: now(), ...data };
        db.actions.push(action);
        return action;
      },
      async findMany({ where, orderBy, take }: {
        where: { taskId: string | { in: string[] }; type?: { in: string[] } };
        orderBy: unknown;
        take?: number;
      }) {
        reads.history++;
        assert.deepEqual(orderBy, [{ timestamp: "asc" }, { id: "asc" }]);
        return structuredClone(db.actions.filter((action) =>
          (typeof where.taskId === "string" ? action.taskId === where.taskId : where.taskId.in.includes(action.taskId)) &&
          (!where.type || where.type.in.includes(action.type)))
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id)).slice(0, take));
      },
    },
    subtask: {
      async findMany({ where }: { where: { taskId: string; deletedAt: null } }) {
        reads.subtasks++;
        return structuredClone(db.subtasks.filter((subtask) => subtask.taskId === where.taskId && subtask.deletedAt === null));
      },
      async findFirst({ where }: { where: { id: string; taskId: string; deletedAt: null } }) {
        return structuredClone(db.subtasks.find((subtask) => subtask.id === where.id && subtask.taskId === where.taskId && subtask.deletedAt === null) ?? null);
      },
      async create({ data }: { data: Pick<Subtask, "taskId" | "title" | "estimatedDurationMinutes"> & Partial<Subtask> }) {
        if (subtasksBeforeFailure !== undefined && subtasksBeforeFailure-- <= 0) throw new Error("Simulated subtask write failure");
        const subtask: Subtask = {
          id: initialSubtaskIds.shift() ?? randomUUID(), status: "TODO", cancellationNote: null, deletedAt: null,
          createdAt: tieSubtaskTimestamps ? new Date("2026-10-23T10:00:00Z") : new Date(), updatedAt: new Date(), ...data,
        };
        db.subtasks.push(subtask);
        return structuredClone(subtask);
      },
      async update({ where, data }: { where: { id: string }; data: Partial<Subtask> }) {
        const subtask = db.subtasks.find((subtask) => subtask.id === where.id)!;
        Object.assign(subtask, data, { updatedAt: new Date() });
        return structuredClone(subtask);
      },
    },
  });
  const client = {
    area: {
      findMany: (args: Parameters<ReturnType<typeof delegates>["area"]["findMany"]>[0]) => delegates(state).area.findMany(args),
    },
    task: {
      findMany: (args: Parameters<ReturnType<typeof delegates>["task"]["findMany"]>[0]) => delegates(state).task.findMany(args),
      findFirst: (args: Parameters<ReturnType<typeof delegates>["task"]["findFirst"]>[0]) => delegates(state).task.findFirst(args),
    },
    async $transaction(work: (tx: unknown) => Promise<unknown>, options: { isolationLevel: string }) {
      assert.equal(options.isolationLevel, "Serializable");
      attempts++;
      if (conflicts-- > 0) throw new Prisma.PrismaClientKnownRequestError("Conflict", { code: "P2034", clientVersion: "7.10.1" });
      const draft = structuredClone(state);
      const baseRevision = revision;
      const result = await work(delegates(draft));
      if (commitConflicts-- > 0) throw new Prisma.PrismaClientKnownRequestError("Commit conflict", { code: "P2034", clientVersion: "7.10.1" });
      if (baseRevision !== revision) throw new Prisma.PrismaClientKnownRequestError("Concurrent commit", { code: "P2034", clientVersion: "7.10.1" });
      state = draft;
      revision++;
      return result;
    },
  } as unknown as PrismaClient;
  const app = express();
  const logs: string[] = [];
  app.use(createRequestLogger(createLogger("production", { write(line) { logs.push(line); } })));
  app.use(express.json());
  app.use("/api/tasks", createTasksRouter(() => client, () => { taskClockCalls++; return now(); }));
  app.use("/api/areas", createAreasRouter(() => client));
  app.use("/api/routines", createRoutinesRouter(() => client, now));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks`;
  async function send(url: string, method: string, body?: unknown) {
    const response = await fetch(url, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : response.headers.get("content-type")?.includes("application/json")
        ? await response.json() : await response.text(),
    };
  }
  const request = (method: string, path = "", body?: unknown) => send(base + path, method, body);
  const areaRequest = (method: string, path = "", body?: unknown) => send(base.replace(/tasks$/, "areas") + path, method, body);
  const routineRequest = (method: string, path = "", body?: unknown) => send(base.replace(/tasks$/, "routines") + path, method, body);
  return {
    request, areaRequest, routineRequest, logs, reads, operations, state: () => state, setTime: (time: Date) => { fixedTime = time; },
    taskClockCalls: () => taskClockCalls,
    failRoutineWrites: (after = 0) => { routineWritesBeforeFailure = after; },
    occurrenceConflicts: (count: number) => { occurrenceConflicts = count; },
    failOccurrences: (after = 0) => { occurrencesBeforeFailure = after; },
    failRoutineChildren: (after = 0) => { routineChildrenBeforeFailure = after; },
    deleteOnAssignmentConflict: (id: string, code = "P2034") => { deleteOnAssignmentConflict = id; rawConflictCode = code; },
    failTaskWrites: (after = 0) => { taskWritesBeforeFailure = after; },
    failAreaDelete: () => { areaDeleteFailure = true; },
    failEvents: (after = 0) => { writesBeforeFailure = after; },
    conflicts: (count: number) => { conflicts = count; }, attempts: () => attempts,
    commitConflicts: (count: number) => { commitConflicts = count; },
    failSubtasks: (after = 0) => { subtasksBeforeFailure = after; },
    async createArea(name = "Work") {
      const result = await areaRequest("POST", "", { name });
      assert.equal(result.status, 201);
      return result.body as Area;
    },
    async create() {
      const result = await request("POST", "", input);
      assert.equal(result.status, 201);
      return result.body as Task & { isCompleted: boolean; subtasks: Subtask[] };
    },
    async createSubtask(taskId: string, data: Record<string, unknown> = {}) {
      const result = await request("POST", `/${taskId}/subtasks`, {
        title: "Subtask", estimatedDurationMinutes: 10, ...data,
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body as Subtask;
    },
  };
}

