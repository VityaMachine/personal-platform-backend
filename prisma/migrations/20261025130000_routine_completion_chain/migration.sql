BEGIN;

-- Existing calendar occurrences deliberately retain NULL chain fields.
ALTER TABLE "RoutineOccurrence"
    ADD COLUMN "occurrenceNumber" INTEGER,
    ADD COLUMN "previousOccurrenceId" UUID,
    ADD COLUMN "basisCompletedAt" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "RoutineOccurrence_routineId_occurrenceNumber_key"
    ON "RoutineOccurrence"("routineId", "occurrenceNumber");
CREATE UNIQUE INDEX "RoutineOccurrence_previousOccurrenceId_key"
    ON "RoutineOccurrence"("previousOccurrenceId");
ALTER TABLE "RoutineOccurrence" ADD CONSTRAINT "RoutineOccurrence_previousOccurrenceId_fkey"
    FOREIGN KEY ("previousOccurrenceId") REFERENCES "RoutineOccurrence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoutineOccurrence" ADD CONSTRAINT "RoutineOccurrence_completion_chain_fields"
    CHECK ((
      ("occurrenceNumber" IS NULL AND "previousOccurrenceId" IS NULL AND "basisCompletedAt" IS NULL)
      OR ("occurrenceNumber" = 1 AND "previousOccurrenceId" IS NULL AND "basisCompletedAt" IS NULL)
      OR ("occurrenceNumber" > 1 AND "previousOccurrenceId" IS NOT NULL AND "basisCompletedAt" IS NOT NULL AND "previousOccurrenceId" <> "id")
    ) IS TRUE);

COMMIT;
