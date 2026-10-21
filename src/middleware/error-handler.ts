import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { ApiError } from "../lib/api-error";

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  // Allowlisted categories only: exception messages/stacks can contain secrets.
  const errorType = error instanceof ApiError ? "api_error"
    : error instanceof ZodError ? "validation_error"
    : error?.type === "entity.parse.failed" ? "invalid_json"
    : error?.type === "entity.too.large" ? "body_too_large"
    : "internal_error";
  // pino-http emits the single completion record with this safe category.
  response.locals.errorType = errorType;

  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { message: error.message } });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        message: "Invalid task data.",
        details: error.issues.map(({ path, message }) => ({ path, message })),
      },
    });
    return;
  }

  if (error?.type === "entity.parse.failed") {
    response.status(400).json({ error: { message: "Invalid JSON body." } });
    return;
  }

  if (error?.type === "entity.too.large") {
    response.status(413).json({ error: { message: "Request body is too large." } });
    return;
  }

  response.status(500).json({ error: { message: "Internal server error." } });
};
