import type { Task, TaskAction, TaskStatus } from "../../generated/prisma/client";

export const COMPLETION_HISTORY_BUDGET = 10_000;
export const workingStatuses = ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED"] as const;
export type WorkingStatus = typeof workingStatuses[number];
export type SummaryAction = Pick<TaskAction, "id" | "type" | "timestamp" | "metadata"> & { taskId?: string };
const statuses: readonly string[] = [...workingStatuses, "DONE", "CANCELED", "SKIPPED"];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const status = (value: unknown): TaskStatus | undefined => typeof value === "string" && statuses.includes(value) ? value as TaskStatus : undefined;
export const isTerminalStatus = (value: TaskStatus | undefined) => value === "DONE" || value === "CANCELED" || value === "SKIPPED";

/** One replay for summary intervals and verified outcome instants.
 * Summary retains its historical diagnostics; outcome evidence additionally requires identity,
 * an unambiguous real transition and a complete journal within the generation budget.
 */
export function analyzeTaskHistory(
  task: Pick<Task, "createdAt" | "status"> & { id?: string }, history: readonly SummaryAction[], asOf: Date,
) {
  const start = task.createdAt.getTime(), end = asOf.getTime();
  const issues = new Set<string>(), evidenceIssues = new Set<string>();
  const validLifetime = Number.isFinite(start) && Number.isFinite(end) && start <= end;
  if (!validLifetime) issues.add("INVALID_LIFETIME");
  const actions = history.filter((action) => action.type === "CREATED" || action.type === "STATUS_CHANGED")
    .slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const creations = actions.filter((action) => action.type === "CREATED");
  if (creations.length !== 1) issues.add("MISSING_OR_DUPLICATE_CREATION");
  const initial = creations.length === 1 ? status(record(record(creations[0].metadata).after).status) : undefined;
  if (!initial) issues.add("INVALID_INITIAL_STATUS");
  if (creations.length === 1 && task.id !== undefined) {
    const metadata = record(creations[0].metadata), snapshot = record(metadata.after);
    if (metadata.before !== null || snapshot.id !== task.id || typeof snapshot.createdAt !== "string"
      || Date.parse(snapshot.createdAt) !== start) evidenceIssues.add("INVALID_CREATION_SNAPSHOT");
  }
  let current = initial, cursor = start;
  let terminalEntry = isTerminalStatus(initial) ? start : undefined;
  let outcomeAt: Date | null = null, transitionTime: number | null = null;
  const creationTime = creations.length === 1 ? creations[0].timestamp.getTime() : undefined;
  const ids = new Set<string>();
  const milliseconds: Record<WorkingStatus, number> = { TODO: 0, IN_PROGRESS: 0, PAUSED: 0, POSTPONED: 0 };
  const addInterval = (until: number) => {
    if (current && workingStatuses.includes(current as WorkingStatus)) milliseconds[current as WorkingStatus] += Math.max(0, until - cursor);
  };
  for (const action of actions) {
    const time = action.timestamp.getTime();
    if (!Number.isFinite(time) || time < start || time > end) issues.add("EVENT_OUTSIDE_LIFETIME");
    if (ids.has(action.id)) evidenceIssues.add("DUPLICATE_EVENT");
    ids.add(action.id);
    if (task.id !== undefined && action.taskId !== task.id) evidenceIssues.add("EVENT_OUTSIDE_LIFETIME");
    if (action.type === "CREATED") continue;
    if (creationTime !== undefined && time < creationTime) issues.add("CREATION_AFTER_TRANSITION");
    const metadata = record(action.metadata);
    const before = status(record(metadata.before).status), after = status(record(metadata.after).status);
    if (!before || !after) { issues.add("INVALID_STATUS_EVENT"); continue; }
    if (before !== current) issues.add("STATUS_CHAIN_MISMATCH");
    if (before === after) continue;
    if (transitionTime === time) evidenceIssues.add("AMBIGUOUS_TRANSITION_ORDER");
    transitionTime = time;
    addInterval(time);
    current = after;
    cursor = time;
    terminalEntry = isTerminalStatus(after) ? time : undefined;
    outcomeAt = after === "DONE" || after === "SKIPPED" ? new Date(time) : null;
  }
  if (current !== task.status) issues.add("SNAPSHOT_STATUS_MISMATCH");
  addInterval(end);
  const outcomeIssues = new Set([...issues, ...evidenceIssues]);
  if (history.length > COMPLETION_HISTORY_BUDGET) outcomeIssues.add("COMPLETION_HISTORY_BUDGET_EXCEEDED");
  if ((task.status !== "DONE" && task.status !== "SKIPPED") || outcomeAt === null) {
    outcomeIssues.add(task.status === "SKIPPED" ? "NO_REAL_SKIPPED_TRANSITION" : "NO_REAL_DONE_TRANSITION");
  }
  return { start, end, validLifetime, terminalEntry, milliseconds, issues: [...issues], outcomeIssues: [...outcomeIssues],
    completedAt: outcomeIssues.size === 0 && task.status === "DONE" ? outcomeAt : null,
    skippedAt: outcomeIssues.size === 0 && task.status === "SKIPPED" ? outcomeAt : null };
}
