export default class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = "Bad request", code = "BAD_REQUEST", details) {
    return new AppError(400, message, code, details);
  }

  static unauthorized(message = "Authentication required", code = "UNAUTHORIZED") {
    return new AppError(401, message, code);
  }

  static forbidden(message = "You do not have permission to perform this action", code = "FORBIDDEN") {
    return new AppError(403, message, code);
  }

  static notFound(message = "Not found", code = "NOT_FOUND") {
    return new AppError(404, message, code);
  }

  static conflict(message = "Conflict", code = "CONFLICT") {
    return new AppError(409, message, code);
  }
}
