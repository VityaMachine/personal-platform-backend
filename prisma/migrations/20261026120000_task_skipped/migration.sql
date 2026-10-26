ALTER TYPE "TaskStatus" ADD VALUE 'SKIPPED';

BEGIN;
CREATE TYPE "RoutineBasisType" AS ENUM ('COMPLETED', 'SKIPPED');
ALTER TABLE "Task" ADD COLUMN "skipNote" VARCHAR(2000);
ALTER TABLE "Task" ADD CONSTRAINT "Task_skipped_requires_occurrence"
  CHECK ("status"::text <> 'SKIPPED' OR "routineOccurrenceId" IS NOT NULL);
ALTER TABLE "Task" ADD CONSTRAINT "Task_skip_note_status"
  CHECK ("skipNote" IS NULL OR ("status"::text = 'SKIPPED' AND char_length(btrim("skipNote")) > 0));
ALTER TABLE "Subtask" ADD CONSTRAINT "Subtask_no_skipped"
  CHECK ("status"::text <> 'SKIPPED');

ALTER TABLE "RoutineOccurrence"
  ADD COLUMN "basisType" "RoutineBasisType",
  ADD COLUMN "basisAt" TIMESTAMPTZ(3);
-- Existing completion successors keep the original instant and compatibility field.
UPDATE "RoutineOccurrence" SET "basisType" = 'COMPLETED', "basisAt" = "basisCompletedAt"
  WHERE "previousOccurrenceId" IS NOT NULL AND "basisCompletedAt" IS NOT NULL;
ALTER TABLE "RoutineOccurrence" DROP CONSTRAINT "RoutineOccurrence_completion_chain_fields";
ALTER TABLE "RoutineOccurrence" ADD CONSTRAINT "RoutineOccurrence_completion_chain_fields" CHECK ((
  (("occurrenceNumber" IS NULL OR "occurrenceNumber" = 1)
    AND "previousOccurrenceId" IS NULL AND "basisType" IS NULL AND "basisAt" IS NULL AND "basisCompletedAt" IS NULL)
  OR ("occurrenceNumber" > 1 AND "previousOccurrenceId" IS NOT NULL AND "previousOccurrenceId" <> "id"
    AND "basisAt" IS NOT NULL AND (
      ("basisType" = 'COMPLETED' AND "basisCompletedAt" = "basisAt")
      OR ("basisType" = 'SKIPPED' AND "basisCompletedAt" IS NULL)
    ))
) IS TRUE);
COMMIT;
