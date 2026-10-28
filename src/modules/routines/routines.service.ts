import { ApiError } from "../../http/api-error";
import { toRoutineActionResponse, toRoutineResponse } from "./routines.mapper";
import { RoutinesTransactionConflictError, type RoutinesRepository, type RoutinesTransactionRepository } from "./routines.repository";
import { routineStateSchema, type CreateRoutineInput, type UpdateRoutineInput, type RoutineState } from "./routines.schemas";
import { calculateRoutinePreview } from "./routines.preview";
import { normalizePreviewHistory, PREVIEW_HISTORY_BUDGET } from "./routines.preview-history";
import type { RoutinePreviewQuery } from "./routines.preview.schemas";
import { calendarConfiguration, generationConflict, type GenerateRoutineInput, type GenerationRange } from "./routines.generate";
import { createTaskWithSubtasks } from "../tasks/tasks.creation";
import type { Prisma } from "../../generated/prisma/client";
import { resolveRoutineGeneration, validateGenerationPlanning } from "./routines.generation-resolver";
import { appendScheduleVersion } from "./routines.versions.service";
import { calendarSnapshot, parseScheduleVersions, resolveCompletionVersion, validateScheduleVersionHistory, versionMidnight, versionedKey,
  type CreateScheduleVersionInput } from "./routines.versions";
import { currentAutomaticRange } from "./routines.auto-range";
import { resolveVersionedCalendar } from "./routines.versioned-calendar";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function createRoutinesService(repository: RoutinesRepository, now: () => Date = () => new Date()) {
  async function transaction<T>(work: (tx: RoutinesTransactionRepository) => Promise<T>): Promise<T> {
    try { return await repository.transaction(work); }
    catch (error) {
      if (error instanceof RoutinesTransactionConflictError) throw new ApiError(409, "Routine changed concurrently. Retry the request.");
      throw error;
    }
  }
  async function find(id: string, tx: RoutinesTransactionRepository, forGeneration = false) {
    const routine = await tx.findFirst(id);
    if (!routine) throw new ApiError(404, "Routine not found.");
    try { return toRoutineResponse(routine); }
    catch (error) {
      if (forGeneration) generationConflict("Stored Routine configuration is invalid. Generation requires a valid schedule.");
      throw error;
    }
  }
  async function checkArea(areaId: string | null, tx: RoutinesTransactionRepository) {
    if (areaId && !await tx.findArea(areaId)) throw new ApiError(404, "Area not found.");
  }
  async function resolveGeneration(id: string, range: GenerationRange, tx: RoutinesTransactionRepository) {
    // Area -> Routine -> latest completion Task; SELECT locks never create records.
    const initial = await find(id, tx, true);
    await checkArea(initial.areaId, tx);
    await tx.lock(id);
    const routine = await find(id, tx, true);
    const actions = await tx.findHistory(id, PREVIEW_HISTORY_BUDGET + 1);
    return { routine, ...await resolveRoutineGeneration(routine, actions, range, tx, now()) };
  }
  function state(routine: Awaited<ReturnType<typeof find>>): RoutineState {
    return routineStateSchema.parse({
      autoGenerate: routine.autoGenerate, generationHorizonDays: routine.generationHorizonDays,
      title: routine.title, description: routine.description, priority: routine.priority, areaId: routine.areaId,
      estimatedDurationMinutes: routine.estimatedDurationMinutes, timezone: routine.timezone,
      startDate: routine.startDate, schedule: routine.schedule, endCondition: routine.endCondition,
      subtasks: routine.subtasks.map(({ title, estimatedDurationMinutes }) => ({ title, estimatedDurationMinutes })),
    });
  }
  async function persistGeneration(id: string, range: GenerationRange, resolved: Awaited<ReturnType<typeof resolveGeneration>>,
    tx: RoutinesTransactionRepository, input: Pick<GenerateRoutineInput, "planning"> = {}) {
    const { routine, candidates, conflicts } = resolved;
    const planning = validateGenerationPlanning(routine, candidates, input.planning);
    const created: { occurrenceKey: string; taskId: string }[] = [];
    const existing: typeof created = [];
    // Resolve and validate the entire planning map before any writes.
    for (const { occurrence: candidate, chain, existingTaskId, scheduleVersion } of candidates) {
      if (existingTaskId !== null) { existing.push({ occurrenceKey: candidate.occurrenceKey, taskId: existingTaskId }); continue; }
      const { diagnostics: _diagnostics, ...calendar } = candidate;
      const occurrence = await tx.createOccurrence({ ...calendar, ...chain, routineId: id, scheduleVersionId: scheduleVersion!.id,
        instant: calendar.instant === null ? null : new Date(calendar.instant),
        snapshot: JSON.parse(JSON.stringify({ ...routine, ...calendarSnapshot(scheduleVersion!) })) as Prisma.InputJsonValue });
      const { snapshot: _snapshot, createdAt: _createdAt, ...origin } = occurrence;
      const task = await createTaskWithSubtasks(tx.tasks, {
        title: routine.title, description: routine.description, priority: routine.priority,
        estimatedDurationMinutes: routine.estimatedDurationMinutes, plannedAt: planning.get(candidate.occurrenceKey) ?? null, dueAt: null,
      }, routine.subtasks, { area: routine.area, routineOccurrence: { ...origin, snapshot: occurrence.snapshot } });
      created.push({ occurrenceKey: occurrence.occurrenceKey, taskId: task.id });
    }
    return { routineId: id, ...range, createdCount: created.length, existingCount: existing.length, created, existing,
      ...(conflicts.length ? { conflicts } : {}) };
  }
  return {
    list() { return transaction(async (tx) => (await tx.findMany({ deletedAt: null })).map(toRoutineResponse)); },
    get(id: string) { return transaction((tx) => find(id, tx)); },
    scheduleVersions(id: string) {
      return transaction(async (tx) => { await find(id, tx); return parseScheduleVersions(await tx.findScheduleVersions(id)); });
    },
    createScheduleVersion(id: string, input: CreateScheduleVersionInput) {
      return transaction((tx) => appendScheduleVersion(id, input, tx, now));
    },
    generationPreview(id: string, range: GenerationRange) {
      return transaction(async (tx) => {
        const { routine, candidates, conflicts } = await resolveGeneration(id, range, tx);
        return { routineId: id, timezone: routine.timezone, ...range,
          occurrences: candidates.map((entry) => ({ ...entry.occurrence,
            basisType: entry.chain?.basisType ?? null,
            basisAt: entry.chain?.basisAt?.toISOString() ?? null,
            basisCompletedAt: entry.chain?.basisCompletedAt?.toISOString() ?? null,
            instant: entry.occurrence.instant === null ? null : new Date(entry.occurrence.instant).toISOString(),
            existing: entry.existingTaskId !== null })), ...(conflicts.length ? { conflicts } : {}) };
      });
    },
    generate(id: string, input: GenerateRoutineInput) {
      const range = { from: input.from, to: input.to };
      return transaction(async (tx) => {
        const { routine, candidates, conflicts } = await resolveGeneration(id, range, tx);
        return persistGeneration(id, range, { routine, candidates, conflicts }, tx, input);
      });
    },
    generateAutomatically(id: string) {
      return transaction(async (tx) => {
        const initial = await tx.findFirst(id);
        if (!initial) return null;
        await checkArea(initial.areaId, tx);
        await tx.lock(id);
        // Recheck eligibility under the manual generation / settings mutation lock.
        const stored = await tx.findFirst(id);
        if (!stored || !stored.autoGenerate || stored.pausedAt) return null;
        const routine = toRoutineResponse(stored);
        const automatic = { asOf: now(), horizonDays: routine.generationHorizonDays };
        const versions = parseScheduleVersions(await tx.findScheduleVersions(id));
        const range = currentAutomaticRange(versions, automatic);
        const actions = await tx.findHistory(id, PREVIEW_HISTORY_BUDGET + 1);
        const resolved = await resolveRoutineGeneration(routine, actions, range, tx, automatic.asOf, automatic);
        return persistGeneration(id, range, { routine, ...resolved }, tx);
      });
    },
    preview(id: string, query: RoutinePreviewQuery) {
      return transaction(async (tx) => {
        const routine = await find(id, tx);
        if ((query.completedAt !== undefined || query.skippedAt !== undefined) && routine.schedule.recurrence.type !== "AFTER_COMPLETION") {
          throw new ApiError(400, "Completion context requires AFTER_COMPLETION.");
        }
        const actions = await tx.findHistory(id, PREVIEW_HISTORY_BUDGET + 1);
        const versions = parseScheduleVersions(await tx.findScheduleVersions(id));
        if (versions.length > 1) {
          validateScheduleVersionHistory(routine, versions, actions);
          const completionContext = query.skippedAt !== undefined ? { completedAt: query.skippedAt,
            completedOccurrenceNumber: query.skippedOccurrenceNumber! } : query.completedAt === undefined ? undefined
            : { completedAt: query.completedAt, completedOccurrenceNumber: query.completedOccurrenceNumber! };
          if (routine.schedule.recurrence.type === "AFTER_COMPLETION") {
            let selected: ReturnType<typeof resolveCompletionVersion>;
            try { selected = resolveCompletionVersion(routine, versions,
              (version) => normalizePreviewHistory({ ...routine, ...version }, actions, true), completionContext); }
            catch (error) { if (error instanceof RangeError) throw new ApiError(400, error.message); throw error; }
            if (!selected.candidate) throw new ApiError(409, "VERSION_BOUNDARY_NO_CANDIDATE: no completion candidate belongs to its schedule version.");
            const configured = { ...routine, ...selected.candidate.version, id };
            const preview = calculateRoutinePreview(configured, query.from, query.to, query.limit,
              { ...normalizePreviewHistory(configured, actions, true), completionContext });
            return { ...preview, occurrences: preview.occurrences.map((occurrence) => ({ ...occurrence,
              occurrenceKey: versionedKey(occurrence.occurrenceKey, selected.candidate!.version) })) };
          }
          const resolved = resolveVersionedCalendar(routine, actions, versions, await tx.findCompletionChain(id, 10_001), query, false);
          return { routineId: id, timezone: routine.timezone, from: query.from, to: query.to,
            occurrences: resolved.candidates.slice(0, query.limit).map((entry) => entry.occurrence),
            truncated: resolved.truncated || resolved.candidates.length > query.limit, limitations: resolved.limitations,
            ...(resolved.conflicts.length ? { conflicts: resolved.conflicts } : {}) };
        }
        const history = normalizePreviewHistory(routine, actions);
        if (history.limitations.includes("HISTORY_BUDGET_EXCEEDED")) {
          return { routineId: id, timezone: routine.timezone, from: query.from, to: query.to, occurrences: [], truncated: false,
            limitations: ["CURRENT_CONFIGURATION_PROJECTION", ...history.limitations] };
        }
        try {
          return calculateRoutinePreview(routine, query.from, query.to, query.limit, { ...history,
            completionContext: query.skippedAt !== undefined ? {
              completedAt: query.skippedAt, completedOccurrenceNumber: query.skippedOccurrenceNumber!,
            } : query.completedAt === undefined ? undefined : {
              completedAt: query.completedAt, completedOccurrenceNumber: query.completedOccurrenceNumber!,
            } });
        } catch (error) {
          if (error instanceof RangeError) throw new ApiError(400, error.message);
          throw error;
        }
      });
    },
    create(input: CreateRoutineInput) {
      return transaction(async (tx) => {
        const { subtasks, ...fields } = routineStateSchema.parse(input);
        await checkArea(fields.areaId, tx);
        const routine = await tx.create(fields);
        await tx.createScheduleVersion({ routineId: routine.id, number: 1, effectiveDate: fields.startDate,
          effectiveTimezone: fields.timezone, effectiveAt: new Date(versionMidnight(fields.startDate, fields.timezone).epochMilliseconds),
          ...calendarSnapshot(fields) });
        if (subtasks.length) await tx.replaceSubtasks(routine.id, subtasks);
        const after = await find(routine.id, tx);
        await tx.createAction(routine.id, "CREATED", { before: null, after });
        return after;
      });
    },
    update(id: string, input: UpdateRoutineInput) {
      return transaction(async (tx) => {
        const before = await find(id, tx);
        const previous = state(before);
        const { paused, ...patch } = input;
        // Validate the entire merged state before any writes, including overflow.
        const next = routineStateSchema.parse({ ...previous, ...patch });
        if (patch.areaId) await checkArea(patch.areaId, tx);
        await tx.lock(id);
        if (calendarConfiguration(previous) !== calendarConfiguration(next)) {
          generationConflict("Calendar configuration is immutable. Use POST schedule-versions with an explicit future effectiveDate.");
        }
        const changed = !same(previous, next);
        const pauseChanged = paused !== undefined && paused !== Boolean(before.pausedAt);
        if (!changed && !pauseChanged) return before;
        const { subtasks, areaId, ...fields } = next;
        await tx.update(id, { ...fields, ...(patch.areaId !== undefined ? { areaId } : {}),
          ...(pauseChanged ? { pausedAt: paused ? now() : null } : {}) });
        if (!same(previous.subtasks, subtasks)) await tx.replaceSubtasks(id, subtasks);
        const after = await find(id, tx);
        if (changed) await tx.createAction(id, "UPDATED", { before, after });
        if (pauseChanged) await tx.createAction(id, paused ? "PAUSED" : "RESUMED", { before, after });
        return after;
      });
    },
    remove(id: string) {
      return transaction(async (tx) => {
        await tx.lock(id);
        const before = await find(id, tx);
        const after = toRoutineResponse(await tx.update(id, { deletedAt: now() }));
        await tx.createAction(id, "DELETED", { before, after });
      });
    },
    history(id: string) {
      return transaction(async (tx) => { await find(id, tx); return (await tx.findHistory(id)).map(toRoutineActionResponse); });
    },
  };
}
export type RoutinesService = ReturnType<typeof createRoutinesService>;
