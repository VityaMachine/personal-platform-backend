import { Prisma, type Area } from "../../generated/prisma/client";

// Assignment, deletion and rename lock the same row before any Task writes.
// Under Serializable, a stale snapshot raises P2034 and the entire transaction
// must retry before assigning or detaching tasks.
export async function lockArea(db: Prisma.TransactionClient, id: string) {
  try {
    const rows = await db.$queryRaw<Area[]>`
      SELECT "id", "name", "createdAt", "updatedAt"
      FROM "Area" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    return rows[0] ?? null;
  } catch (error) {
    // Prisma's raw-query path can wrap adapter conflicts in P2010 instead of
    // P2034. Normalize only PostgreSQL serialization/deadlock errors so both
    // callers retain their existing whole-transaction retry policy.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010") {
      const adapter = error.meta?.driverAdapterError as { cause?: { kind?: string; originalCode?: string } } | undefined;
      const sqlState = adapter?.cause?.originalCode ?? error.meta?.code;
      if (adapter?.cause?.kind === "TransactionWriteConflict" || sqlState === "40001" || sqlState === "40P01") {
        throw new Prisma.PrismaClientKnownRequestError("Area changed concurrently.", {
          code: "P2034", clientVersion: error.clientVersion,
        });
      }
    }
    throw error;
  }
}

