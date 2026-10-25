import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./helpers/api-fixture";

const massage = { title: "Масаж", estimatedDurationMinutes: 30, timezone: "Europe/Kyiv", startDate: "2026-10-25",
  schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 2 }, localTime: "18:00" },
  endCondition: { type: "UNTIL_DATE", date: "2026-11-07" } };
const range = { from: "2026-10-25", to: "2026-11-07" };
const rangeQuery = `?from=${range.from}&to=${range.to}`;
type Preview = { occurrenceKey: string; startDate: string; endDate: string; instant: string | null; existing: boolean };

test("generation-preview is read-only; partial planning applies to 3 of 7 Tasks and CREATED snapshots in UTC", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-12-01T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...massage, subtasks: [{ title: "Prepare", estimatedDurationMinutes: 10 }] })).body;
  const before = structuredClone(f.state());
  const preview = await f.routineRequest("GET", `/${r.id}/generation-preview${rangeQuery}`);
  assert.equal(preview.status, 200); assert.equal(preview.body.occurrences.length, 7);
  assert.ok(preview.body.occurrences.every((entry: Preview) => entry.existing === false));
  assert.deepEqual(f.state(), before);
  const occurrences: Preview[] = preview.body.occurrences;
  const planning = [
    { occurrenceKey: occurrences[0].occurrenceKey, plannedAt: "2026-10-25T16:00:00+02:00" },
    { occurrenceKey: occurrences[2].occurrenceKey, plannedAt: "2026-10-29T19:45:00+05:45" },
    { occurrenceKey: occurrences[6].occurrenceKey, plannedAt: "2026-12-20T09:00:00-05:00" }, // deliberately outside the original window
  ];
  const expected = new Map(planning.map((entry) => [entry.occurrenceKey, new Date(entry.plannedAt).toISOString()]));
  const generated = await f.routineRequest("POST", `/${r.id}/generate`, { ...range, planning });
  assert.equal(generated.status, 200); assert.equal(generated.body.createdCount, 7);
  assert.deepEqual(Object.keys(generated.body).sort(), ["routineId", "from", "to", "createdCount", "existingCount", "created", "existing"].sort());
  assert.equal(f.state().tasks.filter((entry) => entry.plannedAt !== null).length, 3);
  for (const pair of generated.body.created) {
    const task = (await f.request("GET", `/${pair.taskId}`)).body;
    assert.equal(task.plannedAt, expected.get(pair.occurrenceKey) ?? null); assert.equal(task.dueAt, null);
    assert.equal(task.summary.historyIncomplete, false); assert.equal(task.summary.ageSeconds, 0);
    assert.equal(task.estimatedDurationMinutes, 10); assert.equal(task.subtasks[0].status, "TODO");
    const source = occurrences.find((entry) => entry.occurrenceKey === pair.occurrenceKey)!;
    assert.equal(task.routineOccurrence.startDate, source.startDate); assert.equal(task.routineOccurrence.endDate, source.endDate);
    assert.equal(task.routineOccurrence.instant, source.instant);
    const created = f.state().actions.find((entry) => entry.taskId === pair.taskId && entry.type === "CREATED")!;
    assert.equal((created.metadata as { after: { plannedAt: string | null } }).after.plannedAt, task.plannedAt);
    assert.deepEqual(f.state().actions.filter((entry) => entry.taskId === pair.taskId).map((entry) => entry.type), ["CREATED", "SUBTASK_CREATED"]);
  }
  assert.deepEqual((await f.routineRequest("GET", `/${r.id}`)).body, r);
});

test("old generate requests and empty planning retain null defaults", async (t) => {
  const f = await fixture(t);
  for (const extra of [{}, { planning: [] }]) {
    const r = (await f.routineRequest("POST", "", massage)).body;
    const response = await f.routineRequest("POST", `/${r.id}/generate`, { ...range, ...extra });
    assert.equal(response.status, 200); assert.equal(response.body.createdCount, 7);
  }
  assert.ok(f.state().tasks.every((entry) => entry.plannedAt === null));
});

test("planning validation rejects invalid timestamps, duplicates, foreign/unknown/out-of-range keys and oversized arrays before writes", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", massage)).body;
  const preview = (await f.routineRequest("GET", `/${r.id}/generation-preview${rangeQuery}`)).body;
  const key = preview.occurrences[0].occurrenceKey;
  const valid = { occurrenceKey: key, plannedAt: "2026-10-25T14:00:00Z" };
  const foreignRoutine = (await f.routineRequest("POST", "", massage)).body;
  const foreignKey = (await f.routineRequest("POST", `/${foreignRoutine.id}/generate`, range)).body.created[0].occurrenceKey;
  const invalid = [null, {}, [{ occurrenceKey: key }], [{ plannedAt: valid.plannedAt }], [{ ...valid, extra: true }], [valid, valid],
    ...[null, 42, "", "2026-10-25", "2026-10-25T14:00:00", "2026-02-30T14:00:00Z", "2026-10-25T14:00:00+24:00"].map((plannedAt) => [{ ...valid, plannedAt }]),
    [{ ...valid, occurrenceKey: "" }], [{ ...valid, occurrenceKey: "unknown-key" }],
    [{ ...valid, occurrenceKey: foreignKey }],
    [{ ...valid, occurrenceKey: `v1:${randomUUID()}:daily:2026-10-25` }],
    [{ ...valid, occurrenceKey: `v1:${r.id}:daily:2026-11-08` }],
    Array.from({ length: 101 }, (_, index) => ({ ...valid, occurrenceKey: `unknown-${index}` }))];
  const before = structuredClone(f.state()), operations = f.operations.length;
  for (const planning of invalid) {
    const response = await f.routineRequest("POST", `/${r.id}/generate`, { ...range, planning });
    assert.equal(response.status, 400, JSON.stringify(planning));
    assert.deepEqual(f.state(), before);
  }
  assert.ok(f.operations.slice(operations).every((operation) => operation.startsWith("routine-lock:")), "no occurrence, Task or event writes were attempted");
  const outside = preview.occurrences[1].occurrenceKey;
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-25", to: "2026-10-25", planning: [{ ...valid, occurrenceKey: outside }] })).status, 400);
});

test("repeat/network retry ignores changed planning for existing, DONE and deleted Tasks without new events", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", massage)).body;
  const candidates: Preview[] = (await f.routineRequest("GET", `/${r.id}/generation-preview${rangeQuery}`)).body.occurrences;
  const first = (await f.routineRequest("POST", `/${r.id}/generate`, { ...range,
    planning: [{ occurrenceKey: candidates[0].occurrenceKey, plannedAt: "2026-12-20T10:00:00Z" }] })).body;
  await f.request("PATCH", `/${first.created[0].taskId}`, { status: "DONE" });
  await f.request("DELETE", `/${first.created[1].taskId}`);
  const before = structuredClone(f.state());
  const retry = await f.routineRequest("POST", `/${r.id}/generate`, { ...range,
    planning: candidates.map((entry) => ({ occurrenceKey: entry.occurrenceKey, plannedAt: "2027-01-01T10:00:00Z" })) });
  assert.equal(retry.status, 200); assert.equal(retry.body.createdCount, 0); assert.deepEqual(retry.body.existing, first.created);
  assert.deepEqual(f.state(), before);
  const preview = await f.routineRequest("GET", `/${r.id}/generation-preview${rangeQuery}`);
  assert.ok(preview.body.occurrences.every((entry: Preview) => entry.existing));
  for (const entry of preview.body.occurrences) {
    assert.deepEqual(Object.keys(entry).sort(), ["occurrenceKey", "startDate", "endDate", "timezone", "localTime", "instant", "diagnostics", "existing"].sort());
  }
  assert.equal((await f.request("GET", `/${first.created[1].taskId}`)).status, 404);
  assert.deepEqual(f.state(), before);
});

test("concurrent different planning keeps the creator's plan and snapshot; retries never overwrite it", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", massage)).body;
  const key = (await f.routineRequest("GET", `/${r.id}/generation-preview?from=2026-10-25&to=2026-10-25`)).body.occurrences[0].occurrenceKey;
  const plans = ["2026-12-01T10:00:00Z", "2026-12-02T10:00:00Z"];
  f.commitConflicts(1);
  const responses = await Promise.all(plans.map((plannedAt) => f.routineRequest("POST", `/${r.id}/generate`, {
    from: "2026-10-25", to: "2026-10-25", planning: [{ occurrenceKey: key, plannedAt }],
  })));
  assert.ok(responses.every((response) => response.status === 200));
  const winner = responses.findIndex((response) => response.body.createdCount === 1);
  assert.notEqual(winner, -1); assert.equal(responses[1 - winner].body.createdCount, 0);
  assert.equal(f.state().tasks.length, 1); assert.equal(f.state().tasks[0].plannedAt!.toISOString(), new Date(plans[winner]).toISOString());
  assert.equal((f.state().actions[0].metadata as { after: { plannedAt: string } }).after.plannedAt, new Date(plans[winner]).toISOString());
});

test("planning rolls back the entire new batch when a later journal write fails", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", massage)).body;
  const occurrences: Preview[] = (await f.routineRequest("GET", `/${r.id}/generation-preview${rangeQuery}`)).body.occurrences;
  const before = structuredClone(f.state()); f.failEvents(3);
  const response = await f.routineRequest("POST", `/${r.id}/generate`, { ...range,
    planning: occurrences.slice(0, 3).map((entry) => ({ occurrenceKey: entry.occurrenceKey, plannedAt: "2026-12-20T10:00:00Z" })) });
  assert.equal(response.status, 500); assert.deepEqual(f.state(), before);
});

test("AFTER_COMPLETION generation-preview resolves saved completion; stale planning fails instead of targeting another successor", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...massage, endCondition: { type: "NEVER" },
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } } })).body;
  const firstRange = { from: "2026-10-25", to: "2026-10-25" };
  const firstPreview = (await f.routineRequest("GET", `/${r.id}/generation-preview?from=${firstRange.from}&to=${firstRange.to}`)).body;
  assert.equal(firstPreview.occurrences.length, 1);
  const first = await f.routineRequest("POST", `/${r.id}/generate`, { ...firstRange,
    planning: [{ occurrenceKey: firstPreview.occurrences[0].occurrenceKey, plannedAt: "2026-10-25T16:00:00+02:00" }] });
  assert.equal(first.status, 200); assert.equal(f.state().tasks[0].plannedAt!.toISOString(), "2026-10-25T14:00:00.000Z");
  f.setTime(new Date("2026-10-26T10:00:00Z"));
  await f.request("PATCH", `/${first.body.created[0].taskId}`, { status: "DONE" });
  const before = structuredClone(f.state());
  const nextPreview = await f.routineRequest("GET", `/${r.id}/generation-preview?from=2026-10-28&to=2026-10-28`);
  assert.equal(nextPreview.status, 200); assert.equal(nextPreview.body.occurrences[0].occurrenceKey, `v1:${r.id}:completion:2`);
  assert.equal(nextPreview.body.occurrences[0].existing, false); assert.deepEqual(f.state(), before);
  // Change the real basis so ordinal 2 now falls outside the previewed range.
  f.setTime(new Date("2026-10-27T10:00:00Z")); await f.request("PATCH", `/${first.body.created[0].taskId}`, { status: "TODO" });
  f.setTime(new Date("2026-10-28T10:00:00Z")); await f.request("PATCH", `/${first.body.created[0].taskId}`, { status: "DONE" });
  const unchanged = structuredClone(f.state());
  const stale = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-28", to: "2026-10-28",
    planning: [{ occurrenceKey: nextPreview.body.occurrences[0].occurrenceKey, plannedAt: "2026-10-28T18:00:00Z" }] });
  assert.equal(stale.status, 400); assert.match(stale.body.error.message, /Refresh generation-preview/); assert.deepEqual(f.state(), unchanged);
  const fresh = (await f.routineRequest("GET", `/${r.id}/generation-preview?from=2026-10-30&to=2026-10-30`)).body;
  const next = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-30", to: "2026-10-30",
    planning: [{ occurrenceKey: fresh.occurrences[0].occurrenceKey, plannedAt: "2026-11-01T09:00:00+02:00" }] });
  assert.equal(next.status, 200); assert.equal(next.body.createdCount, 1);
  const saved = structuredClone(f.state());
  const retry = await f.routineRequest("POST", `/${r.id}/generate`, { from: "2026-10-30", to: "2026-10-30",
    planning: [{ occurrenceKey: fresh.occurrences[0].occurrenceKey, plannedAt: "2027-01-01T10:00:00Z" }] });
  assert.equal(retry.status, 200); assert.equal(retry.body.createdCount, 0); assert.deepEqual(f.state(), saved);
});

test("planning and generation-preview cannot bypass DST, paused state, COUNT or completion-chain validation", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T10:00:00Z"));
  const r = (await f.routineRequest("POST", "", { ...massage, endCondition: { type: "COUNT", count: 1 },
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } } })).body;
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { ...range, planning: [
    { occurrenceKey: `v1:${r.id}:completion:1`, plannedAt: "2026-10-25T10:00:00Z" },
    { occurrenceKey: `v1:${r.id}:completion:2`, plannedAt: "2026-10-27T10:00:00Z" },
  ] })).status, 400);
  await f.routineRequest("POST", `/${r.id}/generate`, range);
  const before = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${r.id}/generate`, { ...range,
    planning: [{ occurrenceKey: `v1:${r.id}:completion:2`, plannedAt: "2026-10-27T10:00:00Z" }] })).status, 400);
  assert.deepEqual(f.state(), before);
  await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
  assert.equal((await f.routineRequest("GET", `/${r.id}/generation-preview${rangeQuery}`)).status, 409);
  const dst = (await f.routineRequest("POST", "", { ...massage, schedule: { ...massage.schedule, localTime: "03:30" } })).body;
  assert.equal((await f.routineRequest("GET", `/${dst.id}/generation-preview${rangeQuery}`)).status, 409);
  assert.equal((await f.routineRequest("POST", `/${dst.id}/generate`, { ...range,
    planning: [{ occurrenceKey: `v1:${dst.id}:daily:2026-10-25`, plannedAt: "2026-10-25T10:00:00Z" }] })).status, 409);
});

test("generation-preview validates its own range contract and never writes, including for completed/deleted existing Tasks", async (t) => {
  const f = await fixture(t);
  const r = (await f.routineRequest("POST", "", massage)).body;
  for (const query of ["", "?from=2026-10-25", "?from=2026-02-30&to=2026-03-01", "?from=2026-11-01&to=2026-10-25",
    "?from=2026-01-01&to=2027-01-02", `${rangeQuery}&limit=100`, `${rangeQuery}&planning=x`,
    `${rangeQuery}&completedAt=2026-10-25T12:00:00Z&completedOccurrenceNumber=1`]) {
    assert.equal((await f.routineRequest("GET", `/${r.id}/generation-preview${query}`)).status, 400, query);
  }
  assert.equal((await f.routineRequest("GET", `/invalid/generation-preview${rangeQuery}`)).status, 400);
  assert.equal((await f.routineRequest("GET", `/${randomUUID()}/generation-preview${rangeQuery}`)).status, 404);
  const before = structuredClone(f.state());
  f.failEvents(); f.failOccurrences(); f.failTaskWrites(); f.failRoutineWrites(); f.failSubtasks();
  assert.equal((await f.routineRequest("GET", `/${r.id}/generation-preview${rangeQuery}`)).status, 200);
  assert.deepEqual(f.state(), before);
});
