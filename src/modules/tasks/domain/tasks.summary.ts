import type { Task } from "../../../generated/prisma/client";
import { analyzeTaskHistory, isTerminalStatus, workingStatuses, type SummaryAction, type WorkingStatus } from "./tasks.history";
export type { SummaryAction } from "./tasks.history";

export type TaskSummary = {
  asOf: string;
  ageSeconds: number | null;
  inProgressSeconds: number | null;
  timeToCompletionSeconds: number | null;
  statusDurationsSeconds: Record<WorkingStatus, number | null>;
  historyIncomplete: boolean;
  historyIssues: string[];
};

export function calculateTaskSummary(
  task: Pick<Task, "createdAt" | "status">, history: readonly SummaryAction[], asOf: Date,
): TaskSummary {
  const replay = analyzeTaskHistory(task, history, asOf);
  const { start, end, validLifetime, terminalEntry, milliseconds } = replay;
  // Keep existing summary diagnostics; SKIPPED requires a real, verified outcome.
  const issues = task.status === "SKIPPED" ? replay.outcomeIssues : replay.issues;
  const complete = issues.length === 0;
  const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000));
  const terminal = isTerminalStatus(task.status);
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
    historyIncomplete: !complete, historyIssues: issues,
  };
}
