import type { Task, TaskAction, TaskStatus } from "../../generated/prisma/client";

const workingStatuses = ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED"] as const;
const statuses: readonly string[] = [...workingStatuses, "DONE", "CANCELED"];
type WorkingStatus = typeof workingStatuses[number];
export type SummaryAction = Pick<TaskAction, "id" | "type" | "timestamp" | "metadata">;
export type TaskSummary = {
  asOf: string;
  ageSeconds: number | null;
  inProgressSeconds: number | null;
  timeToCompletionSeconds: number | null;
  statusDurationsSeconds: Record<WorkingStatus, number | null>;
  historyIncomplete: boolean;
  historyIssues: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function status(value: unknown): TaskStatus | undefined {
  return typeof value === "string" && statuses.includes(value) ? value as TaskStatus : undefined;
}

/** Pure reconstruction. UUID ordering is deterministic, but cannot prove write order. */
export function calculateTaskSummary(
  task: Pick<Task, "createdAt" | "status">, history: readonly SummaryAction[], asOf: Date,
): TaskSummary {
  const start = task.createdAt.getTime();
  const end = asOf.getTime();
  const issues = new Set<string>();
  const validLifetime = Number.isFinite(start) && Number.isFinite(end) && start <= end;
  if (!validLifetime) issues.add("INVALID_LIFETIME");
  const actions = history.filter((action) => action.type === "CREATED" || action.type === "STATUS_CHANGED")
    .slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const creations = actions.filter((action) => action.type === "CREATED");
  if (creations.length !== 1) issues.add("MISSING_OR_DUPLICATE_CREATION");
  const initial = creations.length === 1 ? status(record(record(creations[0].metadata).after).status) : undefined;
  if (!initial) issues.add("INVALID_INITIAL_STATUS");
  let current = initial;
  let cursor = start;
  const creationTime = creations.length === 1 ? creations[0].timestamp.getTime() : undefined;
  let terminalEntry = initial === "DONE" || initial === "CANCELED" ? start : undefined;
  const milliseconds: Record<WorkingStatus, number> = { TODO: 0, IN_PROGRESS: 0, PAUSED: 0, POSTPONED: 0 };
  const addInterval = (until: number) => {
    if (current && workingStatuses.includes(current as WorkingStatus)) {
      milliseconds[current as WorkingStatus] += Math.max(0, until - cursor);
    }
  };
  for (const action of actions) {
    const time = action.timestamp.getTime();
    if (!Number.isFinite(time) || time < start || time > end) issues.add("EVENT_OUTSIDE_LIFETIME");
    if (action.type === "CREATED") {
      // Creation may be logged after createdAt; its status starts at createdAt.
      continue;
    }
    const metadata = record(action.metadata);
    if (creationTime !== undefined && time < creationTime) issues.add("CREATION_AFTER_TRANSITION");
    const before = status(record(metadata.before).status);
    const after = status(record(metadata.after).status);
    if (!before || !after) {
      issues.add("INVALID_STATUS_EVENT");
      continue;
    }
    if (before !== current) issues.add("STATUS_CHAIN_MISMATCH");
    if (before === after) continue;
    addInterval(time);
    current = after;
    cursor = time;
    terminalEntry = after === "DONE" || after === "CANCELED" ? time : undefined;
  }
  if (current !== task.status) issues.add("SNAPSHOT_STATUS_MISMATCH");
  addInterval(end);
  const complete = issues.size === 0;
  const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000));
  const terminal = task.status === "DONE" || task.status === "CANCELED";
  const age = validLifetime && (!terminal || (complete && terminalEntry !== undefined))
    ? seconds((terminal ? terminalEntry! : end) - start) : null;
  const durations = Object.fromEntries(
    workingStatuses.map((key) => [key, complete ? seconds(milliseconds[key]) : null]),
  ) as Record<WorkingStatus, number | null>;
  return {
    asOf: asOf.toISOString(), ageSeconds: age,
    inProgressSeconds: durations.IN_PROGRESS,
    timeToCompletionSeconds: task.status === "DONE" && complete ? age : null,
    statusDurationsSeconds: durations,
    historyIncomplete: !complete, historyIssues: [...issues],
  };
}
