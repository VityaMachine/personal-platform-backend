BEGIN;

ALTER TYPE "TaskActionType" ADD VALUE 'SUBTASK_CREATED';
ALTER TYPE "TaskActionType" ADD VALUE 'SUBTASK_EDITED';
ALTER TYPE "TaskActionType" ADD VALUE 'SUBTASK_STATUS_CHANGED';
ALTER TYPE "TaskActionType" ADD VALUE 'SUBTASK_DELETED';

CREATE TABLE "Subtask" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "estimatedDurationMinutes" INTEGER NOT NULL,
    "cancellationNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "Subtask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Subtask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Subtask_estimatedDurationMinutes_positive" CHECK ("estimatedDurationMinutes" > 0),
    CONSTRAINT "Subtask_cancellationNote_required" CHECK (
        "status" <> 'CANCELED' OR
        ("cancellationNote" IS NOT NULL AND length(btrim("cancellationNote")) > 0)
    )
);

CREATE INDEX "Subtask_taskId_deletedAt_createdAt_idx" ON "Subtask"("taskId", "deletedAt", "createdAt");

COMMIT;
