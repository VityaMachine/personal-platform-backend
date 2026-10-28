import { Prisma } from "../../generated/prisma/client";

// Area assignment locks Area first. Completion generation locks Area -> Routine -> Task.
export async function lockTask(db: Prisma.TransactionClient, id: string) {
  try {
    await db.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${id}::uuid FOR UPDATE`;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010") {
      const adapter = error.meta?.driverAdapterError as { cause?: { kind?: string; originalCode?: string } } | undefined;
      const state = adapter?.cause?.originalCode ?? error.meta?.code;
      if (adapter?.cause?.kind === "TransactionWriteConflict" || state === "40001" || state === "40P01") {
        throw new Prisma.PrismaClientKnownRequestError("Task changed concurrently.", { code: "P2034", clientVersion: error.clientVersion });
      }
    }
    throw error;
  }
}
