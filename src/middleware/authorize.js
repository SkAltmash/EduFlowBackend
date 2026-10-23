import AppError from "../utils/AppError.js";
import { ROLES } from "../models/Membership.js";

const VALID_ROLES = new Set(Object.values(ROLES));

/**
 * Restricts a route to the given roles within the current tenant.
 * Must run after `authenticate`.
 *
 *   router.delete("/users/:id", authenticate, authorize("owner", "admin"), controller);
 */
export function authorize(...allowedRoles) {
  for (const role of allowedRoles) {
    if (!VALID_ROLES.has(role)) {
      throw new Error(`authorize(): unknown role "${role}"`);
    }
  }

  return (req, res, next) => {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    if (!allowedRoles.includes(req.user.role)) {
      throw AppError.forbidden();
    }
    next();
  };
}

export default authorize;
