import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers/api-fixture";
import { createRoutinesRepository } from "../src/modules/tasks/routines/routines.repository";
import { createRoutinesService } from "../src/modules/tasks/routines/routines.service";
import { automaticRange, currentAutomaticRange } from "../src/modules/tasks/routines/domain/routines.auto-range";
import { parseScheduleVersions } from "../src/modules/tasks/routines/routines.versions";

const input = { title: "Automatic test", estimatedDurationMinutes: 10, timezone: "Europe/Kyiv", startDate: "2026-10-01",
  schedule: { version: 1, recurrence: { type: "DAILY", intervalDays: 1 } } };
const service = (f: Awaited<ReturnType<typeof fixture>>) => createRoutinesService(createRoutinesRepository(() => f.client), f.now);

test("automation defaults, POST/PATCH validation, audited settings outside schedule versions", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00Z"));
  const r = (await f.routineRequest("POST", "", input)).body;
  assert.equal(r.autoGenerate, false); assert.equal(r.generationHorizonDays, 7);
  assert.equal(await service(f).generateAutomatically(r.id), null);
  for (const value of [0, 31, -1, 1.5, "7", null]) {
    assert.equal((await f.routineRequest("POST", "", { ...input, generationHorizonDays: value })).status, 400);
    assert.equal((await f.routineRequest("PATCH", `/${r.id}`, { generationHorizonDays: value })).status, 400);
  }
  assert.equal((await f.routineRequest("PATCH", `/${r.id}`, { autoGenerate: "true" })).status, 400);
  for (const days of [1, 30]) assert.equal((await f.routineRequest("PATCH", `/${r.id}`, { autoGenerate: true, generationHorizonDays: days })).status, 200);
  assert.equal(f.state().scheduleVersions.length, 1);
  assert.equal(f.state().routineActions.at(-1)!.type, "UPDATED");
  const after = (f.state().routineActions.at(-1)!.metadata as { after: { generationHorizonDays: number } }).after;
  assert.equal(after.generationHorizonDays, 30);
  f.failEvents(); const before = structuredClone(f.state());
  assert.equal((await f.routineRequest("PATCH", `/${r.id}`, { autoGenerate: false })).status, 500);
  assert.deepEqual(f.state(), before);
});

for (const days of [1, 7, 30]) test(`calendar horizon ${days}, local midnight/DST, no catch-up, immutable Tasks`, async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-24T21:30Z")); // Kyiv Oct 25 before fall-back
  const r = (await f.routineRequest("POST", "", { ...input, autoGenerate: true, generationHorizonDays: days })).body;
  const s = service(f); const result = await s.generateAutomatically(r.id);
  assert.equal(result!.createdCount, days);
  assert.equal(f.state().occurrences[0].startDate, "2026-10-25");
  assert.equal(f.state().occurrences.at(-1)!.startDate, automaticRange(input.timezone, { asOf: f.now(), horizonDays: days }).to);
  const taskId = result!.created[0].taskId;
  await f.request("PATCH", `/${taskId}`, { plannedAt: "2026-12-01T12:00Z" });
  const before = structuredClone(f.state());
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0);
  assert.deepEqual(f.state(), before);
  await f.routineRequest("PATCH", `/${r.id}`, { generationHorizonDays: 1, autoGenerate: false });
  assert.equal(await s.generateAutomatically(r.id), null);
  assert.deepEqual(f.state().tasks, before.tasks);
  assert.deepEqual(f.state().occurrences, before.occurrences);
});

test("pause/deletion, existing DONE/SKIPPED/deleted executions are never replaced; GET is read-only", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, autoGenerate: true })).body;
  const s = service(f);
  await f.routineRequest("PATCH", `/${r.id}`, { paused: true });
  assert.equal(await s.generateAutomatically(r.id), null);
  f.setTime(new Date("2026-10-21T12:00Z"));
  await f.routineRequest("PATCH", `/${r.id}`, { paused: false });
  const beforeGet = structuredClone(f.state()); await f.routineRequest("GET"); await f.request("GET");
  assert.deepEqual(f.state(), beforeGet);
  const generated = await s.generateAutomatically(r.id);
  for (const [index, status] of ["DONE", "SKIPPED", "CANCELED"].entries()) {
    await f.request("PATCH", `/${generated!.created[index].taskId}`, { status });
  }
  await f.request("DELETE", `/${generated!.created[3].taskId}`);
  const before = structuredClone(f.state());
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0);
  assert.deepEqual(f.state(), before);
  await f.routineRequest("DELETE", `/${r.id}`);
  assert.equal(await s.generateAutomatically(r.id), null);
});

test("active monthly window is materialized whole after downtime; COUNT and UNTIL preserved", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00Z"));
  const window = { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1,
    selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } } };
  const r = (await f.routineRequest("POST", "", { ...input, schedule: window, autoGenerate: true, generationHorizonDays: 1 })).body;
  await service(f).generateAutomatically(r.id);
  assert.deepEqual(f.state().occurrences.map((o) => [o.startDate, o.endDate]), [["2026-10-15", "2026-10-23"]]);
  for (const endCondition of [{ type: "COUNT", count: 2 }, { type: "UNTIL_DATE", date: "2026-10-19" }]) {
    const r = (await f.routineRequest("POST", "", { ...input, endCondition, autoGenerate: true })).body;
    assert.equal((await service(f).generateAutomatically(r.id))!.createdCount, 0);
  }
});

for (const outcome of ["DONE", "SKIPPED"]) test(`completion ${outcome}: old first date, one real successor, downtime and reopen`, async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, autoGenerate: true, generationHorizonDays: 30,
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } } })).body;
  const s = service(f); const first = (await s.generateAutomatically(r.id))!;
  assert.equal(first.createdCount, 1); assert.equal(f.state().occurrences[0].startDate, "2026-10-01");
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0);
  const taskId = first.created[0].taskId;
  f.setTime(new Date("2026-10-21T12:00Z"));
  assert.equal((await f.request("PATCH", `/${taskId}`, { status: outcome })).status, 200);
  f.setTime(new Date("2026-10-21T12:01Z"));
  await f.request("PATCH", `/${taskId}`, { status: "TODO" });
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0);
  f.setTime(new Date("2026-10-22T12:00Z"));
  await f.request("PATCH", `/${taskId}`, { status: outcome });
  f.setTime(new Date("2026-11-20T12:00Z"));
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 1);
  const next = f.state().occurrences[1];
  assert.equal(next.startDate, "2026-10-24"); assert.equal(next.basisAt!.toISOString(), "2026-10-22T12:00:00.000Z");
  assert.equal(next.basisType, outcome === "DONE" ? "COMPLETED" : "SKIPPED");
  await f.request("PATCH", `/${taskId}`, { status: "TODO" });
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0);
  assert.deepEqual(f.state().occurrences[1], next);
});

for (const mode of ["CANCELED", "deleted"]) test(`completion chain stops on ${mode}`, async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, autoGenerate: true,
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } } })).body;
  const s = service(f); const id = (await s.generateAutomatically(r.id))!.created[0].taskId;
  if (mode === "deleted") { await f.request("PATCH", `/${id}`, { status: "DONE" }); await f.request("DELETE", `/${id}`); }
  else await f.request("PATCH", `/${id}`, { status: mode });
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0); assert.equal(f.state().occurrences.length, 1);
});

test("automatic and manual generation race atomically; audit failure rolls back all writes", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, autoGenerate: true })).body;
  const s = service(f);
  const results = await Promise.all([s.generateAutomatically(r.id), s.generateAutomatically(r.id),
    s.generate(r.id, { from: "2026-10-20", to: "2026-10-26" })]);
  assert.equal(results.reduce((n, r) => n + r!.createdCount, 0), 7);
  assert.equal(f.state().occurrences.length, 7);
  f.setTime(new Date("2026-11-20T12:00Z")); f.failEvents(1);
  const before = structuredClone(f.state()); await assert.rejects(s.generateAutomatically(r.id));
  assert.deepEqual(f.state(), before);
});

test("version timezone transition uses effectiveAt and each version's local horizon", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, timezone: "Pacific/Honolulu", autoGenerate: true, generationHorizonDays: 1 })).body;
  assert.equal((await f.routineRequest("POST", `/${r.id}/schedule-versions`, {
    timezone: "Pacific/Kiritimati", startDate: "2026-10-01", effectiveDate: "2026-10-22",
    schedule: input.schedule, endCondition: { type: "NEVER" },
  })).status, 201);
  const versions = parseScheduleVersions(f.state().scheduleVersions);
  f.setTime(new Date("2026-10-22T09:59:59Z"));
  assert.equal(currentAutomaticRange(versions, { asOf: f.now(), horizonDays: 1 }).from, "2026-10-21");
  await service(f).generateAutomatically(r.id);
  assert.deepEqual(f.state().occurrences.map((o) => [o.startDate, o.timezone]), [["2026-10-21", "Pacific/Honolulu"]]);
  f.setTime(new Date("2026-10-22T10:00Z"));
  assert.equal(currentAutomaticRange(versions, { asOf: f.now(), horizonDays: 1 }).from, "2026-10-23");
  await service(f).generateAutomatically(r.id);
  assert.ok(f.state().occurrences.some((o) => o.startDate === "2026-10-23" && o.timezone === "Pacific/Kiritimati"));
  assert.ok(!f.state().occurrences.some((o) => o.startDate === "2026-10-22" && o.timezone === "Pacific/Kiritimati"));
});

test("unresolved DST diagnostics block generation without shifting time", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-24T12:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, autoGenerate: true,
    schedule: { ...input.schedule, localTime: "03:30" } })).body;
  await assert.rejects(service(f).generateAutomatically(r.id), /DST/);
  assert.equal(f.state().tasks.length, 0);
});

test("spring DST and local midnight use calendar days, not elapsed 24-hour periods", () => {
  assert.deepEqual(automaticRange("Europe/Kyiv", { asOf: new Date("2026-03-28T22:30Z"), horizonDays: 7 }),
    { from: "2026-03-29", to: "2026-04-04" });
  assert.deepEqual(automaticRange("Europe/Kyiv", { asOf: new Date("2026-03-29T20:59:59Z"), horizonDays: 1 }),
    { from: "2026-03-29", to: "2026-03-29" });
  assert.deepEqual(automaticRange("Europe/Kyiv", { asOf: new Date("2026-03-29T21:00Z"), horizonDays: 1 }),
    { from: "2026-03-30", to: "2026-03-30" });
});

test("completion horizon does not cap the single successor; COUNT includes skipped executions", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-20T12:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, autoGenerate: true, generationHorizonDays: 1,
    schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 90 } }, endCondition: { type: "COUNT", count: 2 } })).body;
  const s = service(f); const first = (await s.generateAutomatically(r.id))!.created[0];
  f.setTime(new Date("2026-10-21T12:00Z")); await f.request("PATCH", `/${first.taskId}`, { status: "SKIPPED" });
  const second = (await s.generateAutomatically(r.id))!;
  assert.equal(second.createdCount, 1); assert.equal(f.state().occurrences[1].startDate, "2027-01-19");
  f.setTime(new Date("2027-01-20T12:00Z")); await f.request("PATCH", `/${second.created[0].taskId}`, { status: "DONE" });
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0);
});

test("version boundary conflict retains stored windows and calendar COUNT is lifetime across versions", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-10T12:00Z"));
  const r = (await f.routineRequest("POST", "", { ...input, startDate: "2026-10-15", autoGenerate: true,
    schedule: { version: 1, recurrence: { type: "MONTHLY", intervalMonths: 1,
      selection: { type: "WINDOW", startDay: 15, endDay: 23, shortMonthPolicy: "SKIP" } } } })).body;
  const s = service(f);
  await s.generate(r.id, { from: "2026-10-15", to: "2026-10-23" });
  const frozen = structuredClone(f.state().occurrences);
  const append = await f.routineRequest("POST", `/${r.id}/schedule-versions`, { effectiveDate: "2026-10-20",
    timezone: "Europe/Kyiv", startDate: "2026-10-20", schedule: input.schedule, endCondition: { type: "COUNT", count: 3 } });
  assert.equal(append.status, 201);
  f.setTime(new Date("2026-10-20T12:00Z"));
  const result = (await s.generateAutomatically(r.id))!;
  assert.equal(result.createdCount, 2); assert.equal(result.conflicts!.length, 4);
  assert.deepEqual(f.state().occurrences[0], frozen[0]);
  assert.deepEqual(f.state().occurrences.slice(1).map((o) => o.startDate), ["2026-10-24", "2026-10-25"]);
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0);
});

test("completion selects matching schedule version and UNTIL blocks successors", async (t) => {
  const f = await fixture(t); f.setTime(new Date("2026-10-10T12:00Z"));
  const schedule = { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 2 } };
  const r = (await f.routineRequest("POST", "", { ...input, schedule, autoGenerate: true })).body;
  const s = service(f); const first = (await s.generateAutomatically(r.id))!.created[0];
  const appended = await f.routineRequest("POST", `/${r.id}/schedule-versions`, { effectiveDate: "2026-10-20",
    timezone: "UTC", startDate: input.startDate, schedule: { version: 1, recurrence: { type: "AFTER_COMPLETION", intervalDays: 4 } },
    endCondition: { type: "UNTIL_DATE", date: "2026-10-30" } });
  assert.equal(appended.status, 201);
  f.setTime(new Date("2026-10-21T23:30Z")); await f.request("PATCH", `/${first.taskId}`, { status: "SKIPPED" });
  const second = (await s.generateAutomatically(r.id))!.created[0];
  assert.equal(f.state().occurrences[1].scheduleVersionId, appended.body.id);
  assert.equal(f.state().occurrences[1].startDate, "2026-10-25");
  f.setTime(new Date("2026-10-29T12:00Z")); await f.request("PATCH", `/${second.taskId}`, { status: "DONE" });
  assert.equal((await s.generateAutomatically(r.id))!.createdCount, 0);
});
