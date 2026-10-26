import { ApiError } from "../../lib/api-error";
import type { RoutinesTransactionRepository } from "./routines.repository";
import { toRoutineResponse } from "./routines.mapper";
import { calendarVersionSchema, parseScheduleVersions, versionMidnight, VERSION_BUDGET, versionConflict,
  type CreateScheduleVersionInput } from "./routines.versions";

/** Caller owns the Serializable transaction. Lock order is Area -> Routine, as in generate. */
export async function appendScheduleVersion(id: string, input: CreateScheduleVersionInput, tx: RoutinesTransactionRepository, now: () => Date) {
  const initial = await tx.findFirst(id);
  if (!initial) throw new ApiError(404, "Routine not found.");
  if (initial.areaId && !await tx.findArea(initial.areaId)) throw new ApiError(404, "Area not found.");
  await tx.lock(id);
  const row = await tx.findFirst(id);
  if (!row) throw new ApiError(404, "Routine not found.");
  const before = toRoutineResponse(row);
  const versions = parseScheduleVersions(await tx.findScheduleVersions(id));
  if (versions.length >= VERSION_BUDGET) versionConflict("Schedule version budget reached.");
  const first = versions[0], latest = versions.at(-1)!;
  const effectiveAt = new Date(versionMidnight(input.effectiveDate, first.effectiveTimezone).epochMilliseconds);
  if (input.effectiveDate <= latest.effectiveDate || effectiveAt <= latest.effectiveAt) {
    versionConflict("effectiveDate must be strictly later than the latest schedule version.");
  }
  if (effectiveAt <= now()) versionConflict("Retroactive schedule versions are not allowed. Choose a future date in effectiveTimezone.");
  const { effectiveDate, ...configuration } = input;
  if ((configuration.schedule.recurrence.type === "AFTER_COMPLETION") !== (latest.schedule.recurrence.type === "AFTER_COMPLETION")) {
    versionConflict("Switching between calendar and AFTER_COMPLETION modes is not supported; create a separate Routine.");
  }
  if (configuration.schedule.recurrence.type === "AFTER_COMPLETION" && configuration.startDate !== first.startDate) {
    versionConflict("AFTER_COMPLETION startDate is immutable across schedule versions.");
  }
  const stored = await tx.findCompletionChain(id, 10_001);
  if (stored.length > 10_000) versionConflict("Stored occurrence budget exceeded.");
  if (configuration.endCondition.type === "COUNT" && configuration.endCondition.count < stored.length) {
    versionConflict("COUNT cannot be less than the number of already materialized occurrences.");
  }
  const version = await tx.createScheduleVersion({ routineId: id, number: latest.number + 1, effectiveDate,
    effectiveTimezone: first.effectiveTimezone, effectiveAt, ...configuration });
  const after = toRoutineResponse(await tx.update(id, configuration));
  await tx.createAction(id, "SCHEDULE_VERSION_CREATED", { before, after, effectiveDate,
    scheduleVersionId: version.id, versionNumber: version.number });
  return { ...version, ...calendarVersionSchema.parse(configuration) };
}
