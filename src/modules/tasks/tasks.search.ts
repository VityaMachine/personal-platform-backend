import { Temporal } from "@js-temporal/polyfill";
import { Prisma, TaskStatus } from "../../generated/prisma/client";
import type { SearchTasksInput } from "./http/tasks.search.schemas";
import { COMPLETION_HISTORY_BUDGET } from "./domain/tasks.history";

export function searchDateBounds(query: Pick<SearchTasksInput, "from" | "to" | "timezone">) {
  const start = (day: Temporal.PlainDate) => new Date(day.toZonedDateTime(query.timezone).epochMilliseconds);
  return {
    from: query.from ? start(Temporal.PlainDate.from(query.from)) : null,
    until: query.to ? start(Temporal.PlainDate.from(query.to).add({ days: 1 })) : null,
  };
}

/** SQL counterpart of analyzeTaskHistory's completion evidence. Keep differential tests
 * against verifiedTaskCompletion when changing either implementation. No writes/functions
 * are installed in the database. Only DONE candidates need a journal replay. */
function completionProjection(asOf: Date) {
  const statuses = Prisma.join(Object.values(TaskStatus));
  return Prisma.sql`LEFT JOIN LATERAL (
    WITH history AS MATERIALIZED (
      SELECT a.*, a.metadata->'before'->>'status' AS before_status,
        a.metadata->'after'->>'status' AS after_status
      FROM "TaskAction" a WHERE t.status = 'DONE' AND a."taskId" = t.id AND a.type IN ('CREATED', 'STATUS_CHANGED')
      ORDER BY a.timestamp, a.id LIMIT ${COMPLETION_HISTORY_BUDGET + 1}
    ), creation AS (
      SELECT count(*) AS n, min(timestamp) AS at,
        min(after_status) AS initial,
        bool_and(metadata->'before' = 'null'::jsonb
          AND metadata->'after'->>'id' = t.id::text
          AND jsonb_typeof(metadata->'after'->'createdAt') = 'string'
          AND (input.creation_times ->> (metadata->'after'->>'createdAt'))::numeric
            = extract(epoch FROM t."createdAt") * 1000) AS valid
      FROM history WHERE type = 'CREATED'
    ), changes AS (
      SELECT *, lag(after_status) OVER (ORDER BY timestamp, id) AS previous,
        row_number() OVER (ORDER BY timestamp, id) AS number
      FROM history WHERE type = 'STATUS_CHANGED'
    ), real_changes AS (
      SELECT *, lag(timestamp) OVER (ORDER BY timestamp, id) AS previous_at
      FROM changes WHERE before_status <> after_status
    )
    SELECT CASE WHEN t.status = 'DONE' AND t."createdAt" <= ${asOf}
      AND c.n = 1 AND c.initial IN (${statuses}) AND c.valid IS TRUE
      AND (SELECT count(*) FROM history) <= ${COMPLETION_HISTORY_BUDGET}
      AND NOT EXISTS (SELECT 1 FROM history WHERE timestamp < t."createdAt" OR timestamp > ${asOf})
      AND NOT EXISTS (SELECT 1 FROM changes WHERE
        timestamp < c.at OR before_status NOT IN (${statuses}) OR after_status NOT IN (${statuses})
        OR before_status IS NULL OR after_status IS NULL
        OR before_status IS DISTINCT FROM CASE WHEN number = 1 THEN c.initial ELSE previous END)
      AND NOT EXISTS (SELECT 1 FROM real_changes WHERE timestamp = previous_at)
      AND coalesce((SELECT after_status FROM changes ORDER BY timestamp DESC, id DESC LIMIT 1), c.initial) = t.status::text
      AND (SELECT after_status FROM real_changes ORDER BY timestamp DESC, id DESC LIMIT 1) = 'DONE'
      THEN (SELECT timestamp FROM real_changes ORDER BY timestamp DESC, id DESC LIMIT 1)
      ELSE NULL END AS completed
    FROM creation c
  ) completion ON t.status = 'DONE'`;
}

export const searchNeedsCompletion = (query: SearchTasksInput) => query.sort === "completed"
  || (query.dateField === "completed" && Boolean(query.from || query.to));
export const searchNeedsPlanning = (query: SearchTasksInput) => query.sort === "planning"
  || (query.dateField === "planning" && Boolean(query.from || query.to));

export type SearchWindow = { startDate: string; endDate: string; timezone: string };
export const searchWindowKey = (window: SearchWindow) => `${window.timezone}|${window.startDate}|${window.endDate}`;
export function searchWindowBounds(window: SearchWindow) {
  const { from, until } = searchDateBounds({ from: window.startDate, to: window.endDate, timezone: window.timezone });
  return { start: from!.getTime(), end: until!.getTime() };
}
export const taskSearchWindowsSql = Prisma.sql`
  SELECT DISTINCT o."startDate", o."endDate", o.timezone
  FROM "Task" t JOIN "RoutineOccurrence" o ON o.id = t."routineOccurrenceId"
  WHERE t."archivedAt" IS NULL AND t."deletedAt" IS NULL AND t."plannedAt" IS NULL`;

// Only distinct creation timestamp strings cross the boundary, never whole journals.
// Parsing them through the shared JS helper preserves Date.parse semantics exactly;
// PostgreSQL accepts different date syntax, precision and relative dates.
export const taskSearchCreationDatesSql = Prisma.sql`
  SELECT DISTINCT a.metadata->'after'->>'createdAt' AS value
  FROM "TaskAction" a JOIN "Task" t ON t.id = a."taskId"
  WHERE t.status = 'DONE' AND t."archivedAt" IS NULL AND t."deletedAt" IS NULL
    AND a.type = 'CREATED' AND jsonb_typeof(a.metadata->'after'->'createdAt') = 'string'`;

export function taskSearchSql(query: SearchTasksInput, asOf: Date, creationTimes: string, windows: string) {
  const { from, until } = searchDateBounds(query);
  const needsCompletion = searchNeedsCompletion(query);
  const conditions: Prisma.Sql[] = [];
  const normalized = query.q.trim().toLocaleLowerCase("uk-UA");
  // Literal substring, not LIKE wildcards. Explicit ICU locale matches frontend casing.
  if (normalized) conditions.push(Prisma.sql`strpos(lower(t.title COLLATE "uk-x-icu"), ${normalized}) > 0`);
  if (query.status) conditions.push(Prisma.sql`t.status::text = ${query.status}`);
  if (query.priority) conditions.push(Prisma.sql`t.priority::text = ${query.priority}`);
  if (query.area) conditions.push(query.area === "none" ? Prisma.sql`t."areaId" IS NULL` : Prisma.sql`t."areaId" = ${query.area}::uuid`);
  // Temporal start-of-day also handles midnight folds and wholly skipped local days.
  // PostgreSQL's default AT TIME ZONE disambiguation chooses a different midnight
  // during folds, so convert distinct calendar windows with the same calendar helper.
  const window = Prisma.sql`(input.windows -> (o.timezone || '|' || o."startDate" || '|' || o."endDate"))`;
  const planning = Prisma.sql`coalesce(t."plannedAt", to_timestamp((${window}->>'start')::numeric / 1000))`;
  const planningEnd = Prisma.sql`to_timestamp((${window}->>'end')::numeric / 1000)`;
  const date = query.dateField === "planning" ? planning : query.dateField === "due" ? Prisma.sql`t."dueAt"`
    : query.dateField === "created" ? Prisma.sql`t."createdAt"` : Prisma.sql`completion.completed`;
  if (from || until) {
    if (from && until && from >= until) conditions.push(Prisma.sql`false`);
    conditions.push(Prisma.sql`${date} IS NOT NULL`);
    if (query.dateField === "planning") conditions.push(Prisma.sql`(t."plannedAt" IS NOT NULL OR ${planningEnd} > ${planning})`);
    if (from) conditions.push(query.dateField === "planning"
      ? Prisma.sql`(CASE WHEN t."plannedAt" IS NOT NULL THEN t."plannedAt" >= ${from} ELSE ${planningEnd} > ${from} END)`
      : Prisma.sql`${date} >= ${from}`);
    if (until) conditions.push(Prisma.sql`${date} < ${until}`);
  }
  const sort = query.sort === "oldest" ? Prisma.sql`t."createdAt" ASC, t.id ASC`
    : query.sort === "newest" ? Prisma.sql`t."createdAt" DESC, t.id ASC`
    : query.sort === "priority" ? Prisma.sql`t.priority DESC, t."createdAt" DESC, t.id ASC`
    : Prisma.sql`${query.sort === "deadline" ? Prisma.sql`t."dueAt"` : query.sort === "planning" ? planning : Prisma.sql`completion.completed`} ASC NULLS LAST, t."createdAt" DESC, t.id ASC`;
  return Prisma.sql`WITH base AS MATERIALIZED (
      SELECT id, status FROM "Task" WHERE "archivedAt" IS NULL AND "deletedAt" IS NULL
    ), input AS MATERIALIZED (
      SELECT ${windows}::jsonb AS windows, ${creationTimes}::jsonb AS creation_times
    ), filtered AS MATERIALIZED (
      SELECT t.id, row_number() OVER (ORDER BY ${sort}) AS position
      FROM base b JOIN "Task" t ON t.id = b.id
      CROSS JOIN input
      LEFT JOIN "RoutineOccurrence" o ON o.id = t."routineOccurrenceId"
      ${needsCompletion ? completionProjection(asOf) : Prisma.empty}
      ${conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty}
    )
    SELECT (SELECT count(*)::int FROM filtered) AS total,
      (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM
        (SELECT status, count(*)::int AS n FROM base GROUP BY status) counts) AS counts,
      ARRAY(SELECT id::text FROM filtered ORDER BY position LIMIT ${query.pageSize} OFFSET ${(BigInt(query.page) - 1n) * BigInt(query.pageSize)}) AS ids`;
}

export type TaskSearchSelection = { total: number; counts: Partial<Record<TaskStatus, number>>; ids: string[] };
