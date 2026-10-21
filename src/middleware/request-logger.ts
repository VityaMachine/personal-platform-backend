import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RequestHandler } from "express";

export const requestLogger: RequestHandler = (request, response, next) => {
  const requestId = randomUUID();
  const startedAt = performance.now();
  const path = request.path;
  response.locals.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  response.once("finish", () => {
    console.log(JSON.stringify({
      requestId,
      method: request.method,
      path,
      statusCode: response.statusCode,
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
    }));
  });
  next();
};
