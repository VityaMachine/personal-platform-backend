import { z } from "zod";

const runnerConfigSchema = z.object({
  ROUTINE_AUTO_GENERATION_ENABLED: z.enum(["true", "false"]).default("true"),
  ROUTINE_AUTO_GENERATION_INTERVAL_MS: z.coerce.number().int().min(1000).max(86_400_000).default(300_000),
});

export function readRunnerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = runnerConfigSchema.safeParse(environment);
  if (!parsed.success) throw new Error("Invalid Routine runner configuration: expected ENABLED=true|false and INTERVAL_MS integer 1000–86400000.");
  return { enabled: parsed.data.ROUTINE_AUTO_GENERATION_ENABLED === "true",
    intervalMs: parsed.data.ROUTINE_AUTO_GENERATION_INTERVAL_MS };
}

export function readApplicationConfig(environment: NodeJS.ProcessEnv = process.env) {
  return {
    port: Number(environment.PORT) || 4000,
    clientOrigin: environment.CLIENT_ORIGIN ?? "http://localhost:3000",
    runner: readRunnerConfig(environment),
  };
}

export type ApplicationConfig = ReturnType<typeof readApplicationConfig>;
