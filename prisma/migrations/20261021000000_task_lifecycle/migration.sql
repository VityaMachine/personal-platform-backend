BEGIN;

-- Only test tasks are discarded: their required planning data is unknown.
DELETE FROM "Task";

CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'PAUSED', 'POSTPONED', 'DONE', 'CANCELED');
CREATE TYPE "TaskActionType" AS ENUM ('CREATED', 'EDITED', 'STATUS_CHANGED', 'ARCHIVED', 'UNARCHIVED', 'DELETED');

ALTER TABLE "Task"
    DROP COLUMN "isCompleted",
    ADD COLUMN "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    ADD COLUMN "plannedAt" TIMESTAMPTZ(3),
    ADD COLUMN "dueAt" TIMESTAMPTZ(3),
    ADD COLUMN "estimatedDurationMinutes" INTEGER NOT NULL,
    ADD COLUMN "cancellationNote" TEXT,
    ADD COLUMN "archivedAt" TIMESTAMPTZ(3),
    ADD COLUMN "deletedAt" TIMESTAMPTZ(3),
    ADD CONSTRAINT "Task_estimatedDurationMinutes_positive" CHECK ("estimatedDurationMinutes" > 0),
    ADD CONSTRAINT "Task_cancellationNote_required" CHECK (
        "status" <> 'CANCELED' OR
        ("cancellationNote" IS NOT NULL AND length(btrim("cancellationNote")) > 0)
    );

CREATE TABLE "TaskAction" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "type" "TaskActionType" NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL,
    CONSTRAINT "TaskAction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaskAction_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Task_deletedAt_archivedAt_createdAt_idx" ON "Task"("deletedAt", "archivedAt", "createdAt");
CREATE INDEX "TaskAction_taskId_timestamp_idx" ON "TaskAction"("taskId", "timestamp");

COMMIT;
