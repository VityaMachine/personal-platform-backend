BEGIN;

CREATE TYPE "RoutineActionType" AS ENUM ('CREATED', 'UPDATED', 'PAUSED', 'RESUMED', 'DELETED');
CREATE TABLE "Routine" (
    "id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "areaId" UUID,
    "estimatedDurationMinutes" INTEGER NOT NULL,
    "timezone" VARCHAR(100) NOT NULL,
    "startDate" VARCHAR(10) NOT NULL,
    "schedule" JSONB NOT NULL,
    "endCondition" JSONB NOT NULL,
    "pausedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Routine_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Routine_duration_positive" CHECK ("estimatedDurationMinutes" > 0)
);
CREATE INDEX "Routine_deletedAt_createdAt_id_idx" ON "Routine"("deletedAt", "createdAt" DESC, "id");
CREATE INDEX "Routine_areaId_idx" ON "Routine"("areaId");

CREATE TABLE "RoutineSubtask" (
    "id" UUID NOT NULL,
    "routineId" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "estimatedDurationMinutes" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "RoutineSubtask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RoutineSubtask_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RoutineSubtask_duration_positive" CHECK ("estimatedDurationMinutes" > 0),
    CONSTRAINT "RoutineSubtask_position_nonnegative" CHECK ("position" >= 0)
);
CREATE UNIQUE INDEX "RoutineSubtask_routineId_position_key" ON "RoutineSubtask"("routineId", "position");

CREATE TABLE "RoutineAction" (
    "id" UUID NOT NULL,
    "routineId" UUID NOT NULL,
    "type" "RoutineActionType" NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL,
    CONSTRAINT "RoutineAction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RoutineAction_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "RoutineAction_routineId_timestamp_id_idx" ON "RoutineAction"("routineId", "timestamp", "id");

COMMIT;
