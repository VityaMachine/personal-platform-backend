import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers/api-fixture";
import { verifiedTaskCompletion } from "../src/modules/tasks/tasks.completion";

const input = { title: "Routine execution", estimatedDurationMinutes: 15, timezone: "Europe/Kyiv", startDate: "2026-10-23",
  schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 }, localTime: "09:00" } };
const firstRange = { from: "2026-10-23", to: "2026-10-23" };
const nextRange = { from: "2026-10-24", to: "2026-11-07" };
async function setup(t: TestContext, patch: Record<string, unknown> = {}) {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00:00Z"));
  const routine = (await f.routineRequest("POST", "", { ...input, ...patch })).body;
  const first = await f.routineRequest("POST", `/${routine.id}/generate`, firstRange);
  assert.equal(first.status, 200);
  const id = first.body.created[0].taskId as string;
  f.setTime(new Date("2026-10-25T12:00:00Z"));
  return { f, routine, id };
}

test("SKIPPED requires a Routine Task; ordinary POST and Subtask create/PATCH stay restricted", async (t) => {
  const { f, id } = await setup(t, { subtasks: [{ title: "Child", estimatedDurationMinutes: 5 }] });
  const ordinaryInput = { title: "Ordinary", dueAt: "2026-10-25T12:00:00Z", estimatedDurationMinutes: 5 };
  const ordinary = (await f.request("POST", "", ordinaryInput)).body;
  assert.equal(ordinary.skipNote, null); assert.equal(ordinary.skippedAt, null);
  const before = structuredClone(f.state());
  for (const extra of [{ status: "SKIPPED" }, { status: "SKIPPED", subtasks: [{ title: "Child", estimatedDurationMinutes: 5 }] }, { skipNote: "Reason" }]) {
    assert.equal((await f.request("POST", "", { ...ordinaryInput, ...extra })).status, 400);
  }
  assert.equal((await f.request("PATCH", `/${ordinary.id}`, { status: "SKIPPED" })).status, 400);
  assert.equal((await f.request("PATCH", `/${ordinary.id}`, { skipNote: "Reason" })).status, 400);
  const child = f.state().subtasks[0].id;
  assert.equal((await f.request("POST", `/${id}/subtasks`, { title: "Bad", estimatedDurationMinutes: 5, status: "SKIPPED" })).status, 400);
  assert.equal((await f.request("PATCH", `/${id}/subtasks/${child}`, { status: "SKIPPED" })).status, 400);
  for (const skipNote of ["", "  ", "x".repeat(2001), 1, false, {}]) {
    assert.equal((await f.request("PATCH", `/${id}`, { status: "SKIPPED", skipNote })).status, 400);
  }
  for (const extra of [{ skippedAt: "2026-10-25T12:00:00Z" }, { completedAt: "2026-10-25T12:00:00Z" }]) {
    assert.equal((await f.request("PATCH", `/${id}`, { status: "SKIPPED", ...extra })).status, 400);
  }
  assert.deepEqual(f.state(), before);
});

test("skip/reason edits are atomic, trim notes, preserve current skippedAt and leave children unchanged", async (t) => {
  const { f, id } = await setup(t, { subtasks: [{ title: "Child", estimatedDurationMinutes: 5 }] });
  const children = structuredClone(f.state().subtasks);
  const skipped = await f.request("PATCH", `/${id}`, { status: "SKIPPED", skipNote: "  Not this time  " });
  assert.equal(skipped.status, 200); assert.equal(skipped.body.skipNote, "Not this time");
  assert.equal(skipped.body.skippedAt, "2026-10-25T12:00:00.000Z");
  assert.equal(skipped.body.completedAt, null); assert.equal(skipped.body.isCompleted, false);
  assert.equal(skipped.body.isToday, false); assert.equal(skipped.body.isBacklog, false);
  assert.equal(skipped.body.archivedAt, null); assert.equal(skipped.body.deletedAt, null);
  assert.equal(skipped.body.summary.historyIncomplete, false);
  assert.deepEqual(f.state().subtasks, children);
  const transition = f.state().actions.at(-1)!;
  assert.equal(transition.type, "STATUS_CHANGED");
  assert.deepEqual(transition.metadata, { before: { status: "TODO", cancellationNote: null, skipNote: null },
    after: { status: "SKIPPED", cancellationNote: null, skipNote: "Not this time" } });
  assert.deepEqual((await f.request("GET", `/${id}`)).body, skipped.body);
  assert.deepEqual((await f.request("GET")).body, [skipped.body]);
  assert.deepEqual((await f.request("GET", "?view=today&overdueMode=all")).body, []);
  assert.deepEqual((await f.request("GET", "?view=backlog")).body, []);
  const actions = f.state().actions.length;
  f.setTime(new Date("2026-10-26T12:00:00Z"));
  for (const body of [{ status: "SKIPPED", skipNote: "Not this time" }, { status: "SKIPPED" }]) {
    const repeat = (await f.request("PATCH", `/${id}`, body)).body;
    assert.equal(repeat.skippedAt, skipped.body.skippedAt); assert.equal(f.state().actions.length, actions);
    assert.equal(repeat.summary.ageSeconds, skipped.body.summary.ageSeconds);
    assert.deepEqual(repeat.summary.statusDurationsSeconds, skipped.body.summary.statusDurationsSeconds);
  }
  const edited = (await f.request("PATCH", `/${id}`, { skipNote: "  Updated  " })).body;
  assert.equal(edited.skipNote, "Updated"); assert.equal(edited.skippedAt, skipped.body.skippedAt);
  assert.equal(f.state().actions.at(-1)!.type, "EDITED");
  assert.deepEqual(f.state().actions.at(-1)!.metadata, { before: { skipNote: "Not this time" }, after: { skipNote: "Updated" } });
  const cleared = (await f.request("PATCH", `/${id}`, { skipNote: null })).body;
  assert.equal(cleared.skipNote, null); assert.equal(cleared.skippedAt, skipped.body.skippedAt);
  assert.deepEqual(f.state().subtasks, children);
});

test("reopening clears reasons; DONE can change to SKIPPED; new skip with omitted/null reason starts clean", async (t) => {
  const { f, id } = await setup(t);
  await f.request("PATCH", `/${id}`, { status: "CANCELED", cancellationNote: "Canceled" });
  f.setTime(new Date("2026-10-25T12:01:00Z"));
  let result = (await f.request("PATCH", `/${id}`, { status: "SKIPPED", skipNote: "x".repeat(2000) })).body;
  assert.equal(result.cancellationNote, null); assert.equal(result.skipNote.length, 2000);
  f.setTime(new Date("2026-10-25T12:02:00Z"));
  result = (await f.request("PATCH", `/${id}`, { status: "TODO", skipNote: null })).body;
  assert.equal(result.skipNote, null); assert.equal(result.skippedAt, null); assert.equal(result.completedAt, null);
  assert.equal(result.isBacklog, true); assert.equal(result.summary.historyIncomplete, false);
  f.setTime(new Date("2026-10-25T12:03:00Z"));
  result = (await f.request("PATCH", `/${id}`, { status: "DONE" })).body;
  assert.equal(result.isCompleted, true); assert.equal(result.completedAt, "2026-10-25T12:03:00.000Z");
  f.setTime(new Date("2026-10-25T12:04:00Z"));
  result = (await f.request("PATCH", `/${id}`, { status: "SKIPPED" })).body;
  assert.equal(result.skipNote, null); assert.equal(result.completedAt, null); assert.equal(result.isCompleted, false);
  assert.equal(result.skippedAt, "2026-10-25T12:04:00.000Z");
  assert.equal(result.summary.timeToCompletionSeconds, null);
  f.setTime(new Date("2026-10-25T12:05:00Z"));
  await f.request("PATCH", `/${id}`, { status: "TODO" });
  f.setTime(new Date("2026-10-25T12:06:00Z"));
  result = (await f.request("PATCH", `/${id}`, { status: "SKIPPED", skipNote: null, archived: true })).body;
  assert.equal(result.skipNote, null); assert.equal(result.skippedAt, "2026-10-25T12:06:00.000Z");
  assert.ok(result.archivedAt); assert.equal((await f.request("GET", `/${id}`)).body.skippedAt, result.skippedAt);
  assert.equal((await f.request("PATCH", `/${id}`, { status: "TODO" })).status, 200, "archived Task follows existing PATCH rules");
  await f.request("DELETE", `/${id}`);
  assert.equal((await f.request("PATCH", `/${id}`, { status: "SKIPPED" })).status, 404);
});

test("subtask synchronization can reopen a skipped parent and clears its note without cascading", async (t) => {
  const { f, id } = await setup(t, { subtasks: [{ title: "Child", estimatedDurationMinutes: 5 }] });
  const child = f.state().subtasks[0].id;
  for (const status of ["TODO", "IN_PROGRESS", "DONE"] as const) {
    f.setTime(new Date(f.state().tasks[0].updatedAt.getTime() + 60000));
    await f.request("PATCH", `/${id}`, { status: "SKIPPED", skipNote: "Skip" });
    f.setTime(new Date(f.state().tasks[0].updatedAt.getTime() + 60000));
    assert.equal((await f.request("PATCH", `/${id}/subtasks/${child}`, { status, title: status })).status, 200);
    const result = (await f.request("GET", `/${id}`)).body;
    assert.equal(result.status, status); assert.equal(result.skipNote, null); assert.equal(result.skippedAt, null);
    assert.equal(result.summary.historyIncomplete, false);
    assert.equal(result.completedAt !== null, status === "DONE");
    const action = f.state().actions.at(-1)!.metadata as { before: { skipNote: string }; after: { skipNote: null } };
    assert.equal(action.before.skipNote, "Skip"); assert.equal(action.after.skipNote, null);
  }
});

test("journal failures roll back status/reason and serialization retries do not duplicate skip events", async (t) => {
  for (const failAfter of [0, 1]) {
    const { f, id } = await setup(t);
    const before = structuredClone(f.state()); f.failEvents(failAfter);
    assert.equal((await f.request("PATCH", `/${id}`, { status: "SKIPPED", skipNote: "Rollback" })).status, 500);
    assert.deepEqual(f.state(), before);
  }
  const { f, id } = await setup(t); f.commitConflicts(2);
  const clock = f.taskClockCalls();
  const result = await f.request("PATCH", `/${id}`, { status: "SKIPPED" });
  assert.equal(result.status, 200); assert.equal(f.taskClockCalls() - clock, 1);
  assert.equal(f.state().actions.filter((action) => action.type === "STATUS_CHANGED").length, 1);
});

test("untrustworthy skipped history yields null skippedAt, summary diagnostics and no successor", async (t) => {
  for (const mode of ["missing", "gap", "tie", "budget", "identity", "future", "initial"] as const) {
    const { f, id, routine } = await setup(t);
    await f.request("PATCH", `/${id}`, { status: "SKIPPED" });
    if (mode === "missing") f.state().actions.splice(0, 1);
    if (mode === "gap") (f.state().actions[1].metadata as { before: { status: string } }).before.status = "IN_PROGRESS";
    if (mode === "tie") {
      await f.request("PATCH", `/${id}`, { status: "TODO" }); await f.request("PATCH", `/${id}`, { status: "SKIPPED" });
    }
    if (mode === "budget") f.state().actions.push(...Array.from({ length: 10000 }, (_, index) => ({ ...f.state().actions[1], id: `budget-${index}` })));
    if (mode === "identity") (f.state().actions[0].metadata as { after: { id: string } }).after.id = "wrong";
    if (mode === "future") f.state().actions[1].timestamp = new Date("2027-01-01");
    if (mode === "initial") {
      f.state().actions.splice(1); (f.state().actions[0].metadata as { after: { status: string } }).after.status = "SKIPPED";
    }
    const before = structuredClone(f.state());
    const result = (await f.request("GET", `/${id}`)).body;
    assert.equal(result.skippedAt, null, mode); assert.equal(result.completedAt, null); assert.equal(result.summary.historyIncomplete, true, mode);
    assert.equal(result.summary.ageSeconds, null); assert.equal(result.summary.timeToCompletionSeconds, null);
    assert.equal((await f.routineRequest("POST", `/${routine.id}/generate`, nextRange)).status, 409, mode);
    assert.deepEqual(f.state(), before);
  }
});

test("AFTER_COMPLETION uses verified skippedAt in Routine timezone; preview is additive, read-only and DB-based", async (t) => {
  const { f, routine, id } = await setup(t);
  f.setTime(new Date("2026-10-25T23:30:00Z")); // Kyiv Oct 26, +2 days = Oct 28
  const skipped = (await f.request("PATCH", `/${id}`, { status: "SKIPPED", skipNote: "Reason" })).body;
  f.setTime(new Date("2026-10-27T12:00:00Z"));
  await f.request("PATCH", `/${id}`, { skipNote: "Edited later", archived: true });
  const before = structuredClone(f.state());
  const path = `/${routine.id}/generation-preview?from=2026-10-28&to=2026-10-28`;
  const preview = await f.routineRequest("GET", path);
  assert.equal(preview.status, 200); assert.equal(preview.body.occurrences[0].startDate, "2026-10-28");
  assert.equal(preview.body.occurrences[0].basisType, "SKIPPED");
  assert.equal(preview.body.occurrences[0].basisAt, skipped.skippedAt); assert.equal(preview.body.occurrences[0].basisCompletedAt, null);
  assert.equal(preview.body.occurrences[0].existing, false);
  const simulation = await f.routineRequest("GET", `/${routine.id}/preview?from=2026-10-28&to=2026-10-28&skippedAt=2026-10-25T23:30:00Z&skippedOccurrenceNumber=1`);
  assert.equal(simulation.status, 200); assert.equal(simulation.body.occurrences[0].startDate, "2026-10-28");
  assert.deepEqual(f.state(), before);
  assert.equal((await f.routineRequest("GET", `${path}&skippedAt=2026-10-25T23:30:00Z&skippedOccurrenceNumber=1`)).status, 400);
  const generated = await f.routineRequest("POST", `/${routine.id}/generate`, nextRange);
  assert.equal(generated.status, 200); assert.equal(generated.body.createdCount, 1);
  const next = (await f.request("GET", `/${generated.body.created[0].taskId}`)).body;
  assert.equal(next.routineOccurrence.startDate, "2026-10-28");
  assert.equal(next.routineOccurrence.basisType, "SKIPPED"); assert.equal(next.routineOccurrence.basisAt, skipped.skippedAt);
  assert.equal(next.routineOccurrence.basisCompletedAt, null); assert.equal(next.status, "TODO");
  assert.equal(next.routineOccurrence.instant, "2026-10-28T07:00:00.000Z");
  assert.equal((await f.routineRequest("GET", path)).body.occurrences[0].basisAt, skipped.skippedAt);
});

test("DONE <-> SKIPPED result changes never move or duplicate an already saved successor", async (t) => {
  for (const initial of ["DONE", "SKIPPED"] as const) {
    const { f, routine, id } = await setup(t);
    await f.request("PATCH", `/${id}`, { status: initial });
    const next = await f.routineRequest("POST", `/${routine.id}/generate`, nextRange);
    assert.equal(next.status, 200); assert.equal(next.body.createdCount, 1);
    const saved = structuredClone(f.state().occurrences);
    assert.equal(saved[1].basisType, initial === "DONE" ? "COMPLETED" : "SKIPPED");
    assert.equal(saved[1].basisCompletedAt?.toISOString() ?? null, initial === "DONE" ? saved[1].basisAt!.toISOString() : null);
    for (const status of ["TODO", initial === "DONE" ? "SKIPPED" : "DONE", initial] as const) {
      f.setTime(new Date(f.state().tasks[0].updatedAt.getTime() + 60000));
      assert.equal((await f.request("PATCH", `/${id}`, { status })).status, 200);
      const repeat = await f.routineRequest("POST", `/${routine.id}/generate`, nextRange);
      assert.equal(repeat.status, 200); assert.equal(repeat.body.createdCount, 0); assert.deepEqual(repeat.body.existing, next.body.created);
      assert.deepEqual(f.state().occurrences, saved);
    }
  }
});

test("calendar SKIPPED is never replaced and COUNT/pause/canceled/deleted rules remain", async (t) => {
  const { f, routine, id } = await setup(t, { schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 2 } } });
  await f.request("PATCH", `/${id}`, { status: "SKIPPED" });
  const before = structuredClone(f.state());
  const repeat = await f.routineRequest("POST", `/${routine.id}/generate`, firstRange);
  assert.equal(repeat.body.createdCount, 0); assert.equal(repeat.body.existing[0].taskId, id); assert.deepEqual(f.state(), before);
  for (const count of [1, 2]) {
    const { f, routine, id } = await setup(t, { endCondition: { type: "COUNT", count } });
    await f.request("PATCH", `/${id}`, { status: "SKIPPED" });
    const next = await f.routineRequest("POST", `/${routine.id}/generate`, nextRange);
    assert.equal(next.status, 200); assert.equal(next.body.createdCount, count - 1);
    if (count === 2) {
      f.setTime(new Date("2026-10-28T12:00:00Z"));
      await f.request("PATCH", `/${next.body.created[0].taskId}`, { status: "SKIPPED" });
      assert.equal((await f.routineRequest("POST", `/${routine.id}/generate`, nextRange)).body.createdCount, 0);
    }
  }
  for (const mode of ["pause", "CANCELED", "deleted"] as const) {
    const { f, routine, id } = await setup(t);
    await f.request("PATCH", `/${id}`, { status: "SKIPPED" });
    f.setTime(new Date("2026-10-25T12:01:00Z"));
    if (mode === "pause") await f.routineRequest("PATCH", `/${routine.id}`, { paused: true });
    if (mode === "CANCELED") await f.request("PATCH", `/${id}`, { status: mode, cancellationNote: "Stop" });
    if (mode === "deleted") await f.request("DELETE", `/${id}`);
    const before = structuredClone(f.state());
    assert.equal((await f.routineRequest("POST", `/${routine.id}/generate`, nextRange)).status, 409, mode);
    assert.deepEqual(f.state(), before);
  }
});

test("skip simulation keeps old completion context and rejects incomplete or mixed bases", async (t) => {
  const { f, routine } = await setup(t);
  const path = `/${routine.id}/preview?from=2026-10-27&to=2026-10-27`;
  const old = await f.routineRequest("GET", `${path}&completedAt=2026-10-25T12:00:00Z&completedOccurrenceNumber=1`);
  const skipped = await f.routineRequest("GET", `${path}&skippedAt=2026-10-25T12:00:00Z&skippedOccurrenceNumber=1`);
  assert.equal(old.status, 200); assert.deepEqual(skipped.body, old.body);
  for (const query of ["skippedAt=2026-10-25T12:00:00Z", "skippedOccurrenceNumber=1", "skippedAt=bad&skippedOccurrenceNumber=1",
    "skippedAt=2026-10-25T12:00:00Z&skippedOccurrenceNumber=0",
    "completedAt=2026-10-25T12:00:00Z&completedOccurrenceNumber=1&skippedAt=2026-10-25T12:00:00Z&skippedOccurrenceNumber=1"]) {
    assert.equal((await f.routineRequest("GET", `${path}&${query}`)).status, 400, query);
  }
});

test("concurrent skip/reopen/generate is serializable and repeated generation creates at most one successor", async (t) => {
  const { f, routine, id } = await setup(t);
  f.commitConflicts(1);
  const [skip, generation] = await Promise.all([
    f.request("PATCH", `/${id}`, { status: "SKIPPED" }), f.routineRequest("POST", `/${routine.id}/generate`, nextRange),
  ]);
  assert.equal(skip.status, 200); assert.ok([200, 409].includes(generation.status));
  const repeats = await Promise.all([1, 2].map(() => f.routineRequest("POST", `/${routine.id}/generate`, nextRange)));
  assert.ok(repeats.every((result) => result.status === 200));
  assert.equal(f.state().occurrences.length, 2);
  const successor = f.state().occurrences[1];
  const saved = structuredClone(successor);
  f.setTime(new Date("2026-10-26T12:00:00Z"));
  const [reopen, repeat] = await Promise.all([
    f.request("PATCH", `/${id}`, { status: "TODO" }), f.routineRequest("POST", `/${routine.id}/generate`, nextRange),
  ]);
  assert.equal(reopen.status, 200); assert.equal(repeat.status, 200); assert.equal(repeat.body.createdCount, 0);
  assert.deepEqual(f.state().occurrences[1], saved);
  const task = f.state().tasks.find((entry) => entry.id === id)!;
  assert.equal(verifiedTaskCompletion(task, f.state().actions.filter((entry) => entry.taskId === id), new Date("2026-10-26T12:00:00Z")).skippedAt, null);
});

test("skippedAt calendar arithmetic crosses spring/fall DST and keeps DST conflict checks", async (t) => {
  for (const [startDate, skippedAt, nextDate, expectedInstant] of [
    ["2026-03-27", "2026-03-28T23:30:00Z", "2026-03-31", "2026-03-31T06:00:00.000Z"],
    ["2026-10-23", "2026-10-24T00:30:00Z", "2026-10-26", "2026-10-26T07:00:00.000Z"],
  ]) {
    const f = await fixture(t); f.setTime(new Date("2026-01-01T12:00:00Z"));
    const routine = (await f.routineRequest("POST", "", { ...input, startDate })).body;
    const id = (await f.routineRequest("POST", `/${routine.id}/generate`, { from: startDate, to: startDate })).body.created[0].taskId;
    f.setTime(new Date(skippedAt)); await f.request("PATCH", `/${id}`, { status: "SKIPPED" });
    const result = await f.routineRequest("POST", `/${routine.id}/generate`, { from: nextDate, to: nextDate });
    assert.equal(result.status, 200); assert.equal(result.body.createdCount, 1);
    const next = f.state().occurrences[1];
    assert.equal(next.startDate, nextDate); assert.equal(next.instant!.toISOString(), expectedInstant);
    assert.equal(next.basisType, "SKIPPED"); assert.equal(next.basisAt!.toISOString(), new Date(skippedAt).toISOString());
  }
  const f = await fixture(t); f.setTime(new Date("2026-03-20T12:00:00Z"));
  const routine = (await f.routineRequest("POST", "", { ...input, startDate: "2026-03-25", schedule: { ...input.schedule, localTime: "03:30" } })).body;
  const id = (await f.routineRequest("POST", `/${routine.id}/generate`, { from: "2026-03-25", to: "2026-03-25" })).body.created[0].taskId;
  f.setTime(new Date("2026-03-27T10:00:00Z")); await f.request("PATCH", `/${id}`, { status: "SKIPPED" });
  const before = structuredClone(f.state());
  assert.equal((await f.routineRequest("POST", `/${routine.id}/generate`, { from: "2026-03-29", to: "2026-03-29" })).status, 409);
  assert.deepEqual(f.state(), before);
});
