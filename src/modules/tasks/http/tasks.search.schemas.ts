import { z } from "zod";
import { TaskPriority, TaskStatus } from "../../../generated/prisma/client";
import { localDateSchema, timezoneSchema } from "../routines/domain/routines.schedule";

export const searchTasksSchema = z.strictObject({
  q: z.string().default(""),
  status: z.enum(TaskStatus).optional(),
  priority: z.enum(TaskPriority).optional(),
  area: z.union([z.literal("none"), z.uuid().transform((id) => id.toLowerCase())]).optional(),
  sort: z.enum(["newest", "oldest", "deadline", "priority", "planning", "completed"]).default("newest"),
  dateField: z.enum(["planning", "due", "created", "completed"]).default("planning"),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  timezone: timezoneSchema.default("UTC"),
  page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).default(1),
  pageSize: z.enum(["20", "50", "100"]).transform(Number).default(20),
}).refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not exceed to.", path: ["from"] });

export type SearchTasksInput = z.output<typeof searchTasksSchema>;
