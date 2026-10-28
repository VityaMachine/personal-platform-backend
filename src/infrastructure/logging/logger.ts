import pino, { type DestinationStream } from "pino";

export function createLogger(
  environment = process.env.NODE_ENV ?? "development",
  destination?: DestinationStream,
) {
  const options: pino.LoggerOptions = {
    level: "info",
    ...(environment === "development" && !destination ? {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "hostname",
          singleLine: false,
          messageFormat: "{method} {path} {statusCode} {durationMs}ms requestId={requestId}",
        },
      },
    } : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}
