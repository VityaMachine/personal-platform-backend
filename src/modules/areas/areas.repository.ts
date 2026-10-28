import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { getPrisma } from "../../infrastructure/database/prisma";
import { lockArea } from "./area-lock";

function createAreaQueries(db: Prisma.TransactionClient) {
  return {
    findForUpdate(id: string) { return lockArea(db, id); },
    create(data: Prisma.AreaCreateInput) { return db.area.create({ data }); },
    update(id: string, data: Prisma.AreaUpdateInput) { return db.area.update({ where: { id }, data }); },
    remove(id: string) { return db.area.delete({ where: { id } }); },
  };
}
export type AreasTransactionRepository = ReturnType<typeof createAreaQueries>;
export class AreasTransactionConflictError extends Error {}

export function createAreasRepository(client: () => PrismaClient = getPrisma) {
  return {
    findMany() {
      return client().area.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] });
    },
    async transaction<T>(work: (tx: AreasTransactionRepository, client: Prisma.TransactionClient) => Promise<T>): Promise<T> {
      const db = client();
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction((tx) => work(createAreaQueries(tx), tx), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          });
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") throw error;
          if (attempt >= 2) throw new AreasTransactionConflictError();
        }
      }
    },
  };
}
export type AreasRepository = ReturnType<typeof createAreasRepository>;
