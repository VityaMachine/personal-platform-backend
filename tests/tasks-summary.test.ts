import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskStatus } from "../src/generated/prisma/client";
import { calculateTaskSummary, type SummaryAction } from "../src/modules/tasks/tasks.summary";

const at = (seconds: number) => new Date(Date.parse("2026-10-22T00:00:00Z") + seconds * 1000);
const created = (initial: TaskStatus = "TODO"): SummaryAction => ({
  id: "00", type: "CREATED", timestamp: at(0), metadata: { before: null, after: { status: initial } },
});
const transition = (time: number, before: TaskStatus, after: TaskStatus, id = String(time).padStart(4, "0")): SummaryAction => ({
  id, type: "STATUS_CHANGED", timestamp: at(time), metadata: { before: { status: before }, after: { status: after } },
});
const summary = (status: TaskStatus, actions: SummaryAction[], end = 100) =>
  calculateTaskSummary({ status, createdAt: at(0) }, actions, at(end));

test("initial status starts at createdAt, including a delayed creation event", () => {
  for (const initial of ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED"] as const) {
    const action = { ...created(initial), timestamp: at(2) };
    const result = summary(initial, [action]);
    assert.equal(result.asOf, at(100).toISOString());
    assert.equal(result.ageSeconds, 100);
    assert.equal(result.statusDurationsSeconds[initial], 100);
    assert.equal(result.inProgressSeconds, initial === "IN_PROGRESS" ? 100 : 0);
    assert.equal(result.timeToCompletionSeconds, null);
    assert.equal(result.historyIncomplete, false);
  }
});

test("repeated IN_PROGRESS entries, PAUSED and POSTPONED accumulate milliseconds before flooring", () => {
  const actions = [created(), transition(10.2, "TODO", "IN_PROGRESS"), transition(20.8, "IN_PROGRESS", "PAUSED"),
    transition(30, "PAUSED", "IN_PROGRESS"), transition(40.6, "IN_PROGRESS", "POSTPONED"),
    transition(60, "POSTPONED", "IN_PROGRESS")];
  const result = summary("IN_PROGRESS", actions);
  assert.deepEqual(result.statusDurationsSeconds, { TODO: 10, IN_PROGRESS: 61, PAUSED: 9, POSTPONED: 19 });
  assert.equal(result.inProgressSeconds, 61);
  assert.equal(result.historyIncomplete, false);
});

test("DONE and CANCELED stop age and exclude terminal intervals from working durations", () => {
  for (const terminal of ["DONE", "CANCELED"] as const) {
    const result = summary(terminal, [created(), transition(10, "TODO", "IN_PROGRESS"), transition(40, "IN_PROGRESS", terminal)]);
    assert.equal(result.ageSeconds, 40);
    assert.equal(result.timeToCompletionSeconds, terminal === "DONE" ? 40 : null);
    assert.deepEqual(result.statusDurationsSeconds, { TODO: 10, IN_PROGRESS: 30, PAUSED: 0, POSTPONED: 0 });
  }
});

test("reopening resumes work and calendar age, recompletion uses the last entry", () => {
  const actions = [created(), transition(10, "TODO", "IN_PROGRESS"), transition(20, "IN_PROGRESS", "DONE"),
    transition(50, "DONE", "IN_PROGRESS")];
  const open = summary("IN_PROGRESS", actions);
  assert.equal(open.ageSeconds, 100);
  assert.equal(open.inProgressSeconds, 60);
  assert.equal(open.timeToCompletionSeconds, null);
  const done = summary("DONE", [...actions, transition(80, "IN_PROGRESS", "DONE")]);
  assert.equal(done.ageSeconds, 80);
  assert.equal(done.timeToCompletionSeconds, 80);
  assert.equal(done.inProgressSeconds, 40);
  const canceled = summary("TODO", [created(), transition(20, "TODO", "CANCELED"), transition(60, "CANCELED", "TODO")]);
  assert.equal(canceled.ageSeconds, 100);
  assert.equal(canceled.statusDurationsSeconds.TODO, 60);
});

test("edits, archive, subtask events and same-status records do not create transitions", () => {
  const ignored = ["AREA_CHANGED", "EDITED", "ARCHIVED", "UNARCHIVED", "SUBTASK_STATUS_CHANGED", "SUBTASK_CREATED", "SUBTASK_DELETED", "SUBTASK_EDITED", "DELETED"] as const;
  const actions: SummaryAction[] = [created(), ...ignored.map((type, index) => ({
    id: `event-${index}`, type, timestamp: at(index + 1), metadata: { before: { status: "TODO" }, after: { status: "DONE" } },
  })), transition(20, "TODO", "TODO")];
  const result = summary("TODO", actions);
  assert.equal(result.statusDurationsSeconds.TODO, 100);
  assert.equal(result.historyIncomplete, false);
  const terminal = summary("DONE", [created(), transition(20, "TODO", "DONE"), transition(80, "DONE", "DONE")]);
  assert.equal(terminal.ageSeconds, 20);
});

test("automatic parent STATUS_CHANGED uses the same timeline without adding child time", () => {
  const automatic = transition(20, "TODO", "IN_PROGRESS");
  automatic.metadata = { ...automatic.metadata as object, subtaskId: "child" };
  const result = summary("IN_PROGRESS", [created(), automatic]);
  assert.equal(result.inProgressSeconds, 80);
  assert.equal(result.historyIncomplete, false);
});

test("timestamp ties use ascending IDs independent of input order; broken tied chains are exposed", () => {
  const actions = [created(), transition(20, "TODO", "IN_PROGRESS", "a"), transition(20, "IN_PROGRESS", "PAUSED", "b")];
  const result = summary("PAUSED", actions);
  assert.deepEqual(result, summary("PAUSED", [...actions].reverse()));
  assert.equal(result.historyIncomplete, false);
  assert.deepEqual(result.statusDurationsSeconds, { TODO: 20, IN_PROGRESS: 0, PAUSED: 80, POSTPONED: 0 });
  const broken = summary("PAUSED", [actions[0], { ...actions[1], id: "b" }, { ...actions[2], id: "a" }]);
  assert.equal(broken.historyIncomplete, true);
  assert.ok(broken.historyIssues.includes("STATUS_CHAIN_MISMATCH"));
  assert.equal(broken.inProgressSeconds, null);
  const creationTie = summary("IN_PROGRESS", [{ ...created(), id: "z" }, transition(0, "TODO", "IN_PROGRESS", "a")]);
  assert.equal(creationTie.historyIncomplete, false);
  assert.equal(creationTie.inProgressSeconds, 100);
});

test("missing, malformed, contradictory and out-of-range history returns unknown durations", () => {
  const cases: SummaryAction[][] = [[], [created(), created()],
    [{ ...created(), metadata: { after: {} } }],
    [created(), { ...transition(10, "TODO", "DONE"), metadata: {} }],
    [created(), transition(10, "PAUSED", "TODO")],
    [created(), transition(-1, "TODO", "IN_PROGRESS")],
    [created(), transition(101, "TODO", "IN_PROGRESS")],
    [created(), transition(10, "TODO", "DONE")],
  ];
  for (const actions of cases) {
    const result = summary("TODO", actions);
    assert.equal(result.historyIncomplete, true);
    assert.ok(result.historyIssues.length);
    assert.equal(result.ageSeconds, 100);
    assert.equal(result.inProgressSeconds, null);
    assert.deepEqual(result.statusDurationsSeconds, { TODO: null, IN_PROGRESS: null, PAUSED: null, POSTPONED: null });
  }
  const result = summary("DONE", [created()]);
  assert.ok(result.historyIssues.includes("SNAPSHOT_STATUS_MISMATCH"));
  assert.equal(result.ageSeconds, null);
  assert.equal(result.timeToCompletionSeconds, null);
});

test("absolute timestamps, nonnegative integer seconds and immutable inputs", () => {
  const task = { status: "TODO" as const, createdAt: new Date("2026-10-22T03:00:00+03:00") };
  const actions = [created()];
  const before = structuredClone(actions);
  const result = calculateTaskSummary(task, actions, at(1.999));
  assert.equal(result.ageSeconds, 1);
  assert.equal(result.statusDurationsSeconds.TODO, 1);
  assert.deepEqual(actions, before);
  const invalid = calculateTaskSummary(task, actions, at(-1));
  assert.equal(invalid.ageSeconds, null);
  assert.equal(invalid.inProgressSeconds, null);
  assert.equal(invalid.historyIncomplete, true);
});
