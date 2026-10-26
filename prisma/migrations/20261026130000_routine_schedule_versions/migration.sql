ALTER TYPE "RoutineActionType" ADD VALUE 'SCHEDULE_VERSION_CREATED';
BEGIN;
CREATE TABLE "RoutineScheduleVersion" (
  "id" UUID PRIMARY KEY,
  "routineId" UUID NOT NULL REFERENCES "Routine"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "number" INTEGER NOT NULL CHECK ("number" > 0),
  "effectiveDate" VARCHAR(10) NOT NULL,
  "effectiveTimezone" VARCHAR(100) NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "timezone" VARCHAR(100) NOT NULL,
  "startDate" VARCHAR(10) NOT NULL,
  "schedule" JSONB NOT NULL,
  "endCondition" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("routineId", "number"), UNIQUE ("routineId", "effectiveDate"),
  UNIQUE ("routineId", "effectiveAt"), UNIQUE ("routineId", "id")
);
INSERT INTO "RoutineScheduleVersion" ("id", "routineId", "number", "effectiveDate", "effectiveTimezone", "effectiveAt",
  "timezone", "startDate", "schedule", "endCondition", "createdAt")
SELECT gen_random_uuid(), "id", 1, "startDate", "timezone", "startDate"::date::timestamp AT TIME ZONE "timezone",
  "timezone", "startDate", "schedule", "endCondition", "createdAt" FROM "Routine";
ALTER TABLE "RoutineOccurrence" ADD COLUMN "scheduleVersionId" UUID;
UPDATE "RoutineOccurrence" o SET "scheduleVersionId" = v."id"
  FROM "RoutineScheduleVersion" v WHERE v."routineId" = o."routineId" AND v."number" = 1;
ALTER TABLE "RoutineOccurrence" ALTER COLUMN "scheduleVersionId" SET NOT NULL;
ALTER TABLE "RoutineOccurrence" ADD CONSTRAINT "RoutineOccurrence_scheduleVersion_fkey"
  FOREIGN KEY ("routineId", "scheduleVersionId") REFERENCES "RoutineScheduleVersion"("routineId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION protect_routine_schedule_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous "RoutineScheduleVersion"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Schedule versions are immutable' USING ERRCODE = '23514'; END IF;
  PERFORM "id" FROM "Routine" WHERE "id" = NEW."routineId" FOR UPDATE;
  SELECT * INTO previous FROM "RoutineScheduleVersion" WHERE "routineId" = NEW."routineId" ORDER BY "number" DESC LIMIT 1;
  IF FOUND THEN
    IF NEW."number" <> previous."number" + 1 OR NEW."effectiveDate" <= previous."effectiveDate"
      OR NEW."effectiveAt" <= previous."effectiveAt" OR NEW."effectiveTimezone" <> previous."effectiveTimezone" THEN
      RAISE EXCEPTION 'Schedule versions must be appended in strict order' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."number" <> 1 THEN RAISE EXCEPTION 'First version must be 1' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_routine_schedule_version BEFORE INSERT OR UPDATE OR DELETE ON "RoutineScheduleVersion"
  FOR EACH ROW EXECUTE FUNCTION protect_routine_schedule_version();
COMMIT;
