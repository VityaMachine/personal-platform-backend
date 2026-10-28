import type { TaskWithSubtasks } from "../tasks.repository";
import type { TaskSummary } from "../domain/tasks.summary";

export const toTaskResponse = ({ routineOccurrenceId: _link, ...task }: TaskWithSubtasks & { summary: TaskSummary; isToday: boolean; isBacklog: boolean; completedAt: string | null; skippedAt: string | null }) => ({
  ...task,
  priority: task.priority,
  isCompleted: task.status === "DONE",
});
