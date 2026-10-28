import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { localDateSchema } from "./routines.schedule";

export const completionPreviewContextSchema = z.strictObject({
  completedAt: z.iso.datetime({ offset: true }).refine((value) => {
    try { Temporal.Instant.from(value); return true; } catch { return false; }
  }, "Expected an instant."),
  completedOccurrenceNumber: z.number().int().min(1).max(2_147_483_647),
});
const integerQuery = z.string().regex(/^[1-9]\d*$/).transform(Number);
export const routinePreviewQuerySchema = z.strictObject({
  from: localDateSchema,
  to: localDateSchema,
  limit: integerQuery.pipe(z.number().int().min(1).max(500)).default(100),
  completedAt: completionPreviewContextSchema.shape.completedAt.optional(),
  completedOccurrenceNumber: integerQuery.pipe(completionPreviewContextSchema.shape.completedOccurrenceNumber).optional(),
  skippedAt: completionPreviewContextSchema.shape.completedAt.optional(),
  skippedOccurrenceNumber: integerQuery.pipe(completionPreviewContextSchema.shape.completedOccurrenceNumber).optional(),
}).superRefine((value, ctx) => {
  if (value.from > value.to) ctx.addIssue({ code: "custom", message: "from must not exceed to." });
  else if (localDateSchema.safeParse(value.from).success && localDateSchema.safeParse(value.to).success
    && Temporal.PlainDate.from(value.from).until(Temporal.PlainDate.from(value.to)).days >= 366) {
    ctx.addIssue({ code: "custom", message: "Requested range must not exceed 366 inclusive calendar days." });
  }
  if ((value.completedAt === undefined) !== (value.completedOccurrenceNumber === undefined)) {
    ctx.addIssue({ code: "custom", message: "completedAt and completedOccurrenceNumber must be supplied together." });
  }
  if ((value.skippedAt === undefined) !== (value.skippedOccurrenceNumber === undefined)) {
    ctx.addIssue({ code: "custom", message: "skippedAt and skippedOccurrenceNumber must be supplied together." });
  }
  if ((value.completedAt !== undefined || value.completedOccurrenceNumber !== undefined)
    && (value.skippedAt !== undefined || value.skippedOccurrenceNumber !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Send either completion or skip context, never both." });
  }
});
export type RoutinePreviewQuery = z.output<typeof routinePreviewQuerySchema>;
export type CompletionPreviewContext = z.output<typeof completionPreviewContextSchema>;
