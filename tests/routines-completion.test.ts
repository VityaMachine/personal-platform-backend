import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers/api-fixture";
import { verifiedTaskCompletion } from "../src/modules/tasks/tasks.completion";

const input = { title: "Замінити фільтр", estimatedDurationMinutes: 15, timezone: "Europe/Kyiv", startDate: "2026-10-25",
  schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 }, localTime: null } };
const firstRange = { from: "2026-10-25", to: "2026-10-25" };
const nextRange = { from: "2026-10-26", to: "2026-11-07" };

test("first execution is anchored to startDate; retries are existing and uncovered ranges wait for DONE", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", input)).body;
  const generate = (range = firstRange) => f.routineRequest("POST", `/${r.id}/generate`, range);
  const before = structuredClone(f.state());
  assert.equal((await generate({ from: "2026-10-26", to: "2026-10-30" })).body.createdCount, 0);
  assert.deepEqual(f.state(), before);
  const first = await generate(); assert.equal(first.status, 200); assert.equal(first.body.createdCount, 1);
  const occurrence = f.state().occurrences[0];
  assert.equal(occurrence.startDate, input.startDate); assert.equal(occurrence.occurrenceNumber, 1);
  assert.equal(occurrence.previousOccurrenceId, null); assert.equal(occurrence.basisCompletedAt, null);
  assert.equal(occurrence.instant, null); assert.equal(occurrence.occurrenceKey, `v1:${r.id}:completion:1`);
  const snapshot = structuredClone(f.state());
  const repeat = await generate({ from: "2026-10-24", to: "2026-10-28" });
  assert.equal(repeat.status, 200); assert.deepEqual(repeat.body.existing, first.body.created);
  assert.deepEqual(f.state(), snapshot);
  assert.equal((await generate(nextRange)).status, 409);
  for (const extra of [{ completedAt: "2026-10-26T00:00:00Z" }, { completedOccurrenceNumber: 1 }]) {
    assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { ...nextRange, ...extra })).status, 400);
  }
});

test("actual DONE determines local next date; edits and archive do not change basis; preview uses the same calculation", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, schedule: { ...input.schedule, localTime: "09:00" } })).body;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0];
  f.setTime(new Date("2026-10-26T23:30:00Z")); // Kyiv: Oct 27, +2 calendar days = Oct 29
  assert.equal((await f.request("PATCH", `/${first.taskId}`, { status: "DONE" })).status, 200);
  f.setTime(new Date("2026-10-28T12:00:00Z"));
  await f.request("PATCH", `/${first.taskId}`, { title: "Edited after DONE", archived: true });
  assert.equal((await f.request("GET", `/${first.taskId}`)).body.completedAt, "2026-10-26T23:30:00.000Z");
  const second = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-29", to: "2026-10-29" });
  assert.equal(second.status, 200); assert.equal(second.body.createdCount, 1);
  const occurrence = f.state().occurrences[1];
  assert.equal(occurrence.startDate, "2026-10-29"); assert.equal(occurrence.instant!.toISOString(), "2026-10-29T07:00:00.000Z");
  assert.equal(occurrence.basisCompletedAt!.toISOString(), "2026-10-26T23:30:00.000Z");
  assert.equal(occurrence.occurrenceNumber, 2); assert.equal(occurrence.previousOccurrenceId, f.state().occurrences[0].id);
  const before = structuredClone(f.state());
  const repeat = await f.routineRequest("POST", `/${r.id}/generate`, nextRange);
  assert.equal(repeat.status, 200); assert.deepEqual(repeat.body.existing, second.body.created);
  const preview = await f.routineRequest("GET", `/${r.id}/preview?from=2026-10-29&to=2026-10-29&completedAt=2026-10-26T23:30:00Z&completedOccurrenceNumber=1`);
  assert.equal(preview.body.occurrences[0].occurrenceKey, occurrence.occurrenceKey);
  assert.equal(preview.body.occurrences[0].startDate, occurrence.startDate);
  assert.deepEqual(f.state(), before);
  const dto = (await f.request("GET", `/${second.body.created[0].taskId}`)).body;
  assert.equal(dto.routineOccurrence.occurrenceNumber, 2);
  assert.equal(dto.routineOccurrence.basisCompletedAt, "2026-10-26T23:30:00.000Z");
  assert.equal(dto.summary.historyIncomplete, false); assert.equal(dto.summary.ageSeconds, 0);
});

test("automatic DONE through Subtasks is a real completion and copies new TODO children", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, subtasks: [{ title: "Replace", estimatedDurationMinutes: 10 }] })).body;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0];
  const task = (await f.request("GET", `/${first.taskId}`)).body;
  f.setTime(new Date("2026-10-27T10:00:00Z"));
  await f.request("PATCH", `/${task.id}/subtasks/${task.subtasks[0].id}`, { status: "DONE" });
  assert.equal((await f.request("GET", `/${task.id}`)).body.status, "DONE");
  const generated = await f.routineRequest("POST", `/${r.id}/generate`, nextRange);
  assert.equal(generated.status, 200); assert.equal(generated.body.createdCount, 1);
  const next = (await f.request("GET", `/${generated.body.created[0].taskId}`)).body;
  assert.equal(next.routineOccurrence.startDate, "2026-10-29");
  assert.equal(next.routineOccurrence.basisCompletedAt, "2026-10-27T10:00:00.000Z");
  assert.equal(next.status, "TODO"); assert.equal(next.subtasks[0].status, "TODO");
  assert.notEqual(next.subtasks[0].id, task.subtasks[0].id);
});

test("reopening before generation waits; reopening/recompletion of a predecessor never moves its saved successor", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", input)).body;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0];
  f.setTime(new Date("2026-10-26T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
  f.setTime(new Date("2026-10-27T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "TODO" });
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, nextRange)).status, 409);
  f.setTime(new Date("2026-10-28T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
  const second = (await f.routineRequest("POST", `/${r.id}/generate`, nextRange)).body.created[0];
  assert.equal(f.state().occurrences[1].startDate, "2026-10-30");
  const saved = structuredClone(f.state().occurrences);
  f.setTime(new Date("2026-10-29T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "IN_PROGRESS" });
  f.setTime(new Date("2026-10-30T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
  const retry = await f.routineRequest("POST", `/${r.id}/generate`, nextRange);
  assert.equal(retry.status, 200); assert.deepEqual(retry.body.existing, [second]); assert.equal(retry.body.createdCount, 0);
  assert.deepEqual(f.state().occurrences, saved);
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-11-01", to: "2026-11-07" })).status, 409);
  f.setTime(new Date("2026-10-31T10:00:00Z")); await f.request("PATCH", `/${second.taskId}`, { status: "DONE" });
  const third = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-11-01", to: "2026-11-07" });
  assert.equal(third.status, 200); assert.equal(third.body.createdCount, 1);
  assert.equal(f.state().occurrences[2].startDate, "2026-11-02");
});

test("cancellation/deletion stop continuation but retries return the same IDs; active statuses wait", async (t) => {
  for (const mode of ["CANCELED", "deleted", "IN_PROGRESS", "PAUSED", "POSTPONED"] as const) {
    const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
    const r = (await f.routineRequest("POST", "", input)).body;
    const first = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0];
    f.setTime(new Date("2026-10-26T10:00:00Z"));
    if (mode === "deleted") await f.request("DELETE", `/${first.taskId}`);
    else await f.request("PATCH", `/${first.taskId}`, { status: mode, ...(mode === "CANCELED" ? { cancellationNote: "Stopped" } : {}) });
    const before = structuredClone(f.state());
    assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, nextRange)).status, 409, mode);
    const retry = await f.routineRequest("POST", `/${r.id}/generate`, firstRange);
    assert.equal(retry.status, 200); assert.deepEqual(retry.body.existing, [first]);
    assert.deepEqual(f.state(), before);
  }
});

test("COUNT counts stored occurrences and UNTIL_DATE is inclusive; out-of-range requests have no writes", async (t) => {
  for (const endCondition of [{ type: "COUNT", count: 2 }, { type: "UNTIL_DATE", date: "2026-10-28" }] as const) {
    const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
    const r = (await f.routineRequest("POST", "", { ...input, endCondition })).body;
    const first = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0];
    f.setTime(new Date("2026-10-26T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
    const snapshot = structuredClone(f.state());
    assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-27", to: "2026-10-27" })).body.createdCount, 0);
    assert.deepEqual(f.state(), snapshot);
    const next = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-28", to: "2026-10-28" });
    assert.equal(next.body.createdCount, 1);
    f.setTime(new Date("2026-10-29T10:00:00Z")); await f.request("DELETE", `/${next.body.created[0].taskId}`);
    assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-11-01", to: "2026-11-07" })).body.createdCount, 0);
  }
});

test("current pause blocks and past pause candidates require a decision instead of shifting", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", input)).body;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0];
  f.setTime(new Date("2026-10-26T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
  f.setTime(new Date("2026-10-27T10:00:00Z")); await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).status, 409);
  f.setTime(new Date("2026-10-29T10:00:00Z")); await f.routineRequest("PATCH", `/${r.id}`, { paused: false });
  const before = structuredClone(f.state());
  const response = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-28", to: "2026-10-28" });
  assert.equal(response.status, 409); assert.match(response.body.error.message, /past pause/);
  assert.deepEqual(f.state(), before);
});

test("DST rejects first and next unresolved times; calendar days across DST preserve local time", async (t) => {
  for (const date of ["2026-03-29", "2026-10-25"]) {
    const f = await fixture(t); f.setTime(new Date("2026-01-01T10:00:00Z"));
    const r = (await f.routineRequest("POST", "", { ...input, startDate: date, schedule: { ...input.schedule, localTime: "03:30" } })).body;
    assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { from: date, to: date })).status, 409);
    assert.equal(f.state().occurrences.length, 0);
  }
  const f = await fixture(t); f.setTime(new Date("2026-10-20T10:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, startDate: "2026-10-23", schedule: { ...input.schedule, localTime: "09:00" } })).body;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-23", to: "2026-10-23" })).body.created[0];
  f.setTime(new Date("2026-10-24T08:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
  const next = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-26", to: "2026-10-26" });
  assert.equal(next.status, 200); assert.equal(f.state().occurrences[1].instant!.toISOString(), "2026-10-26T07:00:00.000Z");
});

test("completion history gaps, missing creation, ties and budgets reject without writes", async (t) => {
  for (const mode of ["missing", "gap", "tie", "budget"] as const) {
    const f = await fixture(t); f.setTime(new Date("2026-10-20T10:00:00Z"));
    const r = (await f.routineRequest("POST", "", input)).body;
    const first = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0];
    f.setTime(new Date("2026-10-26T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
    if (mode === "missing") f.state().actions = f.state().actions.filter((action) => action.type !== "CREATED");
    if (mode === "gap") (f.state().actions.find((action) => action.type === "STATUS_CHANGED")!.metadata as { before: { status: string } }).before.status = "IN_PROGRESS";
    if (mode === "tie") {
      await f.request("PATCH", `/${first.taskId}`, { status: "TODO" });
      await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
    }
    if (mode === "budget") f.state().actions = Array.from({ length: 10001 }, () => f.state().actions[0]);
    const before = structuredClone(f.state());
    assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, nextRange)).status, 409, mode);
    assert.deepEqual(f.state(), before);
  }
});

test("concurrent requests and serialization retries create one successor; journal failure rolls back all writes", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T10:00:00Z"));
  const r = (await f.routineRequest("POST", "", input)).body;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0];
  f.setTime(new Date("2026-10-26T10:00:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "DONE" });
  f.commitConflicts(1);
  const responses = await Promise.all([1, 2].map(() => f.routineRequest("POST", `/${r.id}/generate`, nextRange)));
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual(responses.map((response) => response.body.createdCount).sort(), [0, 1]);
  assert.equal(f.state().occurrences.length, 2);
  const next = responses.find((response) => response.body.createdCount === 1)!.body.created[0];
  f.setTime(new Date("2026-10-29T10:00:00Z")); await f.request("PATCH", `/${next.taskId}`, { status: "DONE" });
  const before = structuredClone(f.state()); f.failEvents();
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-31", to: "2026-10-31" })).status, 500);
  assert.deepEqual(f.state(), before);
});

test("completion helper ignores same-status DONE and unrelated edits, but rejects a fabricated initial DONE", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T10:00:00Z"));
  const r = (await f.routineRequest("POST", "", input)).body;
  const id = (await f.routineRequest("POST", `/${r.id}/generate`, firstRange)).body.created[0].taskId;
  f.setTime(new Date("2026-10-26T10:00:00Z")); await f.request("PATCH", `/${id}`, { status: "DONE" });
  const task = f.state().tasks[0];
  const actions = structuredClone(f.state().actions);
  actions.push({ ...actions[1], id: "00000000-0000-4000-8000-000000000001", timestamp: new Date("2026-10-27T10:00:00Z"),
    metadata: { before: { status: "DONE" }, after: { status: "DONE" } } });
  assert.equal(verifiedTaskCompletion(task, actions, new Date("2026-10-28T10:00:00Z")).completedAt!.toISOString(), "2026-10-26T10:00:00.000Z");
  assert.equal(verifiedTaskCompletion(task, [{ ...actions[0], metadata: { after: { status: "DONE" } } }], new Date("2026-10-28T10:00:00Z")).completedAt, null);
});

test("next DST gap, first past pause, chain budget and exhausted COUNT have explicit outcomes", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-03-20T10:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, startDate: "2026-03-25", schedule: { ...input.schedule, localTime: "03:30" } })).body;
  const id = (await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-03-25", to: "2026-03-25" })).body.created[0].taskId;
  f.setTime(new Date("2026-03-27T10:00:00Z")); await f.request("PATCH", `/${id}`, { status: "DONE" });
  const before = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-03-29", to: "2026-03-29" })).status, 409);
  assert.deepEqual(f.state(), before);
  const paused = (await f.routineRequest("POST", "", input)).body;
  f.setTime(new Date("2026-10-24T10:00:00Z")); await f.routineRequest("PATCH", `/${paused.id}`, { paused: true });
  f.setTime(new Date("2026-10-26T10:00:00Z")); await f.routineRequest("PATCH", `/${paused.id}`, { paused: false });
  assert.equal((await f.routineRequest("POST", `/${paused.id}/generate`, firstRange)).status, 409);
  const counted = (await f.routineRequest("POST", "", { ...input, endCondition: { type: "COUNT", count: 1 } })).body;
  const one = (await f.routineRequest("POST", `/${counted.id}/generate`, firstRange)).body.created[0];
  await f.request("PATCH", `/${one.taskId}`, { status: "CANCELED", cancellationNote: "No replacement" });
  assert.equal((await f.routineRequest("POST", `/${counted.id}/generate`, nextRange)).body.createdCount, 0);
  const stored = f.state().occurrences.find((entry) => entry.routineId === r.id)!;
  f.state().occurrences.push(...Array.from({ length: 10000 }, (_, index) => ({ ...stored, id: `budget-${index}` })));
  const budget = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-03-29", to: "2026-03-29" });
  assert.equal(budget.status, 409); assert.match(budget.body.error.message, /budget/);
});
