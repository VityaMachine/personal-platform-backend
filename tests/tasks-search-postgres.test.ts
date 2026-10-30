import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, TaskStatus, TaskPriority, type Prisma } from "../src/generated/prisma/client";
import { composeApplication } from "../src/application/compose";
import { readApplicationConfig } from "../src/config/config";
import { createLogger } from "../src/infrastructure/logging/logger";
import { verifiedTaskCompletion } from "../src/modules/tasks/domain/tasks.completion";
import { searchTasksSchema } from "../src/modules/tasks/http/tasks.search.schemas";
import { createTasksRepository } from "../src/modules/tasks/tasks.repository";
import { createTasksService } from "../src/modules/tasks/tasks.service";

// Explicit opt-in, local host only, new isolated schema, no .env or application DB URL.
test("search PostgreSQL/API: selection, history evidence, calendars, pagination, DTOs and bounded query count", {
  skip: !process.env.TASK_SEARCH_TEST_DATABASE_URL,
}, async (t) => {
  const connectionString = process.env.TASK_SEARCH_TEST_DATABASE_URL!;
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname));
  const schema = `task_search_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const sql = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }), log: [{ emit: "event", level: "query" }] });
  const queries: string[] = [];
  prisma.$on("query", (event) => queries.push(event.query));
  t.after(async () => {
    await prisma.$disconnect(); await sql.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  });
  for (const migration of (await readdir("prisma/migrations", { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    await sql.query(await readFile(path.join("prisma/migrations", migration, "migration.sql"), "utf8"));
  }
  const asOf = new Date("2026-11-01T00:00:00Z");
  let clockCalls = 0;
  const server = composeApplication({ config: readApplicationConfig({}), client: () => prisma,
    now: () => { clockCalls++; return new Date(asOf); }, logger: createLogger("production", { write() {} }),
  }).createHttpApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks`;
  const get = async (query = "") => {
    const response = await fetch(`${base}/search${query ? `?${query}` : ""}`);
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const create = (data: Partial<Prisma.TaskUncheckedCreateInput> = {}) => prisma.task.create({ data: {
    id: randomUUID(), title: "Звичайна задача", estimatedDurationMinutes: 10,
    cancellationNote: data.status === "CANCELED" ? "Canceled in fixture" : null,
    createdAt: new Date("2026-01-01T00:00:00Z"), ...data,
  } });
  const noTasks = await get();
  assert.equal(noTasks.summary.totalItems, 0);
  assert.ok(Object.values(noTasks.summary.counts).every((count) => count === 0));
  assert.deepEqual([noTasks.items, noTasks.totalItems, noTasks.totalPages, noTasks.hasPreviousPage, noTasks.hasNextPage], [[], 0, 0, false, false]);
  const area = await prisma.area.create({ data: { name: "Work" } });
  const first = await create({ title: "  ПЕРЕВІРКА %_ ІЇЄ ΟΣ İ  ", description: "description-only", priority: "CRITICAL", areaId: area.id,
    plannedAt: new Date("2026-10-24T21:00:00Z"), dueAt: new Date("2026-10-25T21:59:59.999Z") });
  const second = await create({ title: "Перевірка друга", status: "CANCELED", priority: "HIGH", dueAt: new Date("2026-10-25T22:00:00Z") });
  await create({ archivedAt: asOf }); await create({ deletedAt: asOf });
  for (let i = 0; i < 101; i++) await create({ status: Object.values(TaskStatus)[i % 6], priority: Object.values(TaskPriority)[i % 4],
    createdAt: i % 5 === 0 ? new Date(Date.UTC(2026, 0, 2 + i)) : new Date("2026-01-01T00:00:00Z"),
    dueAt: i % 7 === 0 ? new Date("2026-10-25T21:59:59.999Z") : null });
  const total = 103;
  const baseline = await get();
  assert.equal(baseline.totalItems, total); assert.equal(baseline.summary.totalItems, total);
  assert.deepEqual(Object.keys(baseline.summary.counts).sort(), Object.values(TaskStatus).sort());
  assert.equal(Object.values(baseline.summary.counts).reduce((a: number, b) => a + Number(b), 0), total);
  assert.equal(baseline.page, 1); assert.equal(baseline.totalPages, 6); assert.equal(baseline.hasPreviousPage, false); assert.equal(baseline.hasNextPage, true);
  assert.equal(baseline.asOf, asOf.toISOString());
  for (const dateField of ["planning", "due", "created", "completed"]) assert.equal((await get(`dateField=${dateField}`)).totalItems, total);
  assert.equal((await get("dateField=created&to=9999-12-31")).totalItems, total);
  assert.equal((await get("dateField=created&from=0001-01-01")).totalItems, total);
  const matched = await get(`q=${encodeURIComponent("  перевірка %_ іїє  ")}&area=${area.id.toUpperCase()}&priority=CRITICAL&status=TODO`);
  assert.deepEqual(matched.items.map((x: { id: string }) => x.id), [first.id]);
  const combined = await get(`q=перевірка&area=${area.id}&priority=CRITICAL&status=TODO&from=2026-10-25&to=2026-10-25&timezone=Europe/Kyiv&sort=planning`);
  assert.deepEqual(combined.items.map((x: { id: string }) => x.id), [first.id]);
  assert.equal(combined.totalItems, 1);
  assert.equal(matched.totalItems, 1); assert.deepEqual(matched.summary, baseline.summary);
  assert.equal((await get("q=перевірка")).totalItems, 2);
  assert.equal((await get(`q=${encodeURIComponent("ος i\u0307")}`)).totalItems, 1);
  assert.equal((await get("q=description-only")).totalItems, 0);
  assert.equal((await get("q=%20%20")).totalItems, total);
  assert.equal((await get("q=missing")).totalItems, 0);
  assert.equal((await get("area=none")).totalItems, total - 1);
  for (const status of Object.values(TaskStatus)) {
    const result = await get(`status=${status}&pageSize=100`);
    assert.equal(result.totalItems, baseline.summary.counts[status]);
    assert.ok(result.items.every((item: { status: string }) => item.status === status));
  }
  for (const priority of Object.values(TaskPriority)) {
    const result = await get(`priority=${priority}&pageSize=100`);
    assert.equal(result.totalItems, await prisma.task.count({ where: { archivedAt: null, deletedAt: null, priority } }));
  }
  for (const sort of ["newest", "oldest", "deadline", "priority", "planning", "completed"]) {
    const all = await prisma.task.findMany({ where: { archivedAt: null, deletedAt: null } });
    const order = all.sort((a, b) => {
      const newest = b.createdAt.getTime() - a.createdAt.getTime();
      let comparison = sort === "oldest" ? -newest : newest;
      if (sort === "deadline" || sort === "planning" || sort === "completed") {
        const key = (x: typeof a) => sort === "deadline" ? x.dueAt?.getTime() ?? Infinity : sort === "planning" ? x.plannedAt?.getTime() ?? Infinity : Infinity;
        comparison = key(a) - key(b) || newest;
      } else if (sort === "priority") comparison = Object.values(TaskPriority).indexOf(b.priority) - Object.values(TaskPriority).indexOf(a.priority) || newest;
      return comparison || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    }).map((x) => x.id);
    const result: string[] = [];
    for (let page = 1; page <= 3; page++) result.push(...(await get(`sort=${sort}&pageSize=50&page=${page}`)).items.map((x: { id: string }) => x.id));
    assert.deepEqual(result, order, sort);
  }
  for (const size of [20, 50, 100]) {
    const one = await get(`pageSize=${size}`), two = await get(`pageSize=${size}&page=2`);
    assert.equal(one.items.length, size); assert.equal(two.items.length, Math.min(size, total - size));
    assert.equal(new Set([...one.items, ...two.items].map((x) => x.id)).size, one.items.length + two.items.length);
    const last = await get(`pageSize=${size}&page=${Math.ceil(total / size)}`);
    assert.equal(last.hasNextPage, false); assert.equal(last.hasPreviousPage, true);
  }
  const beyond = await get("page=999"); assert.deepEqual(beyond.items, []); assert.equal(beyond.page, 999); assert.equal(beyond.totalItems, total);
  assert.equal(beyond.hasPreviousPage, true); assert.equal(beyond.hasNextPage, false);
  const huge = await get("page=9007199254740991&pageSize=100");
  assert.deepEqual(huge.items, []); assert.equal(huge.page, Number.MAX_SAFE_INTEGER); assert.equal(huge.totalItems, total);
  const empty = await get("q=missing&page=999");
  assert.deepEqual([empty.items, empty.totalItems, empty.totalPages, empty.hasPreviousPage, empty.hasNextPage], [[], 0, 0, false, false]);
  for (const [query, expected] of [
    ["q=перевірка&dateField=due&from=2026-10-25&to=2026-10-25&timezone=Europe/Kyiv", [first.id]],
    ["dateField=due&from=2026-10-26&timezone=Europe/Kyiv", [second.id]],
    ["q=перевірка&dateField=due&to=2026-10-25&timezone=Europe/Kyiv", [first.id]],
    ["from=2026-10-25&to=2026-10-25&timezone=Europe/Kyiv", [first.id]],
    ["dateField=created&from=2026-10-25", []],
    ["dateField=completed&from=2026-01-01", []],
  ] as const) assert.deepEqual((await get(query)).items.map((x: { id: string }) => x.id).sort(), [...expected].sort(), query);

  // Compare complete DTO to legacy GET, including children and historical summary.
  await prisma.subtask.create({ data: { taskId: first.id, title: "Child", estimatedDurationMinutes: 5 } });
  assert.equal((await get("q=Child")).totalItems, 0);
  const legacy = await (await fetch(`${base}?timezone=UTC`)).json();
  const searched = await get(`area=${area.id}`);
  assert.ok(Array.isArray(legacy)); assert.deepEqual(searched.items[0], legacy.find((x: { id: string }) => x.id === first.id));
  for (const size of [20, 100]) {
    queries.length = 0; clockCalls = 0;
    const result = await get(`pageSize=${size}`);
    assert.equal(clockCalls, 1); assert.equal(result.items.length, size);
    assert.ok(queries.length <= 10, `bounded SQL queries: ${queries.length}`);
    const historyReads = queries.filter((q) => q.includes('FROM "') && q.includes('"TaskAction"') && !q.includes("WITH base"));
    assert.equal(historyReads.length, 1);
  }

  // Journal differential checks against the existing helper, before pagination.
  const completedIds: string[] = [];
  const cases = ["done", "repeat", "reopen", "redone", "missing", "duplicateCreation", "badIdentity", "badDate", "badBefore",
    "chain", "malformed", "tie", "future", "beforeBirth", "creationAfter", "bornDone", "budget",
    "offsetDate", "legacyDate", "extraPrecision", "relativeDate", "epoch"];
  for (const name of cases) {
    const task = await create({ title: `history ${name}`, status: name === "reopen" ? "TODO" : "DONE" });
    const start = task.createdAt.getTime();
    const action = (seconds: number, type: "CREATED" | "STATUS_CHANGED", metadata: Prisma.InputJsonValue) => ({
      id: randomUUID(), taskId: task.id, type, timestamp: new Date(start + seconds * 1000), metadata,
    });
    const creation = action(0, "CREATED", { before: null, after: { id: task.id, createdAt: task.createdAt.toISOString(), status: "TODO" } });
    const change = (seconds: number, before: string, after: string) => action(seconds, "STATUS_CHANGED", { before: { status: before }, after: { status: after } });
    let actions = [creation, change(10, "TODO", "DONE")];
    if (name === "repeat") actions.push(change(20, "DONE", "DONE"));
    if (name === "reopen" || name === "redone") actions.push(change(20, "DONE", "TODO"));
    if (name === "redone") actions.push(change(30, "TODO", "DONE"));
    if (name === "missing") actions.shift();
    if (name === "duplicateCreation") actions.push({ ...creation, id: randomUUID() });
    if (name === "badIdentity") creation.metadata = { before: null, after: { id: randomUUID(), createdAt: task.createdAt.toISOString(), status: "TODO" } };
    if (name === "badDate") creation.metadata = { before: null, after: { id: task.id, createdAt: "nonsense", status: "TODO" } };
    const creationDates: Record<string, string> = { offsetDate: "2026-01-01T02:00:00+02:00", legacyDate: "Thu, 01 Jan 2026 00:00:00 GMT",
      extraPrecision: "2026-01-01T00:00:00.0009Z", relativeDate: "now", epoch: "epoch" };
    if (creationDates[name]) creation.metadata = { before: null, after: { id: task.id, createdAt: creationDates[name], status: "TODO" } };
    if (name === "badBefore") creation.metadata = { after: { id: task.id, createdAt: task.createdAt.toISOString(), status: "TODO" } };
    if (name === "chain") actions[1] = change(10, "PAUSED", "DONE");
    if (name === "malformed") actions.push(action(20, "STATUS_CHANGED", {}));
    if (name === "tie") actions.push(change(10, "DONE", "TODO"), change(10, "TODO", "DONE"));
    if (name === "future") actions[1].timestamp = new Date(asOf.getTime() + 1);
    if (name === "beforeBirth") actions[1].timestamp = new Date(start - 1);
    if (name === "creationAfter") creation.timestamp = new Date(start + 11000);
    if (name === "bornDone") actions = [{ ...creation, metadata: { before: null, after: { id: task.id, createdAt: task.createdAt.toISOString(), status: "DONE" } } }];
    if (name === "budget") for (let i = 0; i < 9999; i++) actions.push(change(20 + i, "DONE", "DONE"));
    await prisma.taskAction.createMany({ data: actions });
    const journal = await prisma.taskAction.findMany({ where: { taskId: task.id } });
    const expected = verifiedTaskCompletion(task, journal, asOf).completedAt;
    const selected = await createTasksRepository(() => prisma).transaction((tx) => tx.search(searchTasksSchema.parse({ q: `history ${name}`, dateField: "completed", from: "2026-01-01" }), asOf));
    assert.deepEqual(selected.ids, expected ? [task.id] : [], name);
    const response = await get(`q=${encodeURIComponent(`history ${name}`)}&sort=completed`);
    assert.equal(response.items[0].completedAt, expected?.toISOString() ?? null, name);
    if (expected) completedIds.push(task.id);
  }
  assert.equal((await get("q=history&dateField=completed&from=2026-01-01&to=2026-01-01")).totalItems, completedIds.length);
  const completed = await get("q=history&sort=completed&pageSize=100");
  const known = completed.items.filter((x: { completedAt: string | null }) => x.completedAt !== null);
  assert.deepEqual(known.map((x: { id: string }) => x.id).sort(), completedIds.sort());
  assert.deepEqual(known.map((x: { completedAt: string }) => x.completedAt), known.map((x: { completedAt: string }) => x.completedAt).sort());
  assert.deepEqual(known.map((x: { id: string }) => x.id), [...known].sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id)).map((x) => x.id));
  assert.ok(completed.items.slice(known.length).every((x: { completedAt: string | null }) => x.completedAt === null));
  assert.equal((await get("q=history&dateField=completed&from=2026-01-02")).totalItems, 0);
  assert.equal((await get("q=history&dateField=completed&to=2026-01-01")).totalItems, completedIds.length);
  queries.length = 0; clockCalls = 0;
  await get("sort=completed&pageSize=20");
  assert.equal(clockCalls, 1);
  assert.ok(queries.length <= 11, `bounded completed queries: ${queries.length}`);

  // Full occurrence window is evaluated in its own timezone, personal plans override it.
  const routine = await prisma.routine.create({ data: { title: "Window", estimatedDurationMinutes: 5, timezone: "America/New_York", startDate: "2026-03-07", schedule: {}, endCondition: {} } });
  const version = await prisma.routineScheduleVersion.create({ data: { routineId: routine.id, number: 1, effectiveDate: "2026-03-07", effectiveTimezone: routine.timezone, effectiveAt: new Date("2026-03-07T05:00:00Z"), timezone: routine.timezone, startDate: routine.startDate, schedule: {}, endCondition: {} } });
  const occurrence = await prisma.routineOccurrence.create({ data: { routineId: routine.id, scheduleVersionId: version.id, occurrenceKey: "window", startDate: "2026-03-07", endDate: "2026-03-09", timezone: routine.timezone, snapshot: {} } });
  const window = await create({ routineOccurrenceId: occurrence.id, title: "window", status: "SKIPPED" });
  assert.equal((await get("sort=planning")).items[0].id, window.id);
  for (const query of ["from=2026-03-08&to=2026-03-08", "from=2026-03-10&to=2026-03-10", "from=2026-03-08", "to=2026-03-08"]) {
    assert.equal((await get(`q=window&${query}`)).totalItems, 1, query);
  }
  assert.equal((await get("q=window&from=2026-03-11")).totalItems, 0);
  const exactEnd = await create({ title: "spring", dueAt: new Date("2026-03-29T20:59:59.999Z") });
  await create({ title: "spring", dueAt: new Date("2026-03-29T21:00:00.000Z") });
  assert.deepEqual((await get("q=spring&dateField=due&from=2026-03-29&to=2026-03-29&timezone=Europe/Kyiv")).items.map((x: { id: string }) => x.id), [exactEnd.id]);
  assert.equal((await get("status=SKIPPED")).summary.counts.SKIPPED, 1);
  assert.equal((await get("q=window&sort=planning")).items[0].id, window.id);
  await prisma.task.update({ where: { id: window.id }, data: { plannedAt: new Date("2026-04-01T12:00:00Z") } });
  assert.equal((await get("q=window&from=2026-03-08&to=2026-03-08")).totalItems, 0);
  assert.equal((await get("q=window&from=2026-04-01&to=2026-04-01")).totalItems, 1);
  const fold = await prisma.routineOccurrence.create({ data: { routineId: routine.id, scheduleVersionId: version.id,
    occurrenceKey: "fold", startDate: "2026-11-01", endDate: "2026-11-01", timezone: "America/Havana", snapshot: {} } });
  const foldTask = await create({ routineOccurrenceId: fold.id, title: "midnight fold" });
  assert.deepEqual((await get("q=midnight&from=2026-10-31&to=2026-10-31&timezone=America/Chicago")).items.map((x: { id: string }) => x.id), [foldTask.id]);
  assert.equal((await get("from=2011-12-30&to=2011-12-30&timezone=Pacific/Apia")).totalItems, 0);

  // Commit an independent mutation between SQL selection and DTO hydration.
  // A single real Serializable snapshot must retain the selected Task and counts.
  let changed = false;
  const wrapped = new Proxy(prisma, { get(target, property) {
    if (property !== "$transaction") return Reflect.get(target, property);
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => target.$transaction(async (tx) => {
      const reader = new Proxy(tx, { get(transaction, key) {
        if (key !== "$queryRaw") return Reflect.get(transaction, key);
        return async (...args: unknown[]) => {
          const result = await (transaction.$queryRaw as (...values: unknown[]) => Promise<unknown>)(...args);
          if (!changed) {
            changed = true;
            await prisma.task.update({ where: { id: first.id }, data: { archivedAt: asOf, title: "Changed concurrently" } });
          }
          return result;
        };
      } });
      return work(reader);
    }, options);
  } });
  const snapshot = await createTasksService(createTasksRepository(() => wrapped), () => asOf).search(searchTasksSchema.parse({ area: area.id }));
  assert.equal(changed, true); assert.equal(snapshot.totalItems, 1); assert.equal(snapshot.items[0].title, first.title);
  assert.equal((await get(`area=${area.id}`)).totalItems, 0, "subsequent HTTP request observes the mutation");
});
