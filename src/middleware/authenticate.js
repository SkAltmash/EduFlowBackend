import jwt from "jsonwebtoken";
import AppError from "../utils/AppError.js";
import User from "../models/User.js";
import Tenant from "../models/Tenant.js";
import { TOKEN_TYPES, verifyAccessToken } from "../utils/jwt.js";

function extractBearerToken(req) {
  const header = req.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export function verifyRequestToken(req, allowedTypes) {
  const token = extractBearerToken(req);
  if (!token) {
    throw AppError.unauthorized("Authentication required", "TOKEN_MISSING");
  }

  try {
    return verifyAccessToken(token, allowedTypes);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized("Access token expired", "TOKEN_EXPIRED");
    }
    throw AppError.unauthorized("Invalid access token", "TOKEN_INVALID");
  }
}

/**
 * Requires a valid tenant-scoped access token.
 * Sets req.user = { id, tenantId, role } (plus isImpersonating for super admins).
 */
export async function authenticate(req, res, next) {
  const payload = verifyRequestToken(req, [TOKEN_TYPES.ACCESS]);

  if (!payload.sub || !payload.tenantId || !payload.role) {
    throw AppError.unauthorized("Invalid access token", "TOKEN_INVALID");
  }

  if (payload.impersonation) {
    // Super admin access is too powerful to trust a token alone:
    // re-check on every request so revoking it takes effect immediately.
    const [admin, tenant] = await Promise.all([
      User.findById(payload.sub).select("+isSuperAdmin").lean(),
      Tenant.exists({ _id: payload.tenantId }),
    ]);
    if (!admin?.isActive || !admin.isSuperAdmin || !tenant) {
      throw AppError.unauthorized("Invalid access token", "TOKEN_INVALID");
    }
  }

  req.user = {
    id: payload.sub,
    tenantId: payload.tenantId,
    role: payload.role,
    ...(payload.impersonation ? { isImpersonating: true } : {}),
  };
  next();
}

/**
 * Used only by POST /api/auth/select-tenant. Accepts either a regular access
 * token (switching tenants) or the short-lived tenant-selection token issued
 * at login. Sets req.user = { id } — the tenant is chosen by the endpoint.
 */
export function authenticateForTenantSelection(req, res, next) {
  const payload = verifyRequestToken(req, [TOKEN_TYPES.ACCESS, TOKEN_TYPES.TENANT_SELECTION]);

  if (!payload.sub) {
    throw AppError.unauthorized("Invalid access token", "TOKEN_INVALID");
  }

  req.user = { id: payload.sub };
  next();
}

export default authenticate;
