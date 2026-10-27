import { Temporal } from "@js-temporal/polyfill";
import type { ScheduleVersion } from "./routines.versions";

export type AutomaticGeneration = { asOf: Date; horizonDays: number };

/** Each version keeps its own local calendar, including on a timezone boundary. */
export function automaticRange(timezone: string, options: AutomaticGeneration) {
  const today = Temporal.Instant.fromEpochMilliseconds(options.asOf.getTime())
    .toZonedDateTimeISO(timezone).toPlainDate();
  return { from: today.toString(), to: today.add({ days: options.horizonDays - 1 }).toString() };
}

export function currentAutomaticRange(versions: readonly ScheduleVersion[], options: AutomaticGeneration) {
  // The latest configuration can already describe a future version. Select by instant,
  // not by that configuration's timezone or by server-local dates.
  const active = [...versions].reverse().find((version) => version.effectiveAt <= options.asOf) ?? versions[0];
  return automaticRange(active.timezone, options);
}
