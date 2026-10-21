import type { Task } from "../../generated/prisma/client";

export const toTaskResponse = (task: Task) => ({
  ...task,
  priority: task.priority,
  isCompleted: task.status === "DONE",
});
