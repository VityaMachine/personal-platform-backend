import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import pinoHttp from "pino-http";

export function createRequestLogger(logger: Logger) {
  // Allowlist fields: raw req/res and exceptions can contain secrets.
  const details = (request: Request, response: Response, responseTime: number) => ({
    method: request.method,
    path: (request.originalUrl || request.url).split("?")[0],
    statusCode: response.statusCode,
    durationMs: responseTime,
    remoteAddress: request.socket.remoteAddress,
    ...(response.locals.errorType ? { error: { type: response.locals.errorType } } : {}),
  });

  return pinoHttp<Request, Response>({
    logger,
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: "requestId" },
    genReqId: (_request, response) => {
      const requestId = randomUUID();
      response.locals.requestId = requestId;
      response.setHeader("X-Request-Id", requestId);
      return requestId;
    },
    customLogLevel: (_request, response, error) =>
      error || response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info",
    customSuccessObject: (request, response, value) => details(request, response, value.responseTime),
    customErrorObject: (request, response, _error, value) => details(request, response, value.responseTime),
    customSuccessMessage: (request, response, time) =>
      `${request.method} ${(request.originalUrl || request.url).split("?")[0]} ${response.statusCode} ${time}ms requestId=${request.id}`,
    customErrorMessage: (request, response) =>
      `${request.method} ${(request.originalUrl || request.url).split("?")[0]} ${response.statusCode} requestId=${request.id}`,
  });
}
