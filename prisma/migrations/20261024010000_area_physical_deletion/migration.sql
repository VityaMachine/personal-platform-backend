BEGIN;

-- Preserve all Area and Task rows. Previously archived areas become ordinary areas.
ALTER TABLE "Area" DROP COLUMN "archivedAt";

COMMIT;
