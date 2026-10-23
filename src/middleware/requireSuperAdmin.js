import User from "../models/User.js";
import AppError from "../utils/AppError.js";
import { TOKEN_TYPES } from "../utils/jwt.js";
import { verifyRequestToken } from "./authenticate.js";

/**
 * Requires a platform (super admin) token. The user is re-loaded from the
 * database on every request so removing super admin rights is instant.
 * Sets req.admin = { id, name, email }.
 */
export async function requireSuperAdmin(req, res, next) {
  const payload = verifyRequestToken(req, [TOKEN_TYPES.PLATFORM]);

  const user = await User.findById(payload.sub).select("+isSuperAdmin").lean();
  if (!user?.isActive || !user.isSuperAdmin) {
    throw AppError.forbidden("Super admin access required", "SUPER_ADMIN_REQUIRED");
  }

  req.admin = { id: String(user._id), name: user.name, email: user.email };
  next();
}
