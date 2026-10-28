import { Temporal } from "@js-temporal/polyfill";
import type { RoutineAction } from "../../../generated/prisma/client";
import { routineActionMetadataSchema, toRoutineActionResponse } from "./routines.mapper";
import type { PauseInterval, PreviewRoutine } from "./routines.preview";

export const PREVIEW_HISTORY_BUDGET = 10_000;

/** Interpret event instants in the CURRENT timezone: this is a projection, not historical schedule replay.
 * Pause date is inclusive; resume date exclusive. Same-day pause/resume excludes no dates.
 */
export function normalizePreviewHistory(routine: PreviewRoutine & { pausedAt: Date | null }, actions: readonly RoutineAction[], versioned = false) {
  const limitations = new Set<string>();
  const pauses: PauseInterval[] = [];
  let reliable = true;
  const uncertain = () => { reliable = false; limitations.add("PAUSE_HISTORY_UNCERTAIN"); };
  const localDate = (value: string) => Temporal.Instant.from(value).toZonedDateTimeISO(routine.timezone).toPlainDate().toString();
  const config = (value: PreviewRoutine | { timezone: string; startDate: string; schedule: unknown; endCondition: unknown }) =>
    JSON.stringify([value.timezone, value.startDate, value.schedule, value.endCondition]);
  if (actions.length > PREVIEW_HISTORY_BUDGET) {
    return { pauses, countReliable: false, limitations: ["HISTORY_BUDGET_EXCEEDED", "PAUSE_HISTORY_UNCERTAIN"] };
  }
  const creations = actions.filter((action) => action.type === "CREATED");
  if (creations.length !== 1) uncertain();
  let open: string | null = null;
  let previousTransitionTime: number | null = null;
  const knownPauseStarts = new Set(actions.filter((action) => action.type === "PAUSED").map((action) => {
    toRoutineActionResponse(action);
    return routineActionMetadataSchema.parse(action.metadata).after.pausedAt;
  }));
  for (const action of actions) {
    toRoutineActionResponse(action); // preserve existing corrupt-history failure semantics
    const { before, after } = routineActionMetadataSchema.parse(action.metadata);
    // Even an ordinary UPDATED snapshot can reveal a missing pause event.
    for (const snapshot of [before, after]) {
      if (snapshot?.pausedAt && !knownPauseStarts.has(snapshot.pausedAt)) uncertain();
    }
    if (!versioned && (config(after) !== config(routine) || (before && config(before) !== config(routine)))) {
      reliable = false;
      limitations.add("CONFIGURATION_CHANGED");
    }
    if (creations.length === 1 && action.timestamp < creations[0].timestamp) uncertain();
    if (action.type === "CREATED" && after.pausedAt !== null) uncertain();
    if (action.type !== "PAUSED" && action.type !== "RESUMED") continue;
    const time = action.timestamp.getTime();
    // UUID order cannot establish the real order of transitions with identical timestamps.
    if (time === previousTransitionTime) uncertain();
    previousTransitionTime = time;
    if (action.type === "PAUSED") {
      if (open !== null || before?.pausedAt !== null || after.pausedAt === null) uncertain();
      if (after.pausedAt !== null) open = after.pausedAt;
    } else {
      if (open === null || before?.pausedAt !== open || after.pausedAt !== null) uncertain();
      if (open !== null) {
        const startDate = localDate(open), endDate = localDate(action.timestamp.toISOString());
        if (Temporal.Instant.compare(open, action.timestamp.toISOString()) > 0) uncertain();
        else if (startDate < endDate) pauses.push({ startDate, endDate });
      }
      open = null;
    }
  }
  if (open !== (routine.pausedAt?.toISOString() ?? null)) uncertain();
  // A current pausedAt remains useful even if its corresponding event is missing.
  const currentOpen = routine.pausedAt?.toISOString() ?? open;
  if (currentOpen) pauses.push({ startDate: localDate(currentOpen), endDate: null });
  pauses.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const normalized: PauseInterval[] = [];
  for (const interval of pauses) {
    const previous = normalized.at(-1);
    if (previous && (previous.endDate === null || interval.startDate <= previous.endDate)) {
      previous.endDate = previous.endDate === null || interval.endDate === null ? null
        : previous.endDate > interval.endDate ? previous.endDate : interval.endDate;
    } else normalized.push({ ...interval });
  }
  return { pauses: normalized, countReliable: reliable, limitations: [...limitations] };
}
