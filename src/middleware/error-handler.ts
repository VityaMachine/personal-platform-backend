import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
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

  console.error("API request failed:", error);
  response.status(500).json({ error: { message: "Internal server error." } });
};
