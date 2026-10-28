import { z } from "zod";
import { ApiError } from "../../../http/api-error";
import { taskFields } from "../tasks.fields";

const fields = {
  title: taskFields.title,
  status: z.enum(["TODO", "IN_PROGRESS", "PAUSED", "POSTPONED", "DONE", "CANCELED"]),
  estimatedDurationMinutes: taskFields.duration,
  cancellationNote: taskFields.note,
};

export const initialSubtaskSchema = z.strictObject({
  title: fields.title,
  estimatedDurationMinutes: fields.estimatedDurationMinutes,
});
const canceledRequiresNote = (data: { status?: string; cancellationNote?: string }) =>
  data.status !== "CANCELED" || data.cancellationNote !== undefined;
const cancellationError = {
  message: "CANCELED requires a nonempty cancellationNote.", path: ["cancellationNote"],
};

export const createSubtaskSchema = z.strictObject({
  ...fields,
  status: fields.status.default("TODO"),
  cancellationNote: fields.cancellationNote.optional(),
}).refine(canceledRequiresNote, cancellationError);

export const updateSubtaskSchema = z.strictObject({
  title: fields.title.optional(),
  status: fields.status.optional(),
  estimatedDurationMinutes: fields.estimatedDurationMinutes.optional(),
  cancellationNote: fields.cancellationNote.optional(),
}).refine((data) => Object.keys(data).length > 0, "At least one field is required.")
  .refine(canceledRequiresNote, cancellationError);

export const subtaskIdSchema = z.unknown().transform((id) => {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new ApiError(400, "Invalid subtask id.");
  return parsed.data;
});

export type CreateSubtaskInput = z.output<typeof createSubtaskSchema>;
export type UpdateSubtaskInput = z.output<typeof updateSubtaskSchema>;
