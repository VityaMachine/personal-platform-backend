import { createLogger } from "../../lib/logger";
import { createRoutinesRepository } from "./routines.repository";
import { createRoutinesService } from "./routines.service";
import { createRoutineRunner } from "./routines.runner";

export function createDefaultRoutineRunner() {
  const repository = createRoutinesRepository();
  return createRoutineRunner({ repository, service: createRoutinesService(repository), logger: createLogger() });
}
