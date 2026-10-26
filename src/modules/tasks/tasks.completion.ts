import type { Task } from "../../generated/prisma/client";
import { analyzeTaskHistory, type SummaryAction } from "./tasks.history";
export { COMPLETION_HISTORY_BUDGET } from "./tasks.history";

/** Verified current DONE/SKIPPED transition; edits and updatedAt never supply an outcome. */
export function verifiedTaskCompletion(
  task: Pick<Task, "id" | "createdAt" | "status">, actions: readonly SummaryAction[], asOf: Date,
) {
  const history = analyzeTaskHistory(task, actions, asOf);
  return { completedAt: history.completedAt, skippedAt: history.skippedAt, issues: history.outcomeIssues };
}
