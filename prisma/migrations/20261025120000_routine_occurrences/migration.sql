BEGIN;

CREATE TABLE "RoutineOccurrence" (
    "id" UUID NOT NULL,
    "routineId" UUID NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "startDate" VARCHAR(10) NOT NULL,
    "endDate" VARCHAR(10) NOT NULL,
    "timezone" VARCHAR(100) NOT NULL,
    "localTime" VARCHAR(5),
    "instant" TIMESTAMPTZ(3),
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoutineOccurrence_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Task" ADD COLUMN "routineOccurrenceId" UUID;
CREATE UNIQUE INDEX "RoutineOccurrence_routineId_occurrenceKey_key" ON "RoutineOccurrence"("routineId", "occurrenceKey");
CREATE UNIQUE INDEX "Task_routineOccurrenceId_key" ON "Task"("routineOccurrenceId");
ALTER TABLE "RoutineOccurrence" ADD CONSTRAINT "RoutineOccurrence_routineId_fkey"
    FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_routineOccurrenceId_fkey"
    FOREIGN KEY ("routineOccurrenceId") REFERENCES "RoutineOccurrence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
