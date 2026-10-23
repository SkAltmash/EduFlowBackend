import AppError from "../utils/AppError.js";

/**
 * Validates req.body against a Zod schema and replaces it with the parsed
 * (trimmed, normalised, unknown-keys-stripped) value.
 */
export function validateBody(schema) {
  return (req, res, next) => {
    req.body = parse(schema, req.body ?? {});
    next();
  };
}

/**
 * Validates req.query. Express 5 makes req.query read-only, so the parsed
 * value is exposed as req.validatedQuery.
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    req.validatedQuery = parse(schema, req.query ?? {});
    next();
  };
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    throw AppError.badRequest("Validation failed", "VALIDATION_ERROR", details);
  }
  return result.data;
}
