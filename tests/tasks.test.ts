import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import express from "express";

import { app } from "../src/app";
import { Prisma, type PrismaClient, type Task, type TaskAction, type Subtask } from "../src/generated/prisma/client";
import { errorHandler } from "../src/middleware/error-handler";
import { createRequestLogger } from "../src/middleware/request-logger";
import { createLogger } from "../src/lib/logger";
import { createTasksRouter } from "../src/modules/tasks/tasks.routes";

const input = {
  title: "Write the proposal",
  plannedAt: "2026-10-22T09:00:00+03:00",
  dueAt: "2026-10-23T17:00:00Z",
  estimatedDurationMinutes: 45,
};

// Transactional in-memory Prisma boundary: HTTP tests need no database credentials.
// Writes are available only on tx; a failed event discards the entire draft.
async function fixture(t: TestContext, initialSubtaskIds: string[] = []) {
  const tieSubtaskTimestamps = initialSubtaskIds.length > 0;
  let state: { tasks: Task[]; actions: TaskAction[]; subtasks: Subtask[] } = { tasks: [], actions: [], subtasks: [] };
  let writesBeforeFailure: number | undefined;
  let conflicts = 0;
  let commitConflicts = 0;
  let subtasksBeforeFailure: number | undefined;
  let attempts = 0;
  const reads = { tasks: 0, subtasks: 0 };
  function taskResult(db: typeof state, task: Task, include?: Prisma.TaskInclude) {
    if (!include) return structuredClone(task);
    assert.deepEqual(include, {
      subtasks: { where: { deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    });
    return structuredClone({
      ...task,
      subtasks: db.subtasks.filter((child) => child.taskId === task.id && child.deletedAt === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)),
    });
  }
  const delegates = (db: typeof state) => ({
    task: {
      async findFirst({ where, include }: { where: { id: string; deletedAt: null }; include?: Prisma.TaskInclude }) {
        reads.tasks++;
        const task = db.tasks.find((task) => task.id === where.id && task.deletedAt === where.deletedAt);
        return task ? taskResult(db, task, include) : null;
      },
      async findMany({ where, include }: { where: { deletedAt: null; archivedAt: null | { not: null } }; include?: Prisma.TaskInclude }) {
        reads.tasks++;
        return db.tasks.filter((task) => task.deletedAt === where.deletedAt &&
          (where.archivedAt === null ? task.archivedAt === null : task.archivedAt !== null))
          .map((task) => taskResult(db, task, include));
      },
      async create({ data }: { data: Partial<Task> }) {
        const task: Task = {
          id: randomUUID(), title: "", description: null, status: "TODO", priority: "MEDIUM",
          plannedAt: null, dueAt: null, estimatedDurationMinutes: 1,
          cancellationNote: null, archivedAt: null, deletedAt: null,
          createdAt: new Date(), updatedAt: new Date(), ...data,
        };
        db.tasks.push(task);
        return structuredClone(task);
      },
      async update({ where, data, include }: { where: { id: string }; data: Partial<Task>; include?: Prisma.TaskInclude }) {
        const task = db.tasks.find((task) => task.id === where.id)!;
        Object.assign(task, data, { updatedAt: new Date() });
        return taskResult(db, task, include);
      },
    },
    taskAction: {
      async create({ data }: { data: Omit<TaskAction, "id" | "timestamp"> }) {
        if (writesBeforeFailure !== undefined && writesBeforeFailure-- <= 0) throw new Error("Simulated event write failure");
        const action = { id: randomUUID(), timestamp: new Date(), ...data };
        db.actions.push(action);
        return action;
      },
      async findMany({ where }: { where: { taskId: string } }) {
        return structuredClone(db.actions.filter((action) => action.taskId === where.taskId));
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
    task: {
      findMany: (args: Parameters<ReturnType<typeof delegates>["task"]["findMany"]>[0]) => delegates(state).task.findMany(args),
      findFirst: (args: Parameters<ReturnType<typeof delegates>["task"]["findFirst"]>[0]) => delegates(state).task.findFirst(args),
    },
    async $transaction(work: (tx: unknown) => Promise<unknown>, options: { isolationLevel: string }) {
      assert.equal(options.isolationLevel, "Serializable");
      attempts++;
      if (conflicts-- > 0) throw new Prisma.PrismaClientKnownRequestError("Conflict", { code: "P2034", clientVersion: "7.10.1" });
      const draft = structuredClone(state);
      const result = await work(delegates(draft));
      if (commitConflicts-- > 0) throw new Prisma.PrismaClientKnownRequestError("Commit conflict", { code: "P2034", clientVersion: "7.10.1" });
      state = draft;
      return result;
    },
  } as unknown as PrismaClient;
  const app = express();
  const logs: string[] = [];
  app.use(createRequestLogger(createLogger("production", { write(line) { logs.push(line); } })));
  app.use(express.json());
  app.use("/api/tasks", createTasksRouter(() => client));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks`;
  async function request(method: string, path = "", body?: unknown) {
    const response = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  return {
    request, logs, reads, state: () => state, failEvents: (after = 0) => { writesBeforeFailure = after; },
    conflicts: (count: number) => { conflicts = count; }, attempts: () => attempts,
    commitConflicts: (count: number) => { commitConflicts = count; },
    failSubtasks: (after = 0) => { subtasksBeforeFailure = after; },
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

const initialSubtasks = [
  { title: "  Update task list  ", estimatedDurationMinutes: 40 },
  { title: "Check on mobile", estimatedDurationMinutes: 20 },
];

test("creation with omitted or empty subtasks preserves the original contract", async (t) => {
  const f = await fixture(t);
  for (const extra of [{}, { subtasks: [] }]) {
    const result = await f.request("POST", "", { ...input, ...extra });
    assert.equal(result.status, 201);
    assert.equal(result.body.estimatedDurationMinutes, 45);
    assert.equal(result.body.status, "TODO");
    assert.deepEqual(result.body.subtasks, []);
    const { estimatedDurationMinutes, ...missingDuration } = input;
    assert.equal((await f.request("POST", "", { ...missingDuration, ...extra })).status, 400);
    for (const status of ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"]) {
      assert.equal((await f.request("POST", "", { ...input, ...extra, status })).status, 400);
    }
  }
  assert.equal(f.attempts(), 2);
  assert.deepEqual(f.state().actions.map((action) => action.type), ["CREATED", "CREATED"]);
});

test("creation with subtasks returns the complete sorted DTO and only creation events", async (t) => {
  const ids = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"];
  const f = await fixture(t, [...ids]);
  const result = await f.request("POST", "", {
    title: "  Update UI  ", dueAt: input.dueAt, subtasks: initialSubtasks,
  });
  assert.equal(result.status, 201);
  assert.equal(f.attempts(), 1);
  const parent = f.state().tasks[0];
  const expectedChildren = JSON.parse(JSON.stringify([...f.state().subtasks].reverse()));
  assert.deepEqual(result.body, {
    ...JSON.parse(JSON.stringify(parent)), isCompleted: false, subtasks: expectedChildren,
  });
  assert.equal(result.body.title, "Update UI");
  assert.equal(result.body.estimatedDurationMinutes, 60);
  assert.equal(result.body.priority, "MEDIUM");
  assert.equal(result.body.plannedAt, null);
  assert.equal(result.body.status, "TODO");
  assert.equal(f.state().subtasks[0].title, "Update task list");
  for (const child of f.state().subtasks) {
    assert.equal(child.status, "TODO");
    assert.equal(child.taskId, parent.id);
    assert.equal(child.cancellationNote, null);
    assert.equal(child.deletedAt, null);
  }
  const [created, ...children] = f.state().actions;
  assert.deepEqual(f.state().actions.map((action) => action.type), ["CREATED", "SUBTASK_CREATED", "SUBTASK_CREATED"]);
  assert.equal(created.taskId, parent.id);
  assert.deepEqual(created.metadata, { before: null, after: JSON.parse(JSON.stringify(parent)) });
  for (const [index, action] of children.entries()) {
    assert.equal(action.taskId, parent.id);
    assert.deepEqual(action.metadata, {
      subtaskId: ids[index], before: null, after: JSON.parse(JSON.stringify(f.state().subtasks[index])),
    });
  }
  assert.deepEqual((await f.request("GET", `/${parent.id}`)).body, result.body);
  assert.equal((await f.request("GET", `/${parent.id}/subtasks`)).status, 200);
  assert.equal((await f.request("PATCH", `/${parent.id}`, { estimatedDurationMinutes: 60 })).status, 409);
  await f.createSubtask(parent.id);
});

test("valid parent duration is checked but replaced by the subtask sum", async (t) => {
  const f = await fixture(t);
  for (const estimatedDurationMinutes of [1, 999, 2_147_483_647]) {
    const result = await f.request("POST", "", {
      ...input, estimatedDurationMinutes, status: "TODO", priority: "HIGH", subtasks: initialSubtasks,
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.estimatedDurationMinutes, 60);
    assert.equal(result.body.priority, "HIGH");
    assert.equal(result.body.plannedAt, "2026-10-22T06:00:00.000Z");
    assert.equal(result.body.status, "TODO");
  }
});

test("invalid nested creation and duration overflow fail before opening a transaction", async (t) => {
  const f = await fixture(t);
  const body = { title: input.title, dueAt: input.dueAt, subtasks: initialSubtasks };
  const invalidChildren: unknown[] = [
    null, [], "child", {}, { title: "Missing duration" }, { estimatedDurationMinutes: 5 },
    ...["", " ", "x".repeat(161), null, 1].map((title) => ({ title, estimatedDurationMinutes: 5 })),
    ...[0, -1, 1.5, "30", null, 2_147_483_648].map((estimatedDurationMinutes) => ({ title: "Child", estimatedDurationMinutes })),
    ...["status", "cancellationNote", "id", "taskId", "plannedAt", "dueAt", "priority"].map((key) => ({
      title: "Child", estimatedDurationMinutes: 5, [key]: key === "status" ? "DONE" : "unexpected",
    })),
  ];
  const invalid = [
    ...invalidChildren.map((child) => ({ ...body, subtasks: [initialSubtasks[0], child] })),
    ...[null, {}, "children", 1, true].map((subtasks) => ({ ...body, subtasks })),
    ...[0, -1, 1.5, "30", null, 2_147_483_648].map((estimatedDurationMinutes) => ({ ...body, estimatedDurationMinutes })),
    ...["IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED", "UNKNOWN", null, 1].map((status) => ({ ...body, status })),
    { ...body, dueAt: undefined }, { ...body, dueAt: null }, { ...body, plannedAt: null },
    { ...body, subtasks: [{ title: "Max", estimatedDurationMinutes: 2_147_483_647 }, initialSubtasks[1]] },
  ];
  for (const data of invalid) {
    assert.equal((await f.request("POST", "", data)).status, 400, JSON.stringify(data));
  }
  assert.equal(f.attempts(), 0);
  assert.deepEqual(f.state(), { tasks: [], subtasks: [], actions: [] });
  const atLimit = await f.request("POST", "", {
    ...body, subtasks: [{ title: "Almost max", estimatedDurationMinutes: 2_147_483_646 }, { title: "Last", estimatedDurationMinutes: 1 }],
  });
  assert.equal(atLimit.status, 201);
  assert.equal(atLimit.body.estimatedDurationMinutes, 2_147_483_647);
});

test("nested creation rolls back the parent, children and journal on every write failure", async (t) => {
  for (const kind of ["subtask", "event"] as const) {
    for (let failureAt = 0; failureAt < (kind === "event" ? 3 : 2); failureAt++) {
      const f = await fixture(t);
      await f.create();
      const before = structuredClone(f.state());
      if (kind === "event") f.failEvents(failureAt);
      else f.failSubtasks(failureAt);
      const result = await f.request("POST", "", { ...input, subtasks: initialSubtasks });
      assert.equal(result.status, 500, `${kind} ${failureAt}`);
      assert.deepEqual(f.state(), before, `${kind} ${failureAt}`);
      assert.equal(f.attempts(), 2);
    }
  }
});

test("nested creation retries conflicts after all writes without duplicating records or events", async (t) => {
  const f = await fixture(t);
  f.commitConflicts(2);
  const result = await f.request("POST", "", { ...input, subtasks: initialSubtasks });
  assert.equal(result.status, 201);
  assert.equal(f.attempts(), 3);
  assert.equal(f.state().tasks.length, 1);
  assert.equal(f.state().subtasks.length, 2);
  assert.deepEqual(f.state().actions.map((action) => action.type), ["CREATED", "SUBTASK_CREATED", "SUBTASK_CREATED"]);
  assert.deepEqual(new Set(f.state().subtasks.map((child) => child.id)), new Set(result.body.subtasks.map((child: Subtask) => child.id)));
  const before = structuredClone(f.state());
  f.commitConflicts(3);
  assert.equal((await f.request("POST", "", { ...input, subtasks: initialSubtasks })).status, 409);
  assert.equal(f.attempts(), 6);
  assert.deepEqual(f.state(), before);
});

test("creation requires deadline and duration, validates types and logs normalized values", async (t) => {
  const f = await fixture(t);
  const invalid: unknown[] = [
    {}, { ...input, title: "  " }, { ...input, title: "x".repeat(161) },
    { ...input, plannedAt: null }, { ...input, dueAt: null },
    { ...input, plannedAt: "2026-02-30T12:00:00Z" },
    { ...input, dueAt: "2026-10-22" }, { ...input, dueAt: "2026-10-22T10:00:00" },
    ...[0, -1, 1.5, "30", null, 2_147_483_648].map((estimatedDurationMinutes) => ({ ...input, estimatedDurationMinutes })),
    { ...input, status: "DONE" },
    ...["dueAt", "estimatedDurationMinutes"].map((key) => Object.fromEntries(Object.entries(input).filter(([name]) => name !== key))),
  ];
  for (const body of invalid) assert.equal((await f.request("POST", "", body)).status, 400, JSON.stringify(body));
  assert.equal(f.attempts(), 0, "validation must finish before opening a transaction");
  const task = await f.create();
  assert.equal(task.status, "TODO");
  assert.equal(task.priority, "MEDIUM");
  assert.equal(task.isCompleted, false);
  assert.equal(task.plannedAt, "2026-10-22T06:00:00.000Z");
  const [action] = f.state().actions;
  assert.equal(action.type, "CREATED");
  assert.equal(action.taskId, task.id);
  assert.deepEqual(action.metadata, { before: null, after: JSON.parse(JSON.stringify(f.state().tasks[0])) });
});

test("creation without plannedAt stores and returns null with MEDIUM priority", async (t) => {
  const f = await fixture(t);
  const { plannedAt, ...unplanned } = input;
  const result = await f.request("POST", "", unplanned);
  assert.equal(result.status, 201);
  assert.equal(result.body.plannedAt, null);
  assert.equal(result.body.priority, "MEDIUM");
  assert.equal(f.state().tasks[0].plannedAt, null);
  const action = f.state().actions[0];
  assert.deepEqual(action.metadata, { before: null, after: JSON.parse(JSON.stringify(f.state().tasks[0])) });
});

test("all priorities create and update with transactional before/after events", async (t) => {
  const f = await fixture(t);
  for (const priority of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) {
    const created = await f.request("POST", "", { ...input, priority });
    assert.equal(created.status, 201);
    assert.equal(created.body.priority, priority);
    assert.equal((await f.request("GET", `/${created.body.id}`)).body.priority, priority);
    assert.equal((await f.request("GET")).body.at(-1).priority, priority);
    const next = priority === "CRITICAL" ? "LOW" : "CRITICAL";
    const updated = await f.request("PATCH", `/${created.body.id}`, { priority: next });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.priority, next);
    const history = await f.request("GET", `/${created.body.id}/history`);
    assert.equal(history.body.at(-1).type, "EDITED");
    assert.deepEqual(history.body.at(-1).metadata, { before: { priority }, after: { priority: next } });
    const count = f.state().actions.length;
    await f.request("PATCH", `/${created.body.id}`, { priority: next });
    assert.equal(f.state().actions.length, count);
  }
  const task = f.state().tasks[0];
  for (const priority of ["URGENT", "low", null, 1]) {
    assert.equal((await f.request("POST", "", { ...input, priority })).status, 400);
    assert.equal((await f.request("PATCH", `/${task.id}`, { priority })).status, 400);
  }
});

test("all statuses and legacy PATCH map correctly; conflicts and invalid edits are rejected", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  for (const status of ["IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED", "TODO"]) {
    const result = await f.request("PATCH", `/${task.id}`, { status, ...(status === "CANCELED" ? { cancellationNote: "  No longer needed  " } : {}) });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, status);
    assert.equal(result.body.isCompleted, status === "DONE");
  }
  for (const isCompleted of [true, false]) {
    const result = await f.request("PATCH", `/${task.id}`, { isCompleted });
    assert.equal(result.body.status, isCompleted ? "DONE" : "TODO");
    assert.equal(result.body.isCompleted, isCompleted);
  }
  for (const body of [{}, { status: "UNKNOWN" }, { isCompleted: "true" }, { status: "DONE", isCompleted: true },
    { status: "CANCELED" }, { status: "CANCELED", cancellationNote: " \t " }, { cancellationNote: null },
    { estimatedDurationMinutes: -1 }, { deletedAt: null }, { archivedAt: null }]) {
    assert.equal((await f.request("PATCH", `/${task.id}`, body)).status, 400);
  }
  const cancellation = f.state().actions.find((action) => action.type === "STATUS_CHANGED" &&
    (action.metadata as { after: { status: string } }).after.status === "CANCELED")!;
  assert.equal((cancellation.metadata as { after: { cancellationNote: string } }).after.cancellationNote, "No longer needed");
  assert.equal(f.state().tasks[0].cancellationNote, "No longer needed");
});

test("postponement clears plannedAt, preserves omitted deadline and accepts a new date or explicit null", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  const postponed = await f.request("PATCH", `/${task.id}`, { status: "POSTPONED" });
  assert.equal(postponed.body.plannedAt, null);
  assert.equal(postponed.body.dueAt, task.dueAt);
  assert.equal(f.state().actions.filter((action) => action.type === "EDITED").length, 1);
  assert.equal((await f.request("PATCH", `/${task.id}`, { dueAt: null })).body.dueAt, null);
  await f.request("PATCH", `/${task.id}`, { status: "TODO" });
  const dated = await f.request("PATCH", `/${task.id}`, { status: "POSTPONED", plannedAt: input.plannedAt, dueAt: input.dueAt });
  assert.equal(dated.body.plannedAt, task.plannedAt);
  assert.equal(dated.body.dueAt, task.dueAt);
  const edited = await f.request("PATCH", `/${task.id}`, { title: "  New title  ", description: "Details", estimatedDurationMinutes: 90 });
  assert.equal(edited.body.title, "New title");
  const last = f.state().actions.at(-1)!;
  assert.equal(last.type, "EDITED");
  assert.deepEqual(last.metadata, {
    before: { title: input.title, description: null, estimatedDurationMinutes: 45 },
    after: { title: "New title", description: "Details", estimatedDurationMinutes: 90 },
  });
});

test("archive and restoration preserve status; deletion hides task and history permanently", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await f.request("PATCH", `/${task.id}`, { status: "IN_PROGRESS", archived: true });
  assert.deepEqual((await f.request("GET")).body, []);
  assert.equal((await f.request("GET", "?archived=true")).body[0].status, "IN_PROGRESS");
  assert.equal((await f.request("GET", `/${task.id}`)).status, 200);
  assert.equal((await f.request("GET", `/${task.id}/history`)).status, 200);
  const restored = await f.request("PATCH", `/${task.id}`, { archived: false });
  assert.equal(restored.body.archivedAt, null);
  assert.equal(restored.body.status, "IN_PROGRESS");
  assert.equal((await f.request("GET", "?archived=false")).body.length, 1);
  assert.deepEqual((await f.request("GET", "?archived=true")).body, []);
  await f.request("PATCH", `/${task.id}`, { archived: true });
  const eventsBeforeNoop = f.state().actions.length;
  await f.request("PATCH", `/${task.id}`, { archived: true });
  assert.equal(f.state().actions.length, eventsBeforeNoop, "idempotent archiving creates no extra event");
  assert.equal((await f.request("DELETE", `/${task.id}`)).status, 204);
  assert.ok(f.state().tasks[0].deletedAt);
  assert.ok(f.state().tasks[0].archivedAt);
  assert.equal(f.state().tasks[0].status, "IN_PROGRESS");
  assert.deepEqual(f.state().actions.map((action) => action.type), ["CREATED", "STATUS_CHANGED", "ARCHIVED", "UNARCHIVED", "ARCHIVED", "DELETED"]);
  for (const path of ["", "?archived=true", "?archived=false"]) assert.deepEqual((await f.request("GET", path)).body, []);
  for (const [method, path, body] of [
    ["GET", `/${task.id}`, undefined], ["GET", `/${task.id}/history`, undefined],
    ["PATCH", `/${task.id}`, { archived: false }], ["DELETE", `/${task.id}`, undefined],
  ] as const) assert.equal((await f.request(method, path, body)).status, 404);
});

test("event failures roll back task creation, edits, status, archive, restoration and deletion", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  const archived = await f.create();
  await f.request("PATCH", `/${archived.id}`, { archived: true });
  const before = structuredClone(f.state());
  f.failEvents();
  const logsBeforeFailure = f.logs.length;
  assert.equal((await f.request("POST", "", input)).status, 500);
  for (const [id, data] of [
    [task.id, { title: "Changed" }], [task.id, { status: "DONE" }], [task.id, { priority: "HIGH" }],
    [task.id, { archived: true }], [archived.id, { archived: false }],
  ] as const) assert.equal((await f.request("PATCH", `/${id}`, data)).status, 500);
  assert.equal((await f.request("DELETE", `/${task.id}`)).status, 500);
  assert.deepEqual(f.state(), before);
  const failures = f.logs.slice(logsBeforeFailure).map((line) => JSON.parse(line));
  assert.equal(failures.length, 7);
  assert.ok(failures.every((entry) => entry.statusCode === 500 && entry.error.type === "internal_error"));
});

test("deleting an active task preserves its status and hides it from both lists", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await f.request("PATCH", `/${task.id}`, { isCompleted: true });
  assert.equal((await f.request("DELETE", `/${task.id}`)).status, 204);
  assert.equal(f.state().tasks[0].status, "DONE");
  assert.equal(f.state().tasks[0].archivedAt, null);
  assert.deepEqual((await f.request("GET")).body, []);
  assert.deepEqual((await f.request("GET", "?archived=true")).body, []);
  assert.equal((await f.request("GET", `/${task.id}/history`)).status, 404);
  assert.deepEqual(f.state().actions.map((action) => action.type), ["CREATED", "STATUS_CHANGED", "DELETED"]);
});

test("invalid ids, missing tasks and list modes return client errors", async (t) => {
  const f = await fixture(t);
  for (const method of ["GET", "PATCH", "DELETE"]) {
    assert.equal((await f.request(method, "/not-a-uuid", method === "PATCH" ? { status: "DONE" } : undefined)).status, 400);
    assert.equal((await f.request(method, `/${randomUUID()}`, method === "PATCH" ? { status: "DONE" } : undefined)).status, 404);
  }
  assert.equal((await f.request("GET", "/not-a-uuid/history")).status, 400);
  assert.equal((await f.request("GET", `/${randomUUID()}/history`)).status, 404);
  assert.equal((await f.request("GET", "?archived=invalid")).status, 400);
});

test("serialization conflicts retry without duplicate events and exhaust as 409", async (t) => {
  const f = await fixture(t);
  f.conflicts(2);
  await f.create();
  assert.equal(f.attempts(), 3);
  assert.equal(f.state().actions.length, 1);
  f.conflicts(3);
  assert.equal((await f.request("POST", "", input)).status, 409);
  assert.equal(f.state().tasks.length, 1);
  assert.equal(f.state().actions.length, 1);
});

test("validation retains error JSON and checks ids before PATCH bodies", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.request("PATCH", "/invalid-id", {}), {
    status: 400,
    body: { error: { message: "Invalid task id." } },
  });
  assert.deepEqual(await f.request("GET", `/${randomUUID()}`), {
    status: 404,
    body: { error: { message: "Task not found." } },
  });
  const invalid = await f.request("POST", "", { ...input, estimatedDurationMinutes: 0 });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, {
    error: {
      message: "Invalid task data.",
      details: [{ path: ["estimatedDurationMinutes"], message: "Too small: expected number to be >0" }],
    },
  });
});

test("app mounts the module at /api/tasks", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // These requests stop at validation and must never initialize a database client.
  const invalidList = await fetch(`${base}/api/tasks?archived=invalid`);
  assert.equal(invalidList.status, 400);
  assert.equal((await invalidList.json()).error.message, "Invalid task data.");
  const invalidId = await fetch(`${base}/api/tasks/invalid-id/history`);
  assert.equal(invalidId.status, 400);
  assert.deepEqual(await invalidId.json(), { error: { message: "Invalid task id." } });
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
});

test("Task create, list, detail and update return empty subtasks arrays", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  assert.deepEqual(task.subtasks, []);
  assert.deepEqual((await f.request("GET")).body[0].subtasks, []);
  assert.deepEqual((await f.request("GET", `/${task.id}`)).body.subtasks, []);
  assert.deepEqual((await f.request("PATCH", `/${task.id}`, { title: "Edited" })).body.subtasks, []);
});

test("Task responses embed complete active subtask DTOs in stable order without per-task reads", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const empty = await f.create();
  const other = await f.create();
  const newest = await f.createSubtask(parent.id, { title: "Newest", status: "CANCELED", cancellationNote: "No longer needed" });
  const tied = await f.createSubtask(parent.id, { title: "Tied", status: "DONE" });
  const oldest = await f.createSubtask(parent.id, { title: "Oldest", estimatedDurationMinutes: 7 });
  const deleted = await f.createSubtask(parent.id, { title: "Deleted" });
  const otherChild = await f.createSubtask(other.id, { title: "Other task" });
  // Seed out-of-order timestamps, including a tie, independently of insertion order.
  for (const child of f.state().subtasks.filter((child) => child.taskId === parent.id)) {
    child.createdAt = new Date(child.id === newest.id ? "2026-10-22T10:00:00Z" : "2026-10-21T10:00:00Z");
  }
  assert.equal((await f.request("DELETE", `/${parent.id}/subtasks/${deleted.id}`)).status, 204);
  const tiedIds = [tied.id, oldest.id].sort();
  const expected = JSON.parse(JSON.stringify([...tiedIds, newest.id].map((id) => f.state().subtasks.find((child) => child.id === id))));
  const beforeReads = { ...f.reads };
  const list = await f.request("GET");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.find((task: Task) => task.id === parent.id).subtasks, expected);
  assert.deepEqual(list.body.find((task: Task) => task.id === empty.id).subtasks, []);
  assert.deepEqual(list.body.find((task: Task) => task.id === other.id).subtasks, [otherChild]);
  assert.equal(f.reads.tasks - beforeReads.tasks, 1);
  assert.equal(f.reads.subtasks - beforeReads.subtasks, 0);
  assert.deepEqual((await f.request("GET", `/${parent.id}`)).body.subtasks, expected);
  const patched = await f.request("PATCH", `/${parent.id}`, { title: "Edited", archived: true });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.subtasks, expected);
  assert.deepEqual((await f.request("GET", "?archived=true")).body[0].subtasks, expected);
  assert.deepEqual((await f.request("GET", `/${parent.id}`)).body.subtasks, expected);
});

test("Task responses omit the final soft-deleted subtask", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  const child = await f.createSubtask(task.id);
  assert.equal((await f.request("DELETE", `/${task.id}/subtasks/${child.id}`)).status, 204);
  assert.ok(f.state().subtasks[0].deletedAt);
  assert.deepEqual((await f.request("GET")).body[0].subtasks, []);
  assert.deepEqual((await f.request("GET", `/${task.id}`)).body.subtasks, []);
  assert.deepEqual((await f.request("PATCH", `/${task.id}`, { title: "Edited" })).body.subtasks, []);
});

test("subtask CRUD validates fields, cancellation and UUIDs and returns subtask DTOs", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const path = `/${parent.id}/subtasks`;
  assert.deepEqual(await f.request("GET", path), { status: 200, body: [] });
  for (const data of [
    {}, { title: "Missing duration" }, { estimatedDurationMinutes: 5 },
    ...["", " ", "x".repeat(161), null].map((title) => ({ title, estimatedDurationMinutes: 5 })),
    ...[0, -1, 1.1, "10", null, 2_147_483_648].map((estimatedDurationMinutes) => ({ title: "x", estimatedDurationMinutes })),
    ...["plannedAt", "dueAt", "priority", "deletedAt", "taskId", "id", "isCompleted"].map((key) => ({ title: "x", estimatedDurationMinutes: 5, [key]: "unexpected" })),
    { title: "x", estimatedDurationMinutes: 5, status: "UNKNOWN" },
    { title: "x", estimatedDurationMinutes: 5, status: "CANCELED" },
    { title: "x", estimatedDurationMinutes: 5, status: "CANCELED", cancellationNote: " \t " },
  ]) {
    const result = await f.request("POST", path, data);
    assert.equal(result.status, 400, JSON.stringify(data));
    assert.equal(result.body.error.message, "Invalid task data.");
    assert.ok(Array.isArray(result.body.error.details));
  }
  const subtask = await f.createSubtask(parent.id, { title: "  First  " });
  assert.match(subtask.id, /^[0-9a-f-]{36}$/);
  assert.equal(subtask.taskId, parent.id);
  assert.equal(subtask.title, "First");
  assert.equal(subtask.status, "TODO");
  assert.equal(subtask.cancellationNote, null);
  assert.equal(subtask.deletedAt, null);
  assert.ok(subtask.createdAt && subtask.updatedAt);
  for (const key of ["plannedAt", "dueAt", "priority", "isCompleted", "subtasks"]) assert.ok(!(key in subtask));
  const item = `${path}/${subtask.id}`;
  for (const body of [{}, { title: " " }, { status: "UNKNOWN" }, { status: "CANCELED" },
    { status: "CANCELED", cancellationNote: " " }, { cancellationNote: null },
    { estimatedDurationMinutes: 0 }, { dueAt: null }, { priority: "HIGH" }]) {
    assert.equal((await f.request("PATCH", item, body)).status, 400, JSON.stringify(body));
  }
  const canceled = await f.request("PATCH", item, { title: "  Renamed  ", status: "CANCELED", cancellationNote: "  Reason  " });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.title, "Renamed");
  assert.equal(canceled.body.cancellationNote, "Reason");
  assert.deepEqual(Object.keys(canceled.body).sort(), Object.keys(subtask).sort());
  const reopened = await f.request("PATCH", item, { status: "PAUSED" });
  assert.equal(reopened.body.cancellationNote, "Reason");
  assert.equal((await f.request("GET", path)).body.length, 1);
  assert.deepEqual(Object.keys((await f.request("GET", `/${parent.id}`)).body).sort(), Object.keys(parent).sort());
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const suffix = method === "PATCH" || method === "DELETE" ? `/${subtask.id}` : "";
    assert.deepEqual(await f.request(method, `/invalid/subtasks${suffix}`, method === "GET" ? undefined : {}), {
      status: 400, body: { error: { message: "Invalid task id." } },
    });
  }
  assert.deepEqual(await f.request("PATCH", `${path}/invalid`, {}), {
    status: 400, body: { error: { message: "Invalid subtask id." } },
  });
  assert.equal((await f.request("DELETE", item)).status, 204);
  assert.deepEqual((await f.request("GET", path)).body, []);
  assert.ok(f.state().subtasks[0].deletedAt);
  assert.equal((await f.request("PATCH", item, { title: "Hidden" })).status, 404);
  assert.equal((await f.request("DELETE", item)).status, 404);
  const history = (await f.request("GET", `/${parent.id}/history`)).body as TaskAction[];
  for (const type of ["SUBTASK_CREATED", "SUBTASK_EDITED", "SUBTASK_STATUS_CHANGED", "SUBTASK_DELETED"]) {
    assert.ok(history.some((entry) => entry.type === type && (entry.metadata as { subtaskId?: string }).subtaskId === subtask.id));
  }
});

test("subtasks enforce ownership and missing, deleted and archived parent rules", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const other = await f.create();
  const subtask = await f.createSubtask(parent.id);
  for (const taskId of [other.id, randomUUID()]) {
    for (const method of ["PATCH", "DELETE"]) {
      assert.equal((await f.request(method, `/${taskId}/subtasks/${subtask.id}`, { title: "Wrong parent" })).status, 404);
    }
  }
  assert.equal((await f.request("GET", `/${randomUUID()}/subtasks`)).status, 404);
  assert.equal((await f.request("POST", `/${randomUUID()}/subtasks`, { title: "x", estimatedDurationMinutes: 1 })).status, 404);
  await f.request("PATCH", `/${parent.id}`, { archived: true });
  const archived = structuredClone(f.state());
  assert.equal((await f.request("GET", `/${parent.id}/subtasks`)).status, 200);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const path = `/${parent.id}/subtasks${method === "POST" ? "" : `/${subtask.id}`}`;
    assert.equal((await f.request(method, path, { title: "x", estimatedDurationMinutes: 1 })).status, 409);
  }
  assert.deepEqual(f.state(), archived);
  await f.request("DELETE", `/${parent.id}`);
  const deleted = structuredClone(f.state());
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const path = `/${parent.id}/subtasks${method === "PATCH" || method === "DELETE" ? `/${subtask.id}` : ""}`;
    assert.equal((await f.request(method, path, method === "GET" ? undefined : { title: "x", estimatedDurationMinutes: 1 })).status, 404);
  }
  assert.deepEqual(f.state(), deleted);
});

test("parent duration sums every live status, blocks manual edits and keeps the final sum", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const children: Subtask[] = [];
  for (const status of ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"]) {
    children.push(await f.createSubtask(parent.id, { status, estimatedDurationMinutes: 5,
      ...(status === "CANCELED" ? { cancellationNote: "Reason" } : {}),
    }));
  }
  assert.equal((await f.request("GET", `/${parent.id}`)).body.estimatedDurationMinutes, 30);
  const before = structuredClone(f.state());
  assert.equal((await f.request("PATCH", `/${parent.id}`, { estimatedDurationMinutes: 30, title: "Blocked" })).status, 409);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.request("PATCH", `/${parent.id}`, { title: "Allowed" })).status, 200);
  assert.equal((await f.request("PATCH", `/${parent.id}/subtasks/${children[0].id}`, { estimatedDurationMinutes: 12 })).status, 200);
  assert.equal((await f.request("GET", `/${parent.id}`)).body.estimatedDurationMinutes, 37);
  const durationAction = f.state().actions.filter((entry) => entry.type === "EDITED").at(-1)!;
  assert.deepEqual(durationAction.metadata, {
    subtaskId: children[0].id, before: { estimatedDurationMinutes: 30 }, after: { estimatedDurationMinutes: 37 },
  });
  for (const child of children.slice(1)) assert.equal((await f.request("DELETE", `/${parent.id}/subtasks/${child.id}`)).status, 204);
  assert.equal((await f.request("GET", `/${parent.id}`)).body.estimatedDurationMinutes, 12);
  await f.request("PATCH", `/${parent.id}`, { status: "PAUSED" });
  await f.request("DELETE", `/${parent.id}/subtasks/${children[0].id}`);
  const last = (await f.request("GET", `/${parent.id}`)).body;
  assert.equal(last.estimatedDurationMinutes, 12);
  assert.equal(last.status, "PAUSED");
  assert.equal((await f.request("PATCH", `/${parent.id}`, { estimatedDurationMinutes: 99 })).status, 200);
  await f.createSubtask(parent.id, { estimatedDurationMinutes: 7 });
  assert.equal((await f.request("GET", `/${parent.id}`)).body.estimatedDurationMinutes, 7);
});

test("subtask changes synchronize active and completed statuses and preserve other combinations", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const first = await f.createSubtask(parent.id);
  const second = await f.createSubtask(parent.id);
  const patch = async (id: string, status: string) => {
    const result = await f.request("PATCH", `/${parent.id}/subtasks/${id}`, {
      status, ...(status === "CANCELED" ? { cancellationNote: "Reason" } : {}),
    });
    assert.equal(result.status, 200);
  };
  const status = async () => (await f.request("GET", `/${parent.id}`)).body.status;
  await patch(first.id, "IN_PROGRESS");
  assert.equal(await status(), "IN_PROGRESS");
  await patch(first.id, "DONE");
  assert.equal(await status(), "IN_PROGRESS");
  await patch(second.id, "DONE");
  assert.equal(await status(), "DONE");
  await patch(first.id, "TODO");
  assert.equal(await status(), "IN_PROGRESS");
  for (const next of ["PAUSED", "POSTPONED", "CANCELED"]) {
    await f.request("PATCH", `/${parent.id}`, { status: next, ...(next === "CANCELED" ? { cancellationNote: "Parent reason" } : {}) });
    await patch(first.id, next);
    assert.equal(await status(), next);
  }
  await patch(first.id, "IN_PROGRESS");
  assert.equal(await status(), "IN_PROGRESS");
  await f.request("DELETE", `/${parent.id}/subtasks/${first.id}`);
  assert.equal(await status(), "DONE");
  const autoStatus = f.state().actions.filter((entry) => entry.type === "STATUS_CHANGED").at(-1)!;
  assert.deepEqual(autoStatus.metadata, {
    subtaskId: first.id,
    before: { status: "IN_PROGRESS", cancellationNote: "Parent reason" },
    after: { status: "DONE", cancellationNote: "Parent reason" },
  });
});

test("subtask creation, status changes and soft deletion follow ordered parent status rules", async (t) => {
  const parentStatuses = ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"] as const;
  type Status = Task["status"];
  const preserved = [...parentStatuses];
  const mixed: Status[] = ["IN_PROGRESS", "IN_PROGRESS", "PAUSED", "POSTPONED", "IN_PROGRESS", "IN_PROGRESS"];
  const cases: { children: Status[]; expected: readonly Status[] }[] = [
    { children: ["TODO", "TODO"], expected: parentStatuses.map(() => "TODO") },
    { children: ["DONE", "DONE"], expected: parentStatuses.map(() => "DONE") },
    { children: ["TODO", "DONE", "IN_PROGRESS"], expected: parentStatuses.map(() => "IN_PROGRESS") },
    { children: ["PAUSED", "POSTPONED", "CANCELED", "IN_PROGRESS"], expected: parentStatuses.map(() => "IN_PROGRESS") },
    { children: ["DONE", "TODO"], expected: mixed },
    { children: ["DONE", "TODO", "PAUSED"], expected: mixed },
    { children: ["DONE", "TODO", "POSTPONED", "CANCELED"], expected: mixed },
    { children: ["TODO", "PAUSED"], expected: preserved },
    { children: ["DONE", "POSTPONED"], expected: preserved },
    { children: ["DONE", "CANCELED"], expected: preserved },
    { children: ["TODO", "CANCELED"], expected: preserved },
    { children: ["PAUSED", "POSTPONED", "CANCELED"], expected: preserved },
  ];
  const statusInput = (status: Status) => ({ status, ...(status === "CANCELED" ? { cancellationNote: "Reason" } : {}) });
  for (const operation of ["create", "status", "delete"] as const) {
    for (const { children, expected } of cases) {
      for (const [index, parentStatus] of parentStatuses.entries()) {
        await t.test(`${operation}: ${parentStatus} with ${children.join(" + ")}`, async (t) => {
          const f = await fixture(t);
          const parent = await f.create();
          for (const status of ["TODO", "DONE", "IN_PROGRESS"] as const) {
            const deleted = await f.createSubtask(parent.id, { ...statusInput(status), estimatedDurationMinutes: 100 });
            assert.equal((await f.request("DELETE", `/${parent.id}/subtasks/${deleted.id}`)).status, 204);
          }
          const targetStatus = children.at(-1)!;
          const existingStatuses: Status[] = operation === "create" ? children.slice(0, -1)
            : operation === "status" ? [...children.slice(0, -1), targetStatus === "PAUSED" ? "POSTPONED" : "PAUSED"]
            : [...children, "IN_PROGRESS"];
          let targetId = "";
          for (const status of existingStatuses) {
            targetId = (await f.createSubtask(parent.id, { ...statusInput(status), estimatedDurationMinutes: 7 })).id;
          }
          assert.equal((await f.request("PATCH", `/${parent.id}`, statusInput(parentStatus))).status, 200);
          const actionCount = f.state().actions.length;
          if (operation === "create") {
            targetId = (await f.createSubtask(parent.id, { ...statusInput(targetStatus), estimatedDurationMinutes: 7 })).id;
          } else {
            assert.equal((await f.request(operation === "status" ? "PATCH" : "DELETE",
              `/${parent.id}/subtasks/${targetId}`, operation === "status" ? statusInput(targetStatus) : undefined)).status,
            operation === "status" ? 200 : 204);
          }
          const result = (await f.request("GET", `/${parent.id}`)).body;
          assert.equal(result.status, expected[index]);
          assert.equal(result.isCompleted, expected[index] === "DONE");
          assert.equal(result.estimatedDurationMinutes, children.length * 7);
          assert.equal(result.subtasks.length, children.length);
          assert.deepEqual(result.subtasks.map((child: Subtask) => child.status).sort(), [...children].sort());
          const actions = f.state().actions.slice(actionCount);
          assert.deepEqual(actions.map((action) => action.type), [
            ...(operation === "status" && targetStatus === "CANCELED" ? ["SUBTASK_EDITED"] : []),
            operation === "create" ? "SUBTASK_CREATED" : operation === "status" ? "SUBTASK_STATUS_CHANGED" : "SUBTASK_DELETED",
            ...(operation === "status" ? [] : ["EDITED"]),
            ...(expected[index] === parentStatus ? [] : ["STATUS_CHANGED"]),
          ]);
          if (expected[index] !== parentStatus) {
            assert.deepEqual(actions.at(-1)!.metadata, {
              subtaskId: targetId,
              before: { status: parentStatus, cancellationNote: parentStatus === "CANCELED" ? "Reason" : null },
              after: { status: expected[index], cancellationNote: parentStatus === "CANCELED" ? "Reason" : null },
            });
          }
        });
      }
    }
  }
});

test("deleting the last active subtask preserves every parent status and the last duration", async (t) => {
  for (const status of ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"] as const) {
    await t.test(status, async (t) => {
      const f = await fixture(t);
      const parent = await f.create();
      const deleted = await f.createSubtask(parent.id, { status: "IN_PROGRESS", estimatedDurationMinutes: 100 });
      const last = await f.createSubtask(parent.id, { estimatedDurationMinutes: 7 });
      assert.equal((await f.request("DELETE", `/${parent.id}/subtasks/${deleted.id}`)).status, 204);
      assert.equal((await f.request("PATCH", `/${parent.id}`, {
        status, ...(status === "CANCELED" ? { cancellationNote: "Reason" } : {}),
      })).status, 200);
      const actionCount = f.state().actions.length;
      assert.equal((await f.request("DELETE", `/${parent.id}/subtasks/${last.id}`)).status, 204);
      const result = (await f.request("GET", `/${parent.id}`)).body;
      assert.equal(result.status, status);
      assert.equal(result.estimatedDurationMinutes, 7);
      assert.deepEqual(result.subtasks, []);
      assert.deepEqual(f.state().actions.slice(actionCount).map((action) => action.type), ["SUBTASK_DELETED"]);
    });
  }
});

test("soft deletion recalculates parent status and duration using only live subtasks", async (t) => {
  for (const remainingStatuses of [["TODO"], ["DONE", "DONE"], ["IN_PROGRESS"], ["TODO", "DONE"], ["PAUSED"]]) {
    await t.test(remainingStatuses.join(" + "), async (t) => {
      const f = await fixture(t);
      const parent = await f.create();
      for (const status of remainingStatuses) {
        await f.createSubtask(parent.id, { status, estimatedDurationMinutes: 7 });
      }
      const removed = await f.createSubtask(parent.id, { status: "IN_PROGRESS", estimatedDurationMinutes: 11 });
      const alreadyDeleted = await f.createSubtask(parent.id, { status: "IN_PROGRESS", estimatedDurationMinutes: 100 });
      assert.equal((await f.request("DELETE", `/${parent.id}/subtasks/${alreadyDeleted.id}`)).status, 204);
      const actionCount = f.state().actions.length;
      assert.equal((await f.request("DELETE", `/${parent.id}/subtasks/${removed.id}`)).status, 204);
      const expectedStatus = remainingStatuses.every((status) => status === "TODO") ? "TODO"
        : remainingStatuses.every((status) => status === "DONE") ? "DONE" : "IN_PROGRESS";
      const duration = remainingStatuses.length * 7;
      const result = await f.request("GET", `/${parent.id}`);
      assert.equal(result.body.status, expectedStatus);
      assert.equal(result.body.estimatedDurationMinutes, duration);
      assert.equal(result.body.subtasks.length, remainingStatuses.length);
      assert.ok(f.state().subtasks.find((child) => child.id === removed.id)!.deletedAt);
      const actions = f.state().actions.slice(actionCount);
      assert.deepEqual(actions.map((action) => action.type), [
        "SUBTASK_DELETED", "EDITED", ...(expectedStatus === "IN_PROGRESS" ? [] : ["STATUS_CHANGED"]),
      ]);
      assert.deepEqual(actions[1].metadata, {
        subtaskId: removed.id,
        before: { estimatedDurationMinutes: duration + 11 },
        after: { estimatedDurationMinutes: duration },
      });
      if (expectedStatus !== "IN_PROGRESS") {
        assert.deepEqual(actions[2].metadata, {
          subtaskId: removed.id,
          before: { status: "IN_PROGRESS", cancellationNote: null },
          after: { status: expectedStatus, cancellationNote: null },
        });
      }
    });
  }
});

test("status changes reset IN_PROGRESS to TODO and ignore soft-deleted subtasks", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const child = await f.createSubtask(parent.id, { status: "IN_PROGRESS", estimatedDurationMinutes: 5 });
  await f.createSubtask(parent.id, { estimatedDurationMinutes: 7 });
  const deleted = await f.createSubtask(parent.id, { status: "IN_PROGRESS", estimatedDurationMinutes: 100 });
  await f.request("DELETE", `/${parent.id}/subtasks/${deleted.id}`);
  const actionCount = f.state().actions.length;
  const result = await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { status: "TODO" });
  assert.equal(result.status, 200);
  assert.equal(result.body.id, child.id);
  const updated = (await f.request("GET", `/${parent.id}`)).body;
  assert.equal(updated.status, "TODO");
  assert.equal(updated.estimatedDurationMinutes, 12);
  const actions = f.state().actions.slice(actionCount);
  assert.deepEqual(actions.map((action) => action.type), ["SUBTASK_STATUS_CHANGED", "STATUS_CHANGED"]);
  assert.deepEqual(actions[1].metadata, {
    subtaskId: child.id,
    before: { status: "IN_PROGRESS", cancellationNote: null },
    after: { status: "TODO", cancellationNote: null },
  });
  const nextActionCount = f.state().actions.length;
  await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { title: "Edited" });
  assert.equal((await f.request("GET", `/${parent.id}`)).body.status, "TODO");
  assert.deepEqual(f.state().actions.slice(nextActionCount).map((action) => action.type), ["SUBTASK_EDITED"]);
});

test("deleting the final IN_PROGRESS subtask preserves parent status and duration", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const child = await f.createSubtask(parent.id, { status: "IN_PROGRESS", estimatedDurationMinutes: 13 });
  const actionCount = f.state().actions.length;
  assert.equal((await f.request("DELETE", `/${parent.id}/subtasks/${child.id}`)).status, 204);
  const updated = (await f.request("GET", `/${parent.id}`)).body;
  assert.equal(updated.status, "IN_PROGRESS");
  assert.equal(updated.estimatedDurationMinutes, 13);
  assert.deepEqual(updated.subtasks, []);
  assert.deepEqual(f.state().actions.slice(actionCount).map((action) => action.type), ["SUBTASK_DELETED"]);
});

test("resetting parent to TODO rolls back the subtask, duration and events on journal failure", async (t) => {
  for (const method of ["PATCH", "DELETE"]) {
    for (let failureAt = 0; failureAt < (method === "PATCH" ? 2 : 3); failureAt++) {
      const f = await fixture(t);
      const parent = await f.create();
      await f.createSubtask(parent.id, { estimatedDurationMinutes: 7 });
      const child = await f.createSubtask(parent.id, { status: "IN_PROGRESS", estimatedDurationMinutes: 11 });
      const before = structuredClone(f.state());
      f.failEvents(failureAt);
      const result = await f.request(method, `/${parent.id}/subtasks/${child.id}`,
        method === "PATCH" ? { status: "TODO" } : undefined);
      assert.equal(result.status, 500, `${method}, journal index ${failureAt}`);
      assert.deepEqual(f.state(), before, `${method}, journal index ${failureAt}`);
    }
  }
});

test("manual parent statuses never cascade; adding or reopening under DONE follows precedence", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const child = await f.createSubtask(parent.id, { status: "IN_PROGRESS" });
  for (const status of ["PAUSED", "POSTPONED", "CANCELED", "TODO", "DONE"]) {
    const before = structuredClone(f.state().subtasks);
    await f.request("PATCH", `/${parent.id}`, { status, ...(status === "CANCELED" ? { cancellationNote: "Reason" } : {}) });
    assert.deepEqual(f.state().subtasks, before);
  }
  assert.equal((await f.request("GET", `/${parent.id}`)).body.isCompleted, true);
  assert.equal((await f.request("GET", `/${parent.id}/subtasks`)).body[0].status, "IN_PROGRESS");
  const added = await f.createSubtask(parent.id);
  assert.equal((await f.request("GET", `/${parent.id}`)).body.status, "IN_PROGRESS");
  await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { status: "DONE" });
  await f.request("PATCH", `/${parent.id}/subtasks/${added.id}`, { status: "DONE" });
  const todo = await f.createSubtask(parent.id);
  assert.equal((await f.request("GET", `/${parent.id}`)).body.status, "IN_PROGRESS");
  await f.request("PATCH", `/${parent.id}/subtasks/${todo.id}`, { status: "DONE" });
  await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { status: "CANCELED", cancellationNote: "Canceled without reopening" });
  assert.equal((await f.request("GET", `/${parent.id}`)).body.status, "DONE");
  await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { status: "TODO" });
  assert.equal((await f.request("GET", `/${parent.id}`)).body.status, "IN_PROGRESS");
  await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { status: "DONE" });
  await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { status: "PAUSED" });
  assert.equal((await f.request("GET", `/${parent.id}`)).body.status, "DONE");
  await f.request("PATCH", `/${parent.id}`, { isCompleted: true });
  assert.equal(f.state().subtasks.find((subtask) => subtask.id === child.id)!.status, "PAUSED");
  await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { title: "Edit only" });
  assert.equal((await f.request("GET", `/${parent.id}`)).body.status, "DONE");
  await f.createSubtask(parent.id, { status: "IN_PROGRESS" });
  assert.equal((await f.request("GET", `/${parent.id}`)).body.status, "IN_PROGRESS");
});

test("duration overflow rejects the whole subtask transaction", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const child = await f.createSubtask(parent.id, { estimatedDurationMinutes: 2_147_483_646 });
  const other = await f.createSubtask(parent.id, { estimatedDurationMinutes: 1 });
  const before = structuredClone(f.state());
  assert.equal((await f.request("POST", `/${parent.id}/subtasks`, { title: "Overflow", estimatedDurationMinutes: 1 })).status, 400);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.request("PATCH", `/${parent.id}/subtasks/${other.id}`, { estimatedDurationMinutes: 2 })).status, 400);
  assert.deepEqual(f.state(), before);
  assert.equal(child.estimatedDurationMinutes, 2_147_483_646);
});

test("subtask creation, edit and deletion roll back even when a later journal write fails", async (t) => {
  for (const operation of ["create", "update", "delete"]) {
    const eventCount = operation === "update" ? 4 : 3;
    for (let failureAt = 0; failureAt < eventCount; failureAt++) {
      const f = await fixture(t);
      const parent = await f.create();
      let child: Subtask | undefined;
      if (operation === "update") {
        child = await f.createSubtask(parent.id, { status: "DONE", estimatedDurationMinutes: 5 });
      } else if (operation === "delete") {
        await f.createSubtask(parent.id, { status: "DONE", estimatedDurationMinutes: 5 });
        child = await f.createSubtask(parent.id, { status: "IN_PROGRESS", estimatedDurationMinutes: 10 });
      } else {
        await f.request("PATCH", `/${parent.id}`, { status: "DONE" });
      }
      const before = structuredClone(f.state());
      f.failEvents(failureAt);
      const result = operation === "create"
        ? await f.request("POST", `/${parent.id}/subtasks`, { title: "New", estimatedDurationMinutes: 10 })
        : operation === "update"
          ? await f.request("PATCH", `/${parent.id}/subtasks/${child!.id}`, { title: "Edit", status: "TODO", estimatedDurationMinutes: 20 })
          : await f.request("DELETE", `/${parent.id}/subtasks/${child!.id}`);
      assert.equal(result.status, 500, `${operation}, journal index ${failureAt}`);
      assert.deepEqual(result.body, { error: { message: "Internal server error." } });
      assert.deepEqual(f.state(), before, `${operation}, journal index ${failureAt}`);
    }
  }
});

test("subtask transactions retry serialization conflicts and expose exhausted conflicts as 409", async (t) => {
  const f = await fixture(t);
  const parent = await f.create();
  const attempts = f.attempts();
  f.conflicts(2);
  const child = await f.createSubtask(parent.id);
  assert.equal(f.attempts() - attempts, 3);
  assert.equal(f.state().subtasks.length, 1);
  assert.equal(f.state().actions.filter((entry) => entry.type === "SUBTASK_CREATED").length, 1);
  const before = structuredClone(f.state());
  f.conflicts(3);
  assert.equal((await f.request("PATCH", `/${parent.id}/subtasks/${child.id}`, { estimatedDurationMinutes: 20 })).status, 409);
  assert.deepEqual(f.state(), before);
});
