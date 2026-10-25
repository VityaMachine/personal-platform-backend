import type { TaskWithSubtasks } from "./tasks.repository";
import type { TaskSummary } from "./tasks.summary";

export const toTaskResponse = ({ routineOccurrenceId: _link, ...task }: TaskWithSubtasks & { summary: TaskSummary; isToday: boolean; completedAt: string | null }) => ({
  ...task,
  priority: task.priority,
  isCompleted: task.status === "DONE",
});
