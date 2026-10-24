import type { TaskWithSubtasks } from "./tasks.repository";
import type { TaskSummary } from "./tasks.summary";

export const toTaskResponse = (task: TaskWithSubtasks & { summary: TaskSummary }) => ({
  ...task,
  priority: task.priority,
  isCompleted: task.status === "DONE",
});
