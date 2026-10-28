import { Prisma } from "../../../generated/prisma/client";

// When an Area is needed, lock it BEFORE this row (also the Area deletion order).
export async function lockRoutine(db: Prisma.TransactionClient, id: string) {
  try {
    await db.$queryRaw`SELECT "id" FROM "Routine" WHERE "id" = ${id}::uuid FOR UPDATE`;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010") {
      const adapter = error.meta?.driverAdapterError as { cause?: { kind?: string; originalCode?: string } } | undefined;
      const state = adapter?.cause?.originalCode ?? error.meta?.code;
      if (adapter?.cause?.kind === "TransactionWriteConflict" || state === "40001" || state === "40P01") {
        throw new Prisma.PrismaClientKnownRequestError("Routine changed concurrently.", { code: "P2034", clientVersion: error.clientVersion });
      }
    }
    throw error;
  }
}
