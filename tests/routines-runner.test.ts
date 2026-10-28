import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoutineRunner } from "../src/modules/routines/routines.runner";
import type { RoutinesService } from "../src/modules/routines/routines.service";
import { readRunnerConfig } from "../src/config/config";
import { ApiError } from "../src/http/api-error";

type Result = Awaited<ReturnType<RoutinesService["generateAutomatically"]>>;
const empty = (id: string): Result => ({ routineId: id, from: "2026-10-20", to: "2026-10-26",
  createdCount: 0, existingCount: 0, created: [], existing: [] });
function setup(generate: (id: string) => Promise<Result>, ids = ["a", "b", "c", "d"]) {
  const warnings: unknown[] = [], summaries: unknown[] = [], scans: unknown[] = [];
  const repository = { async findAutomaticCandidates(after: string | undefined, take: number) {
    scans.push({ after, take }); return ids.filter((id) => !after || id > after).slice(0, take).map((id) => ({ id }));
  } };
  const logger = { info(data: unknown) { summaries.push(data); }, warn(data: unknown) { warnings.push(data); } };
  return { repository, service: { generateAutomatically: generate }, logger, warnings, summaries, scans };
}
const limits = { batchSize: 2, concurrency: 2, maxRoutines: 2, maxDurationMs: 100 };

test("validated server defaults and rejection of malformed config", () => {
  assert.deepEqual(readRunnerConfig({}), { enabled: true, intervalMs: 300_000 });
  assert.deepEqual(readRunnerConfig({ ROUTINE_AUTO_GENERATION_ENABLED: "false", ROUTINE_AUTO_GENERATION_INTERVAL_MS: "1000" }),
    { enabled: false, intervalMs: 1000 });
  for (const value of ["0", "-1", "1.5", "NaN", "86400001", ""]) {
    assert.throws(() => readRunnerConfig({ ROUTINE_AUTO_GENERATION_INTERVAL_MS: value }));
  }
  assert.throws(() => readRunnerConfig({ ROUTINE_AUTO_GENERATION_ENABLED: "yes" }));
});

test("bounded batches advance past failing routines and suppress repeated safe diagnostics", async () => {
  const seen: string[] = [];
  const deps = setup(async (id) => { seen.push(id); if (id === "a") throw new ApiError(409, "Unresolved DST."); return empty(id); });
  const runner = createRoutineRunner({ ...deps, limits, clock: () => 0 });
  const first = await runner.runOnce(); assert.equal(first.errors, 1); assert.equal(first.budgetExhausted, true);
  await runner.runOnce(); assert.deepEqual(seen, ["a", "b", "c", "d"]);
  await runner.runOnce(); // EOF resets the cursor, does not repeat the scan in this pass.
  await runner.runOnce(); assert.equal(deps.warnings.length, 1);
  assert.equal(deps.summaries.length, 4);
  assert.ok(deps.scans.every((scan) => (scan as { take: number }).take <= 2));
  await runner.stop();
});

test("overlapping passes share work; shutdown drains admitted work and never admits the next batch", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0, peak = 0;
  const seen: string[] = [];
  const deps = setup(async (id) => { seen.push(id); active++; peak = Math.max(peak, active); await gate; active--; return empty(id); });
  const runner = createRoutineRunner({ ...deps, limits: { ...limits, maxRoutines: 100 }, clock: () => 0 });
  const first = runner.runOnce(); assert.equal(runner.runOnce(), first);
  await Promise.resolve(); await Promise.resolve();
  let stopped = false; const stopping = runner.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); assert.equal(peak, 2);
  release(); await stopping; await first;
  assert.deepEqual(seen, ["a", "b"]); assert.equal(active, 0);
});

test("time budget uses injected clock, retains fair cursor, counts normal zero/existing/conflicts", async () => {
  let now = 0;
  const seen: string[] = [];
  const deps = setup(async (id) => { seen.push(id); now += 101; return { ...empty(id)!, existingCount: 3,
    conflicts: [{ code: "STORED_WINDOW_CONFLICT", occurrenceKey: "key", retainedOccurrenceKey: "old", retainedTaskId: "id" }] }; });
  const runner = createRoutineRunner({ ...deps, clock: () => now, limits: { ...limits, concurrency: 1, maxRoutines: 100 } });
  const first = await runner.runOnce(); assert.equal(first.processed, 1); assert.equal(first.budgetExhausted, true);
  assert.equal(first.existing, 3); assert.equal(first.conflicts, 1);
  await runner.runOnce(); assert.deepEqual(seen, ["a", "b"]);
  await runner.stop();
});

test("startup pass, injected timer, cancellation, sanitized scan failure", async () => {
  let callback: (() => void) | undefined, delay = 0, clears = 0;
  const deps = setup(async (id) => empty(id), []);
  const runner = createRoutineRunner({ ...deps, timers: {
    set(fn, ms) { callback = fn; delay = ms; return 123; }, clear(timer) { assert.equal(timer, 123); clears++; },
  } });
  assert.equal(deps.scans.length, 0);
  runner.start(300_000); await runner.runOnce(); await Promise.resolve();
  assert.equal(deps.summaries.length, 1); assert.equal(delay, 300_000); assert.ok(callback);
  callback!(); await runner.runOnce(); await Promise.resolve(); assert.equal(deps.summaries.length, 2);
  await runner.stop(); assert.equal(clears, 1);
  const broken = createRoutineRunner({ ...deps, repository: { async findAutomaticCandidates() { throw new Error("SECRET PERSON"); } } });
  assert.equal((await broken.runOnce()).errors, 1);
  assert.ok(!JSON.stringify(deps.warnings).includes("SECRET PERSON"));
});

test("importing app does not start runner or connect to database", async () => {
  const { app } = await import("../src/app");
  assert.equal(typeof app.listen, "function");
});
