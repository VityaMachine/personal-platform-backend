import { z } from "zod";

import { TaskPriority, TaskStatus } from "../../generated/prisma/client";
import { ApiError } from "../../lib/api-error";

const title = z.string().trim().min(1).max(160);
const dateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const duration = z.number().int().positive().max(2_147_483_647);
const note = z.string().trim().min(1);

export const createTaskSchema = z.strictObject({
  title,
  description: z.string().nullable().optional(),
  plannedAt: dateTime.optional(),
  priority: z.enum(TaskPriority).default("MEDIUM"),
  dueAt: dateTime,
  estimatedDurationMinutes: duration,
});

export const updateTaskSchema = z.strictObject({
  title: title.optional(),
  description: z.string().nullable().optional(),
  status: z.enum(TaskStatus).optional(),
  priority: z.enum(TaskPriority).optional(),
  isCompleted: z.boolean().optional(),
  plannedAt: dateTime.nullable().optional(),
  dueAt: dateTime.nullable().optional(),
  estimatedDurationMinutes: duration.optional(),
  cancellationNote: note.optional(),
  archived: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, "At least one field is required.")
  .refine((data) => data.status === undefined || data.isCompleted === undefined,
    "Send either status or isCompleted.")
  .refine((data) => data.status !== "CANCELED" || data.cancellationNote !== undefined,
    { message: "CANCELED requires a nonempty cancellationNote.", path: ["cancellationNote"] });

export const listTasksSchema = z.strictObject({
  archived: z.enum(["true", "false"]).optional(),
});

// Keep the existing id error message instead of the generic Zod error response.
export const taskIdSchema = z.unknown().transform((id) => {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new ApiError(400, "Invalid task id.");
  return parsed.data;
});

export type CreateTaskInput = z.output<typeof createTaskSchema>;
export type UpdateTaskInput = z.output<typeof updateTaskSchema>;
export type ListTasksInput = z.output<typeof listTasksSchema>;
