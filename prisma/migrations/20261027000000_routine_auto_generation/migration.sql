ALTER TABLE "Routine"
  ADD COLUMN "autoGenerate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "generationHorizonDays" INTEGER NOT NULL DEFAULT 7,
  ADD CONSTRAINT "Routine_generationHorizonDays_check" CHECK ("generationHorizonDays" BETWEEN 1 AND 30);

CREATE INDEX "Routine_autoGenerate_pausedAt_deletedAt_id_idx"
  ON "Routine"("autoGenerate", "pausedAt", "deletedAt", "id");
