import type { Task, TaskAction, TaskStatus } from "../../generated/prisma/client";

export const COMPLETION_HISTORY_BUDGET = 10_000;
const statuses: readonly string[] = ["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const status = (value: unknown): TaskStatus | null => typeof value === "string" && statuses.includes(value) ? value as TaskStatus : null;

/** Verify saved status transitions. Edits/archive timestamps never become completion timestamps.
 * An explicit asOf bounds the journal; there is no hidden clock.
 */
export function verifiedTaskCompletion(task: Pick<Task, "id" | "createdAt" | "status">, actions: readonly TaskAction[], asOf: Date) {
  const issues = new Set<string>();
  let completedAt: Date | null = null;
  if (actions.length > COMPLETION_HISTORY_BUDGET) return { completedAt: null, issues: ["COMPLETION_HISTORY_BUDGET_EXCEEDED"] };
  const history = actions.filter((action) => action.type === "CREATED" || action.type === "STATUS_CHANGED")
    .slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id));
  const creations = history.filter((action) => action.type === "CREATED");
  if (creations.length !== 1) issues.add("MISSING_OR_DUPLICATE_CREATION");
  let current = creations.length === 1 ? status(record(record(creations[0].metadata).after).status) : null;
  if (!current) issues.add("INVALID_INITIAL_STATUS");
  if (creations.length === 1) {
    const metadata = record(creations[0].metadata), snapshot = record(metadata.after);
    if (metadata.before !== null || snapshot.id !== task.id || typeof snapshot.createdAt !== "string"
      || Date.parse(snapshot.createdAt) !== task.createdAt.getTime()) issues.add("INVALID_CREATION_SNAPSHOT");
  }
  if (!Number.isFinite(task.createdAt.getTime()) || !Number.isFinite(asOf.getTime()) || task.createdAt > asOf) issues.add("INVALID_LIFETIME");
  let transitionTime: number | null = null;
  const ids = new Set<string>();
  for (const action of history) {
    const time = action.timestamp.getTime();
    if (ids.has(action.id)) issues.add("DUPLICATE_EVENT");
    ids.add(action.id);
    if (action.taskId !== task.id || !Number.isFinite(time) || action.timestamp < task.createdAt || action.timestamp > asOf) issues.add("EVENT_OUTSIDE_LIFETIME");
    if (action.type === "CREATED") continue;
    if (creations.length === 1 && action.timestamp < creations[0].timestamp) issues.add("TRANSITION_BEFORE_CREATION");
    const metadata = record(action.metadata);
    const before = status(record(metadata.before).status), after = status(record(metadata.after).status);
    if (!before || !after) { issues.add("INVALID_STATUS_EVENT"); continue; }
    if (before !== current) issues.add("STATUS_CHAIN_MISMATCH");
    if (before !== after) {
      if (transitionTime === time) issues.add("AMBIGUOUS_TRANSITION_ORDER");
      transitionTime = time;
      completedAt = after === "DONE" ? new Date(time) : null;
    }
    current = after;
  }
  if (current !== task.status) issues.add("SNAPSHOT_STATUS_MISMATCH");
  if (task.status !== "DONE" || completedAt === null) issues.add("NO_REAL_DONE_TRANSITION");
  return { completedAt: issues.size ? null : completedAt, issues: [...issues] };
}
