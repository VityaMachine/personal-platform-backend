import type { TaskWithSubtasks } from "./tasks.repository";

export const toTaskResponse = (task: TaskWithSubtasks) => ({
  ...task,
  priority: task.priority,
  isCompleted: task.status === "DONE",
});
