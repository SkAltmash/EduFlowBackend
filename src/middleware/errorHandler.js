import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
import env from "../config/env.js";

/** Unexpected server errors since this process started (shown in the super admin console). */
export const errorStats = { count: 0, since: new Date().toISOString(), last: null };

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  // Malformed JSON body
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "INVALID_JSON", message: "Malformed JSON body" } });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } });
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: { code: "INVALID_ID", message: `Invalid ${err.path}` } });
  }

  if (err?.code === 11000) {
    return res.status(409).json({ error: { code: "DUPLICATE", message: "Resource already exists" } });
  }

  console.error(err);
  errorStats.count += 1;
  errorStats.last = { at: new Date().toISOString(), path: `${req.method} ${req.originalUrl.split("?")[0]}`, message: String(err?.message ?? err).slice(0, 200) };
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: env.isProduction ? "Internal server error" : err.message,
    },
  });
}
