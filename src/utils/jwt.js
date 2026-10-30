import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import env from "../config/env.js";

export const TOKEN_TYPES = Object.freeze({
  ACCESS: "access",
  REFRESH: "refresh",
  // Short-lived token issued at login when the user belongs to several tenants.
  // It only grants access to POST /api/auth/select-tenant.
  TENANT_SELECTION: "tenant_selection",
  // Super admin token for /api/admin/*. Not tied to any tenant.
  PLATFORM: "platform",
  // Password checked, waiting for the super admin's authenticator code (POST /api/auth/two-factor)
  TWO_FACTOR: "two_factor",
  // Mobile number verified by OTP during sign-up; sent with POST /api/auth/register
  PHONE_VERIFIED: "phone_verified",
});

const ALGORITHM = "HS256";
const TENANT_SELECTION_TTL = "5m";

const baseSignOptions = {
  algorithm: ALGORITHM,
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
};

const baseVerifyOptions = {
  algorithms: [ALGORITHM],
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
};

/**
 * Tenant-scoped access token. `impersonation: true` marks a token a super admin
 * obtained through POST /api/admin/tenants/:id/enter (sub is the super admin).
 */
export function signAccessToken({ userId, tenantId, role, impersonation = false }) {
  return jwt.sign(
    {
      sub: String(userId),
      tenantId: String(tenantId),
      role,
      type: TOKEN_TYPES.ACCESS,
      ...(impersonation ? { impersonation: true } : {}),
    },
    env.JWT_ACCESS_SECRET,
    { ...baseSignOptions, expiresIn: env.ACCESS_TOKEN_TTL }
  );
}

export function signPlatformToken(userId) {
  return jwt.sign(
    { sub: String(userId), type: TOKEN_TYPES.PLATFORM, scope: "superadmin" },
    env.JWT_ACCESS_SECRET,
    { ...baseSignOptions, expiresIn: env.ACCESS_TOKEN_TTL }
  );
}

export function signTenantSelectionToken(userId) {
  return jwt.sign(
    { sub: String(userId), type: TOKEN_TYPES.TENANT_SELECTION },
    env.JWT_ACCESS_SECRET,
    { ...baseSignOptions, expiresIn: TENANT_SELECTION_TTL }
  );
}

export function signTwoFactorToken(userId) {
  return jwt.sign({ sub: String(userId), type: TOKEN_TYPES.TWO_FACTOR }, env.JWT_ACCESS_SECRET, { ...baseSignOptions, expiresIn: "5m" });
}

export function signPhoneToken(phone) {
  return jwt.sign({ sub: phone, type: TOKEN_TYPES.PHONE_VERIFIED }, env.JWT_ACCESS_SECRET, { ...baseSignOptions, expiresIn: "30m" });
}

export function signRefreshToken({ userId, sessionId, jti, expiresAt }) {
  const expiresInSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return jwt.sign(
    { sub: String(userId), sid: String(sessionId), type: TOKEN_TYPES.REFRESH },
    env.JWT_REFRESH_SECRET,
    { ...baseSignOptions, expiresIn: expiresInSeconds, jwtid: jti }
  );
}

/**
 * Verifies a token signed with the access secret.
 * Throws if the signature, expiry, issuer/audience or type is invalid.
 */
export function verifyAccessToken(token, allowedTypes = [TOKEN_TYPES.ACCESS]) {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, baseVerifyOptions);
  if (!allowedTypes.includes(payload.type)) {
    throw new jwt.JsonWebTokenError("Invalid token type");
  }
  return payload;
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, baseVerifyOptions);
  if (payload.type !== TOKEN_TYPES.REFRESH || !payload.sid || !payload.jti) {
    throw new jwt.JsonWebTokenError("Invalid token type");
  }
  return payload;
}

export function generateTokenId() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
