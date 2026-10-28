import type { Area } from "../../../generated/prisma/client";

export const toAreaResponse = (area: Area) => ({
  id: area.id, name: area.name, createdAt: area.createdAt, updatedAt: area.updatedAt,
});
export const toAreaSnapshot = (area: Pick<Area, "id" | "name"> | null) =>
  area ? { id: area.id, name: area.name } : null;
