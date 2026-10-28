import "dotenv/config";
import { disconnectPrisma } from "../infrastructure/database/prisma";
import { readRunnerConfig } from "../config/config";
import { createDefaultRoutineRunner } from "../modules/routines/routines.runner-factory";

async function main() {
  readRunnerConfig(); // Validate configuration; explicit CLI runs even with the timer disabled.
  const runner = createDefaultRoutineRunner();
  try {
    const result = await runner.runOnce();
    console.log(JSON.stringify(result));
    if (result.errors) process.exitCode = 1;
  } finally {
    await runner.stop();
    await disconnectPrisma();
  }
}
void main().catch(() => { console.error("Routine generation command failed. Check server configuration and runner diagnostics."); process.exitCode = 1; });
