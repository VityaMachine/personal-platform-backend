import { z } from "zod";
import { ApiError } from "../../http/api-error";

export const taskFields = {
  title: z.string().trim().min(1).max(160),
  duration: z.number().int().positive().max(2_147_483_647),
  note: z.string().trim().min(1),
};

export function sumSubtaskDurations(subtasks: readonly { estimatedDurationMinutes: number }[]) {
  let total = 0;
  for (const subtask of subtasks) {
    total += subtask.estimatedDurationMinutes;
    if (total > 2_147_483_647) throw new ApiError(400, "Total subtask duration exceeds the supported limit.");
  }
  return total;
}
