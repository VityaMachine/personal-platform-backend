import "dotenv/config";

import { app } from "./app";
import { readRunnerConfig } from "./config/config";
import { disconnectPrisma } from "./infrastructure/database/prisma";
import { createDefaultRoutineRunner } from "./modules/tasks/routines/routines.runner-factory";

const port = Number(process.env.PORT) || 4000;

const config = readRunnerConfig();
const runner = createDefaultRoutineRunner();
const server = app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  if (config.enabled) runner.start(config.intervalMs);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await runner.stop();
  await closed;
  await disconnectPrisma();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
