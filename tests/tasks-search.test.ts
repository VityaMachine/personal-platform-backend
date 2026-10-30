import assert from "node:assert/strict";
import { test } from "node:test";
import { searchTasksSchema } from "../src/modules/tasks/http/tasks.search.schemas";
import { searchDateBounds, searchWindowBounds } from "../src/modules/tasks/tasks.search";
import { fixture } from "./helpers/api-fixture";

test("search defaults and calendar boundaries include DST, leap days and the final supported year", () => {
  assert.deepEqual(searchTasksSchema.parse({}), { q: "", sort: "newest", dateField: "planning", timezone: "UTC", page: 1, pageSize: 20 });
  for (const [date, hours] of [["2026-03-29", 23], ["2026-10-25", 25]] as const) {
    const bounds = searchDateBounds({ from: date, to: date, timezone: "Europe/Kyiv" });
    assert.equal(bounds.until!.getTime() - bounds.from!.getTime(), hours * 3600000);
  }
  assert.equal(searchDateBounds({ to: "9999-12-31", timezone: "UTC" }).until!.toISOString(), "+010000-01-01T00:00:00.000Z");
  assert.equal(searchDateBounds({ from: "2024-02-29", timezone: "UTC" }).until, null);
  assert.equal(searchDateBounds({ to: "2024-02-29", timezone: "UTC" }).from, null);
  assert.deepEqual(searchDateBounds({ timezone: "UTC" }), { from: null, until: null });
  const midnightFold = searchWindowBounds({ startDate: "2026-11-01", endDate: "2026-11-01", timezone: "America/Havana" });
  assert.equal(new Date(midnightFold.start).toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(midnightFold.end - midnightFold.start, 25 * 3600000);
  const skipped = searchWindowBounds({ startDate: "2011-12-30", endDate: "2011-12-30", timezone: "Pacific/Apia" });
  assert.equal(skipped.start, skipped.end);
});

test("search HTTP rejects invalid/unknown/duplicate queries before database access and registers before :id", async (t) => {
  const f = await fixture(t);
  for (const query of ["page=0", "page=-1", "page=1.2", "page=1e2", "page=9007199254740992", "pageSize=21", "pageSize=0",
    "status=BAD", "priority=bad", "area=null", "area=bad", "sort=bad", "dateField=bad", "timezone=invalid",
    "timezone=%2B03:00", "from=2026-02-29", "to=2026-13-01", "from=0000-01-01", "from=2026-1-1",
    "from=2026-02-02&to=2026-02-01", "from=2026-01-01T00:00:00Z", "q=a&q=b", "page=1&page=2", "archived=true", "view=today"]) {
    const response = await f.request("GET", `/search?${query}`);
    assert.equal(response.status, 400, query);
    assert.notEqual(response.body.message, "Invalid task id.", query);
  }
  assert.equal(f.attempts(), 0);
  assert.equal(f.taskClockCalls(), 0);
  for (const pageSize of ["20", "50", "100"]) assert.equal(searchTasksSchema.parse({ pageSize }).pageSize, Number(pageSize));
});
