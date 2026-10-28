import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { ApiError } from "../../../http/api-error";
import type { RoutineAction } from "../../../generated/prisma/client";
import { routineActionMetadataSchema, type toRoutineResponse } from "./routines.mapper";
import { normalizePreviewHistory, PREVIEW_HISTORY_BUDGET } from "./routines.preview-history";
import { calculateRoutinePreview } from "./domain/routines.preview";
import { routinePreviewQuerySchema } from "./routines.preview.schemas";

export const MAX_NEW_ROUTINE_TASKS = 100;
export const generationRangeSchema = z.strictObject({
  from: routinePreviewQuerySchema.shape.from,
  to: routinePreviewQuerySchema.shape.to,
}).superRefine((value, ctx) => {
  const parsed = routinePreviewQuerySchema.safeParse({ from: value.from, to: value.to });
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
});
export const generateRoutineSchema = generationRangeSchema.safeExtend({
  planning: z.array(z.strictObject({
    occurrenceKey: z.string().min(1).max(512),
    plannedAt: z.iso.datetime({ offset: true }).refine((value) => Number.isFinite(new Date(value).getTime()), "Expected a valid timestamp.")
      .transform((value) => new Date(value)),
  })).max(MAX_NEW_ROUTINE_TASKS).optional(),
}).superRefine((value, ctx) => {
  const keys = value.planning?.map((entry) => entry.occurrenceKey) ?? [];
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["planning"], message: "Planning occurrenceKey values must be unique." });
});
export type GenerationRange = z.output<typeof generationRangeSchema>;
export type GenerateRoutineInput = z.output<typeof generateRoutineSchema>;
export type GenerationRoutine = ReturnType<typeof toRoutineResponse>;
export function generationConflict(message: string): never { throw new ApiError(409, message); }

export function calendarConfiguration(value: Pick<GenerationRoutine, "schedule" | "timezone" | "startDate" | "endCondition">) {
  return JSON.stringify([value.schedule, value.timezone, value.startDate, value.endCondition]);
}

/** Reject visible gaps, contradictory snapshot chains and unordered state changes.
 * UPDATED + PAUSED/RESUMED of the SAME mutation share a before/after pair and are collapsed.
 */
function configurationEffectiveDate(routine: GenerationRoutine, actions: readonly RoutineAction[]) {
  const entries = actions.map((action) => ({ action, ...routineActionMetadataSchema.parse(action.metadata) }));
  const creation = entries.filter(({ action }) => action.type === "CREATED");
  if (creation.length !== 1) generationConflict("Routine history is incomplete. Generation requires a consistent creation and change history.");
  const stateKey = (value: typeof entries[number]["after"]) => JSON.stringify([calendarConfiguration(value), value.pausedAt]);
  let current = stateKey(creation[0].after);
  let effectiveDate: string | null = null;
  const groups = new Map<number, typeof entries>();
  for (const entry of entries) {
    const time = entry.action.timestamp.getTime();
    if (!Number.isFinite(time) || time < creation[0].action.timestamp.getTime()) generationConflict("Routine history has invalid event ordering.");
    const group = groups.get(time) ?? [];
    group.push(entry); groups.set(time, group);
  }
  for (const [time, group] of [...groups].sort(([a], [b]) => a - b)) {
    const changes = new Map<string, typeof entries[number]>();
    for (const entry of group) {
      if (entry.before && stateKey(entry.before) !== stateKey(entry.after)) {
        changes.set(JSON.stringify([stateKey(entry.before), stateKey(entry.after)]), entry);
      }
    }
    if (changes.size > 1 && [...changes.values()].every((entry) => entry.action.type === "SCHEDULE_VERSION_CREATED")) {
      // Persisted version numbers establish order even if multiple appends share a millisecond.
      const ordered = [...changes.values()].sort((a, b) => a.versionNumber! - b.versionNumber!);
      const known = new Set([current]);
      for (const entry of ordered) {
        if (stateKey(entry.before!) !== current) generationConflict("Routine schedule version history has a gap.");
        current = stateKey(entry.after); known.add(current);
      }
      if (group.some((entry) => [entry.before, entry.after].some((snapshot) => snapshot && !known.has(stateKey(snapshot))))) {
        generationConflict("Routine history has inconsistent schedule version snapshots.");
      }
      effectiveDate = Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(routine.timezone).toPlainDate().toString();
      continue;
    }
    if (changes.size > 1) generationConflict("Routine history has ambiguous simultaneous configuration changes.");
    const change = [...changes.values()][0];
    if (change && stateKey(change.before!) !== current) generationConflict("Routine history has a configuration or pause gap.");
    const next = change ? stateKey(change.after) : current;
    for (const entry of group) {
      for (const snapshot of [entry.before, entry.after]) {
        if (snapshot && stateKey(snapshot) !== current && stateKey(snapshot) !== next) {
          generationConflict("Routine history has inconsistent configuration snapshots.");
        }
      }
    }
    if (change && calendarConfiguration(change.before!) !== calendarConfiguration(change.after)) {
      effectiveDate = Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(routine.timezone).toPlainDate().toString();
    }
    current = next;
  }
  if (current !== JSON.stringify([calendarConfiguration(routine), routine.pausedAt?.toISOString() ?? null])) {
    generationConflict("Routine configuration does not match its history.");
  }
  return effectiveDate;
}

export function readGenerationHistory(routine: GenerationRoutine, actions: readonly RoutineAction[], versioned = false) {
  if (routine.pausedAt) generationConflict("Routine is paused. Resume it before generation.");
  if (actions.length > PREVIEW_HISTORY_BUDGET) generationConflict("Routine history budget exceeded. Generation cannot use a partial history.");
  let history: ReturnType<typeof normalizePreviewHistory>;
  let effectiveDate: string | null;
  try {
    history = normalizePreviewHistory(routine, actions, versioned);
    effectiveDate = configurationEffectiveDate(routine, actions);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return generationConflict("Routine history is invalid. Generation requires a consistent history.");
  }
  return { history, effectiveDate: versioned ? null : effectiveDate };
}

export function planRoutineGeneration(routine: GenerationRoutine, actions: readonly RoutineAction[], range: GenerationRange) {
  const { history, effectiveDate } = readGenerationHistory(routine, actions);
  const preview = calculateRoutinePreview(routine, range.from, range.to, 500, history);
  const blocking = preview.limitations.filter((code) => code !== "CURRENT_CONFIGURATION_PROJECTION" && code !== "CONFIGURATION_CHANGED");
  if (blocking.length || preview.truncated) generationConflict(`Routine schedule cannot be generated completely: ${blocking.join(", ") || "TRUNCATED"}.`);
  if (preview.occurrences.some((occurrence) => occurrence.diagnostics.length)) generationConflict("Routine has unresolved DST local times. No Tasks were generated.");
  if (effectiveDate && preview.occurrences.some((occurrence) => occurrence.startDate <= effectiveDate!)) {
    generationConflict("Requested occurrences start on or before the latest calendar configuration change. Generate only windows starting after that local date.");
  }
  return preview.occurrences;
}
