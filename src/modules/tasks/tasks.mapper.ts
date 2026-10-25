import type { TaskWithSubtasks } from "./tasks.repository";
import type { TaskSummary } from "./tasks.summary";

export const toTaskResponse = ({ routineOccurrenceId: _link, ...task }: TaskWithSubtasks & { summary: TaskSummary }) => ({
  ...task,
  priority: task.priority,
  isCompleted: task.status === "DONE",
});
