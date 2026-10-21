import type { Task } from "../../generated/prisma/client";

export const toTaskResponse = (task: Task) => ({
  ...task,
  isCompleted: task.status === "DONE",
});
