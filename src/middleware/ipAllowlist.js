import env from "../config/env.js";
import AppError from "../utils/AppError.js";

const normalize = (ip = "") => ip.replace(/^::ffff:/, "");

/** Restricts a router to ADMIN_IP_ALLOWLIST (comma-separated). Empty = allow all. */
export function adminIpAllowlist(req, res, next) {
  if (env.adminIpAllowlist.length === 0) return next();
  if (!env.adminIpAllowlist.includes(normalize(req.ip))) {
    throw AppError.forbidden("Access denied from this network", "IP_NOT_ALLOWED");
  }
  next();
}
