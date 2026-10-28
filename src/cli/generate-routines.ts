import "dotenv/config";
import { disconnectPrisma } from "../infrastructure/database/prisma";
import { readApplicationConfig } from "../config/config";
import { composeApplication } from "../application/compose";

async function main() {
  const config = readApplicationConfig(); // Explicit CLI runs even with the timer disabled.
  const runner = composeApplication({ config }).createRunner();
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
