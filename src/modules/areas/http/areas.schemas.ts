import { z } from "zod";
import { ApiError } from "../../../http/api-error";

const name = z.string().trim().min(1).max(80);
export const createAreaSchema = z.strictObject({ name });
export const updateAreaSchema = z.strictObject({ name });
export const listAreasSchema = z.strictObject({});
export const deleteAreaSchema = z.strictObject({}).optional();
export const areaIdSchema = z.unknown().transform((id) => {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new ApiError(400, "Invalid area id.");
  return parsed.data.toLowerCase();
});

export type CreateAreaInput = z.output<typeof createAreaSchema>;
export type UpdateAreaInput = z.output<typeof updateAreaSchema>;
