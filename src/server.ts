import "dotenv/config";

import { composeApplication } from "./application/compose";
import { readApplicationConfig } from "./config/config";
import { disconnectPrisma } from "./infrastructure/database/prisma";

const config = readApplicationConfig();
const port = config.port;
const composition = composeApplication({ config });
const app = composition.createHttpApp();
const runner = composition.createRunner();
const server = app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  if (config.runner.enabled) runner.start(config.runner.intervalMs);
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
