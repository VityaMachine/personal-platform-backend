import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { app } from "../src/app";
import type { Task, TaskAction, Subtask, Area } from "../src/generated/prisma/client";
import { calculateTaskSummary, type TaskSummary } from "../src/modules/tasks/tasks.summary";

import { fixture, input } from "./helpers/api-fixture";

const initialSubtasks = [
  { title: "  Update task list  ", estimatedDurationMinutes: 40 },
  { title: "Check on mobile", estimatedDurationMinutes: 20 },
];

test("Areas create, rename and physically delete; lists sort by name then ID and names need not be unique", async (t) => {
  const f = await fixture(t);
  const first = await f.createArea("  Work  ");
  const second = await f.createArea("Work");
  const third = await f.createArea("Health");
  assert.equal(first.name, "Work");
  assert.notEqual(first.id, second.id);
  assert.deepEqual(Object.keys(first).sort(), ["createdAt", "id", "name", "updatedAt"]);
  assert.equal(new Date(first.createdAt).toISOString(), first.createdAt);
  const list = (await f.areaRequest("GET")).body;
  assert.deepEqual(list.map((area: Area) => area.id), [third.id, ...[first.id, second.id].sort()]);
  const renamed = await f.areaRequest("PATCH", `/${first.id}`, { name: "  Personal  " });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, "Personal");
  assert.equal((await f.areaRequest("GET")).body.length, 3);
  assert.deepEqual(await f.areaRequest("DELETE", `/${first.id}`), { status: 204, body: null });
  assert.equal(f.state().areas.some((area) => area.id === first.id), false);
  assert.equal((await f.areaRequest("GET")).body.length, 2);
  assert.equal((await f.areaRequest("DELETE", `/${first.id}`)).status, 404);
  assert.equal((await f.areaRequest("PATCH", `/${first.id}`, { name: "Missing" })).status, 404);
  assert.equal(f.state().actions.length, 0);
  const logs = f.logs.map((line) => JSON.parse(line));
  assert.ok(logs.every((entry) => entry.requestId && entry.path.startsWith("/api/areas")));
  assert.equal(new Set(logs.map((entry) => entry.requestId)).size, logs.length);
  assert.ok(!f.logs.join("").includes("Personal"), "request body is not logged");
});

test("Areas reject invalid names, IDs, body/query types and unknown fields before transactions", async (t) => {
  const f = await fixture(t);
  const invalidNames = ["", " \t ", "x".repeat(81), null, 1, true, [], {}];
  const invalid = [null, [], "name", {}, ...invalidNames.map((name) => ({ name })),
    { name: "Valid", archived: false }, { name: "Valid", extra: true }];
  for (const body of invalid) assert.equal((await f.areaRequest("POST", "", body)).status, 400, JSON.stringify(body));
  for (const query of ["?archived=true", "?archived=false", "?archived=1", "?archived=", "?archived=true&archived=false", "?unknown=true"]) {
    assert.equal((await f.areaRequest("GET", query)).status, 400);
  }
  assert.equal(f.attempts(), 0);
  const area = await f.createArea("x".repeat(80));
  const attempts = f.attempts();
  for (const body of [null, [], {}, { unknown: true }, { archived: true }, { archived: false }, { name: "Valid", archived: true }, { archived: "true" }, { archived: null },
    { name: "Valid", extra: true }, ...invalidNames.map((name) => ({ name }))]) {
    const result = await f.areaRequest("PATCH", `/${area.id}`, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.ok(result.body.error.message);
  }
  assert.deepEqual(await f.areaRequest("PATCH", "/bad-id", {}), {
    status: 400, body: { error: { message: "Invalid area id." } },
  });
  assert.equal(f.attempts(), attempts);
  assert.equal((await f.areaRequest("DELETE", "/bad-id")).status, 400);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const path = method === "POST" ? "" : `/${area.id}`;
    assert.equal((await f.areaRequest(method, path + "?archived=false", method === "DELETE" ? undefined : { name: "Valid" })).status, 400);
  }
  assert.equal((await f.areaRequest("DELETE", `/${area.id}`, { archived: true })).status, 400);
  assert.equal((await f.areaRequest("DELETE", `/${randomUUID()}`)).status, 404);
  assert.deepEqual(await f.areaRequest("PATCH", `/${randomUUID()}`, { name: "Missing" }), {
    status: 404, body: { error: { message: "Area not found." } },
  });
  const error = await f.areaRequest("POST", "", { name: "" });
  assert.deepEqual(error.body.error.details.map((detail: { path: string[] }) => detail.path), [["name"]]);
});

test("Tasks create with omitted/null/assigned area and subtasks, preserving summary and snapshots", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-24T00:00:00Z"));
  const area = await f.createArea();
  for (const subtasks of [undefined, [], initialSubtasks]) {
    for (const field of [{}, { areaId: null }, { areaId: area.id }]) {
      const result = await f.request("POST", "", { ...input, ...field, ...(subtasks ? { subtasks } : {}) });
      assert.equal(result.status, 201);
      const task = result.body;
      const assigned = "areaId" in field && field.areaId !== null;
      assert.equal(task.areaId, assigned ? area.id : null);
      assert.deepEqual(task.area, assigned ? { id: area.id, name: area.name } : null);
      assert.equal(task.summary.historyIncomplete, false);
      assert.equal(task.summary.ageSeconds, 0);
      assert.equal(task.isCompleted, false);
      assert.equal(task.subtasks.length, subtasks?.length ?? 0);
      assert.equal(task.estimatedDurationMinutes, subtasks?.length ? 60 : 45);
      for (const child of task.subtasks) assert.equal("areaId" in child, false);
      const actions = f.state().actions.filter((action) => action.taskId === task.id);
      const after = (actions.find((action) => action.type === "CREATED")!.metadata as { after: Record<string, unknown> }).after;
      assert.equal(after.areaId, task.areaId);
      assert.deepEqual(after.area, assigned ? { id: area.id, name: area.name } : null);
      assert.equal(actions.some((action) => action.type === "AREA_CHANGED"), false);
      assert.deepEqual((await f.request("GET", `/${task.id}`)).body, task);
    }
  }
  const reads = { ...f.reads };
  const list = (await f.request("GET")).body;
  assert.equal(list.length, 9);
  assert.equal(f.reads.tasks - reads.tasks, 1);
  assert.equal(f.reads.history - reads.history, 1);
  assert.equal(f.reads.areas - reads.areas, 0);
  assert.equal(f.reads.areaLocks - reads.areaLocks, 0);
  assert.ok(list.every((task: { areaId: string | null; area: unknown }) => task.areaId ? task.area !== null : task.area === null));
});

test("Task area changes and clearing are journaled once; historical names survive Area edits", async (t) => {
  const f = await fixture(t);
  f.setTime(new Date("2026-10-24T00:00:00Z"));
  const first = await f.createArea("Original");
  const second = await f.createArea("Second");
  const created = await f.request("POST", "", { ...input, areaId: first.id });
  const id = created.body.id;
  const snapshot = (area: Area) => ({ areaId: area.id, area: { id: area.id, name: area.name } });
  const creation = structuredClone(f.state().actions[0]);
  await f.areaRequest("PATCH", `/${first.id}`, { name: "Renamed" });
  assert.deepEqual(f.state().actions, [creation]);
  const unchanged = await f.request("PATCH", `/${id}`, { areaId: first.id });
  assert.equal(unchanged.body.area.name, "Renamed");
  assert.equal(f.state().actions.length, 1);
  const omitted = await f.request("PATCH", `/${id}`, { title: "Edited" });
  assert.equal(omitted.body.areaId, first.id);
  const changed = await f.request("PATCH", `/${id}`, { areaId: second.id });
  assert.deepEqual(changed.body.area, { id: second.id, name: second.name });
  const event = f.state().actions.find((action) => action.type === "AREA_CHANGED")!;
  assert.deepEqual(event.metadata, {
    before: snapshot({ ...first, name: "Renamed" }), after: snapshot(second),
  });
  const originalEvent = structuredClone(event);
  await f.areaRequest("PATCH", `/${first.id}`, { name: "Renamed again" });
  await f.areaRequest("PATCH", `/${second.id}`, { name: "Also renamed" });
  const cleared = await f.request("PATCH", `/${id}`, { areaId: null });
  assert.equal(cleared.body.areaId, null);
  assert.equal(cleared.body.area, null);
  assert.deepEqual(f.state().actions.at(-1)!.metadata, {
    before: snapshot({ ...second, name: "Also renamed" }), after: { areaId: null, area: null },
  });
  assert.deepEqual(event, originalEvent);
  assert.deepEqual(f.state().actions[0], creation);
  assert.deepEqual(cleared.body.summary, created.body.summary);
  const count = f.state().actions.length;
  await f.request("PATCH", `/${id}`, { areaId: null });
  assert.equal(f.state().actions.length, count);
  const history = (await f.request("GET", `/${id}/history`)).body;
  assert.deepEqual(history.find((action: TaskAction) => action.id === creation.id), JSON.parse(JSON.stringify(creation)));
  assert.deepEqual(history.find((action: TaskAction) => action.id === event.id), JSON.parse(JSON.stringify(originalEvent)));
});

test("same-ID assignments are event-free and lock Area before writing Task", async (t) => {
  const f = await fixture(t);
  const area = await f.createArea();
  const first = (await f.request("POST", "", { ...input, areaId: area.id })).body;
  const count = f.state().actions.length;
  const operations = f.operations.length;
  assert.equal((await f.request("PATCH", `/${first.id}`, { areaId: area.id })).status, 200);
  assert.equal((await f.request("PATCH", `/${first.id}`, { areaId: area.id.toUpperCase() })).status, 200);
  assert.equal(f.state().actions.length, count);
  assert.deepEqual(f.operations.slice(operations), [
    `area-lock:${area.id}`, `task-update:${first.id}`,
    `area-lock:${area.id}`, `task-update:${first.id}`,
  ]);
});

test("Task area validation rejects malformed IDs and missing/deleted Areas without changing data", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  const area = await f.createArea();
  await f.areaRequest("DELETE", `/${area.id}`);
  const before = structuredClone(f.state());
  for (const [method, path] of [["POST", ""], ["PATCH", `/${task.id}`]]) {
    for (const areaId of ["bad-id", "", 1, {}, []]) {
      assert.equal((await f.request(method, path, { ...(method === "POST" ? input : {}), areaId })).status, 400);
    }
    for (const [areaId, status] of [[randomUUID(), 404], [area.id, 404]]) {
      assert.equal((await f.request(method, path, { ...(method === "POST" ? input : {}), areaId })).status, status);
    }
  }
  assert.deepEqual(f.state(), before);
  assert.equal((await f.request("POST", `/${task.id}/subtasks`, { title: "Child", estimatedDurationMinutes: 10, areaId: area.id })).status, 400);
});

test("area assignment and atomic creation roll back on event/subtask failures and retry without duplication", async (t) => {
  for (const atomic of [false, true]) {
    for (let failureAt = 0; failureAt < (atomic ? 3 : 1); failureAt++) {
      const f = await fixture(t);
      const area = await f.createArea();
      const before = structuredClone(f.state());
      f.failEvents(failureAt);
      const result = await f.request("POST", "", { ...input, areaId: area.id, ...(atomic ? { subtasks: initialSubtasks } : {}) });
      assert.equal(result.status, 500);
      assert.deepEqual(f.state(), before);
    }
  }
  const f = await fixture(t);
  const area = await f.createArea();
  const task = await f.create();
  const before = structuredClone(f.state());
  f.failEvents();
  assert.equal((await f.request("PATCH", `/${task.id}`, { areaId: area.id, status: "IN_PROGRESS" })).status, 500);
  assert.deepEqual(f.state(), before);
  const nested = await fixture(t);
  const nestedArea = await nested.createArea();
  nested.failSubtasks(1);
  assert.equal((await nested.request("POST", "", { ...input, areaId: nestedArea.id, subtasks: initialSubtasks })).status, 500);
  assert.equal(nested.state().tasks.length, 0);
  assert.equal(nested.state().actions.length, 0);
  assert.equal(nested.state().subtasks.length, 0);
  const retry = await fixture(t);
  const retryArea = await retry.createArea();
  retry.commitConflicts(2);
  const created = await retry.request("POST", "", { ...input, areaId: retryArea.id, subtasks: initialSubtasks });
  assert.equal(created.status, 201);
  assert.equal(retry.state().tasks.length, 1);
  assert.equal(retry.state().subtasks.length, 2);
  assert.equal(retry.state().actions.length, 3);
  assert.equal(created.body.summary.historyIncomplete, false);
  retry.commitConflicts(2);
  assert.equal((await retry.request("PATCH", `/${created.body.id}`, { areaId: null })).status, 200);
  assert.equal(retry.state().actions.filter((action) => action.type === "AREA_CHANGED").length, 1);
});

test("assignment retries revalidate a concurrently deleted Area; Areas also retry serialization conflicts", async (t) => {
  for (const method of ["POST", "PATCH"]) {
    const f = await fixture(t);
    const area = await f.createArea();
    const task = await f.create();
    const before = structuredClone(f.state());
    const attempts = f.attempts();
    f.deleteOnAssignmentConflict(area.id, method === "POST" ? "P2034" : "P2010");
    const result = await f.request(method, method === "POST" ? "" : `/${task.id}`,
      { ...(method === "POST" ? input : {}), areaId: area.id });
    assert.equal(result.status, 404);
    assert.equal(f.attempts() - attempts, 2);
    assert.deepEqual(f.state().tasks, before.tasks);
    assert.deepEqual(f.state().actions, before.actions);
    assert.equal(f.state().areas.length, 0);
  }
  const f = await fixture(t);
  f.commitConflicts(2);
  const area = await f.createArea();
  assert.equal(f.state().areas.length, 1);
  assert.equal(f.attempts(), 3);
  f.commitConflicts(2);
  assert.equal((await f.areaRequest("PATCH", `/${area.id}`, { name: "Renamed" })).status, 200);
  const before = structuredClone(f.state());
  f.conflicts(3);
  assert.equal((await f.areaRequest("PATCH", `/${area.id}`, { name: "Conflict" })).status, 409);
  assert.deepEqual(f.state(), before);
  f.deleteOnAssignmentConflict(area.id, "P2010");
  assert.equal((await f.areaRequest("PATCH", `/${area.id}`, { name: "After raw conflict" })).status, 404);
});

test("deleting Area detaches every linked task including archived/deleted, preserving snapshots, summary and other fields", async (t) => {
  const f = await fixture(t);
  const at = (seconds: number) => new Date(Date.parse("2026-10-24T00:00:00Z") + seconds * 1000);
  f.setTime(at(0));
  const area = await f.createArea("Original");
  const otherArea = await f.createArea("Other");
  const ids: string[] = [];
  for (const status of ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"] as const) {
    const task = (await f.request("POST", "", { ...input, areaId: area.id, subtasks: initialSubtasks })).body;
    ids.push(task.id);
    f.setTime(at(10));
    await f.request("PATCH", `/${task.id}`, { status, ...(status === "CANCELED" ? { cancellationNote: "Reason" } : {}) });
  }
  await f.request("PATCH", `/${ids[1]}`, { archived: true });
  await f.request("DELETE", `/${ids[2]}`);
  await f.request("PATCH", `/${ids[3]}`, { archived: true });
  await f.request("DELETE", `/${ids[3]}`);
  await f.request("POST", "", { ...input, areaId: otherArea.id });
  await f.create();
  await f.areaRequest("PATCH", `/${area.id}`, { name: "Name at deletion" });
  // Simulate an older snapshot; history must be returned verbatim, including archivedAt.
  const creation = f.state().actions.find((action) => action.taskId === ids[0] && action.type === "CREATED")!;
  const metadata = creation.metadata as { after: { area: { id: string; name: string; archivedAt?: string } } };
  metadata.after.area.archivedAt = at(5).toISOString();
  const before = structuredClone(f.state());
  f.setTime(at(100));
  const summaries = new Map(before.tasks.map((task) => [task.id,
    calculateTaskSummary(task, before.actions.filter((action) => action.taskId === task.id), at(100))]));
  const dtoBefore = (await f.request("GET", `/${ids[0]}`)).body;
  const operationIndex = f.operations.length;
  assert.deepEqual(await f.areaRequest("DELETE", `/${area.id}`), { status: 204, body: null });
  assert.equal(f.state().areas.some((candidate) => candidate.id === area.id), false);
  assert.equal(f.state().areas.length, 1);
  assert.equal(f.state().tasks.length, before.tasks.length);
  assert.deepEqual(f.state().subtasks, before.subtasks);
  assert.deepEqual(f.state().actions.slice(0, before.actions.length), before.actions);
  const events = f.state().actions.slice(before.actions.length);
  assert.deepEqual(events.map((event) => event.taskId), [...ids].sort());
  for (const task of f.state().tasks) {
    const previous = before.tasks.find((entry) => entry.id === task.id)!;
    if (ids.includes(task.id)) {
      assert.deepEqual(task, { ...previous, areaId: null, updatedAt: at(100) });
      const event = events.find((entry) => entry.taskId === task.id)!;
      assert.equal(event.type, "AREA_CHANGED");
      assert.deepEqual(event.metadata, {
        before: { areaId: area.id, area: { id: area.id, name: "Name at deletion" } },
        after: { areaId: null, area: null },
      });
    } else assert.deepEqual(task, previous);
    assert.deepEqual(calculateTaskSummary(task, f.state().actions.filter((action) => action.taskId === task.id), at(100)), summaries.get(task.id));
  }
  assert.deepEqual(f.operations.slice(operationIndex), [
    `area-lock:${area.id}`, `linked-tasks:${area.id}`,
    ...[...ids].sort().flatMap((id) => [`task-update:${id}`, `event:${id}:AREA_CHANGED`]),
    `area-delete:${area.id}`,
  ]);
  const dtoAfter = (await f.request("GET", `/${ids[0]}`)).body;
  assert.deepEqual(dtoAfter, { ...dtoBefore, areaId: null, area: null, updatedAt: at(100).toISOString() });
  const history = (await f.request("GET", `/${ids[0]}/history`)).body;
  assert.deepEqual(history.find((entry: TaskAction) => entry.id === creation.id), JSON.parse(JSON.stringify(creation)));
  assert.equal((await f.areaRequest("DELETE", `/${area.id}`)).status, 404);
  assert.equal(f.state().actions.length, before.actions.length + ids.length);
});

test("Area deletion rolls back every task/event and Area on partial journal, task-write or delete failures", async (t) => {
  for (const failure of ["event-first", "event-middle", "event-last", "task-first", "task-middle", "task-last", "area-delete"] as const) {
    const f = await fixture(t);
    const area = await f.createArea();
    for (let index = 0; index < 3; index++) await f.request("POST", "", { ...input, areaId: area.id });
    const before = structuredClone(f.state());
    const position = failure.endsWith("first") ? 0 : failure.endsWith("middle") ? 1 : 2;
    if (failure.startsWith("event")) f.failEvents(position);
    else if (failure.startsWith("task")) f.failTaskWrites(position);
    else f.failAreaDelete();
    assert.deepEqual(await f.areaRequest("DELETE", `/${area.id}`), {
      status: 500, body: { error: { message: "Internal server error." } },
    }, failure);
    assert.deepEqual(f.state(), before, failure);
  }
});

test("Area deletion retries the whole transaction without duplicate events and exhausted retries preserve links", async (t) => {
  const f = await fixture(t);
  const area = await f.createArea();
  for (let index = 0; index < 3; index++) await f.request("POST", "", { ...input, areaId: area.id });
  const before = structuredClone(f.state());
  const attempts = f.attempts();
  f.commitConflicts(3);
  assert.equal((await f.areaRequest("DELETE", `/${area.id}`)).status, 409);
  assert.equal(f.attempts() - attempts, 3);
  assert.deepEqual(f.state(), before);
  f.commitConflicts(2);
  assert.equal((await f.areaRequest("DELETE", `/${area.id}`)).status, 204);
  assert.equal(f.attempts() - attempts, 6);
  const events = f.state().actions.filter((action) => action.type === "AREA_CHANGED");
  assert.equal(events.length, 3);
  assert.equal(new Set(events.map((event) => event.taskId)).size, 3);
  assert.ok(f.state().tasks.every((task) => task.areaId === null));
  assert.equal(f.state().areas.length, 0);
});

test("same-ID assignment, rename and repeat deletion recheck existence after a simulated concurrent deletion", async (t) => {
  for (const operation of ["same-assignment", "rename", "delete"] as const) {
    const f = await fixture(t);
    const area = await f.createArea();
    const task = (await f.request("POST", "", { ...input, areaId: area.id })).body;
    f.deleteOnAssignmentConflict(area.id, "P2010");
    const result = operation === "same-assignment"
      ? await f.request("PATCH", `/${task.id}`, { areaId: area.id })
      : await f.areaRequest(operation === "rename" ? "PATCH" : "DELETE", `/${area.id}`, operation === "rename" ? { name: "Rename" } : undefined);
    assert.deepEqual(result, { status: 404, body: { error: { message: "Area not found." } } });
    assert.equal(f.state().areas.length, 0);
    assert.equal(f.state().tasks[0].areaId, null);
    assert.equal(f.state().actions.filter((action) => action.type === "AREA_CHANGED").length, 1);
  }
});

test("fixed-clock Task responses share summary contract and include just-written manual and automatic events", async (t) => {
  const f = await fixture(t);
  const at = (seconds: number) => new Date(Date.parse("2026-10-22T00:00:00Z") + seconds * 1000);
  f.setTime(at(0));
  const created = await f.request("POST", "", input);
  const id = created.body.id;
  const expected = (age: number, working: number, todo: number, completion: number | null = null) => ({
    asOf: at(age).toISOString(), ageSeconds: age, inProgressSeconds: working,
    timeToCompletionSeconds: completion,
    statusDurationsSeconds: { TODO: todo, IN_PROGRESS: working, PAUSED: 0, POSTPONED: 0 },
    historyIncomplete: false, historyIssues: [],
  });
  assert.deepEqual(created.body.summary, expected(0, 0, 0));
  f.setTime(at(10));
  const updated = await f.request("PATCH", `/${id}`, { status: "IN_PROGRESS" });
  assert.deepEqual(updated.body.summary, expected(10, 0, 10));
  f.setTime(at(30));
  const edited = await f.request("PATCH", `/${id}`, { title: "Edited", archived: true });
  const detail = await f.request("GET", `/${id}`);
  const historyReads = f.reads.history;
  const list = await f.request("GET", "?archived=true");
  assert.equal(f.reads.history - historyReads, 1);
  for (const task of [edited.body, detail.body, list.body[0]]) {
    assert.deepEqual(task.summary, expected(30, 20, 10));
    assert.deepEqual(task.subtasks, []);
    assert.equal(task.isCompleted, false);
    assert.equal(task.estimatedDurationMinutes, 45);
  }
  f.setTime(at(40));
  const done = await f.request("PATCH", `/${id}`, { status: "DONE", archived: false });
  assert.deepEqual(done.body.summary, expected(40, 30, 10, 40));
  f.setTime(at(60));
  const child = await f.createSubtask(id, { status: "IN_PROGRESS" });
  f.setTime(at(80));
  assert.deepEqual((await f.request("GET", `/${id}`)).body.summary, expected(80, 50, 10));
  await f.request("PATCH", `/${id}/subtasks/${child.id}`, { status: "DONE" });
  f.setTime(at(100));
  const completed = (await f.request("GET", `/${id}`)).body.summary;
  assert.deepEqual(completed, { ...expected(80, 50, 10, 80), asOf: at(100).toISOString() });
  // A missing event must be visible through the public DTO; reads do not repair history.
  f.state().actions.splice(0, 1);
  const before = structuredClone(f.state());
  const incomplete = (await f.request("GET", `/${id}`)).body.summary;
  assert.equal(incomplete.historyIncomplete, true);
  assert.equal(incomplete.inProgressSeconds, null);
  assert.equal(incomplete.ageSeconds, null);
  assert.deepEqual(f.state(), before);
});

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
  const { routineOccurrenceId: _occurrenceId, ...parentDto } = JSON.parse(JSON.stringify(parent));
  const expectedChildren = JSON.parse(JSON.stringify([...f.state().subtasks].reverse()));
  assert.deepEqual(result.body, {
    ...parentDto, routineOccurrence: null, area: null, isCompleted: false, subtasks: expectedChildren,
    summary: calculateTaskSummary(parent, f.state().actions, new Date(result.body.summary.asOf)),
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
  assert.deepEqual(created.metadata, { before: null, after: { ...JSON.parse(JSON.stringify(parent)), area: null } });
  for (const [index, action] of children.entries()) {
    assert.equal(action.taskId, parent.id);
    assert.deepEqual(action.metadata, {
      subtaskId: ids[index], before: null, after: JSON.parse(JSON.stringify(f.state().subtasks[index])),
    });
  }
  const detail = (await f.request("GET", `/${parent.id}`)).body;
  assert.deepEqual({ ...detail, summary: result.body.summary }, result.body);
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
  assert.deepEqual(f.state(), { tasks: [], subtasks: [], actions: [], areas: [], routines: [], routineSubtasks: [], routineActions: [], occurrences: [] });
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
  assert.deepEqual(action.metadata, { before: null, after: { ...JSON.parse(JSON.stringify(f.state().tasks[0])), area: null } });
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
  assert.deepEqual(action.metadata, { before: null, after: { ...JSON.parse(JSON.stringify(f.state().tasks[0])), area: null } });
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
  assert.equal(f.reads.history - beforeReads.history, 1);
  assert.equal(new Set(list.body.map((task: { summary: TaskSummary }) => task.summary.asOf)).size, 1);
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
