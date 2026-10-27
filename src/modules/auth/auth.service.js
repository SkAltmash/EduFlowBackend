import crypto from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import env from "../../config/env.js";
import User from "../../models/User.js";
import Tenant from "../../models/Tenant.js";
import Membership, { ROLES } from "../../models/Membership.js";
import Session from "../../models/Session.js";
import AuditLog from "../../models/AuditLog.js";
import AppError from "../../utils/AppError.js";
import { startTrial } from "../platform/subscription.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import {
  generateTokenId,
  hashToken,
  signAccessToken,
  signPlatformToken,
  signRefreshToken,
  signTenantSelectionToken,
  signTwoFactorToken,
  TOKEN_TYPES,
  verifyAccessToken,
  verifyRefreshToken,
} from "../../utils/jwt.js";
import { decrypt } from "../../utils/crypto.js";
import { verifyCode } from "../platform/totp.js";

const ROTATION_GRACE_MS = 30 * 1000;

const INVALID_CREDENTIALS = () =>
  AppError.unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
const INVALID_REFRESH = () =>
  AppError.unauthorized("Session expired. Please log in again.", "REFRESH_TOKEN_INVALID");
const TENANT_ACCESS_DENIED = () =>
  AppError.forbidden("You do not have access to this organization", "TENANT_ACCESS_DENIED");

// ---------------------------------------------------------------------------
// Serializers — the only shapes that leave this module
// ---------------------------------------------------------------------------

export function serializeUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function serializeTenant(tenant) {
  return { id: String(tenant._id), name: tenant.name, slug: tenant.slug };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "org";
}

async function generateUniqueSlug(name, session) {
  const base = slugify(name);
  if (!(await Tenant.exists({ slug: base }).session(session))) return base;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${base}-${crypto.randomBytes(3).toString("hex")}`;
    if (!(await Tenant.exists({ slug: candidate }).session(session))) return candidate;
  }
  throw new Error("Could not generate a unique tenant slug");
}

/** Memberships of a user whose tenant still exists and is active. */
async function getActiveMemberships(userId) {
  const memberships = await Membership.find({ userId }).populate("tenantId").lean();
  return memberships
    .filter((m) => m.tenantId && m.tenantId.isActive)
    .map((m) => ({ role: m.role, tenant: m.tenantId }));
}

/**
 * Looks up the membership for (userId, tenantId) and checks the tenant is active.
 * This is the single place tenant access is decided — a tenantId coming from
 * the client is never trusted without passing through here.
 */
async function getVerifiedMembership(userId, tenantId) {
  if (!mongoose.isValidObjectId(tenantId)) return null;

  const membership = await Membership.findOne({ userId, tenantId }).lean();
  if (!membership) return null;

  const tenant = await Tenant.findOne({ _id: tenantId, isActive: true }).lean();
  if (!tenant) return null;

  return { role: membership.role, tenant };
}

function buildAccessToken(userId, tenantId, role) {
  const accessToken = signAccessToken({ userId, tenantId, role });
  const { exp } = jwt.decode(accessToken);
  return { accessToken, accessTokenExpiresAt: new Date(exp * 1000) };
}

async function createSession({ userId, tenantId, kind = "tenant", meta }) {
  const jti = generateTokenId();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await Session.create({
    userId,
    kind,
    tenantId,
    tokenHash: hashToken(jti),
    expiresAt,
    userAgent: meta?.userAgent?.slice(0, 500),
    ip: meta?.ip?.slice(0, 64),
  });

  const refreshToken = signRefreshToken({ userId, sessionId: session._id, jti, expiresAt });
  return { refreshToken, refreshTokenExpiresAt: expiresAt };
}

async function issueAuthResult({ user, tenant, role, meta }) {
  const { refreshToken, refreshTokenExpiresAt } = await createSession({
    userId: user._id,
    tenantId: tenant._id,
    meta,
  });

  return {
    user: serializeUser(user),
    tenant: serializeTenant(tenant),
    role,
    ...buildAccessToken(user._id, tenant._id, role),
    refreshToken,
    refreshTokenExpiresAt,
  };
}

function buildPlatformToken(userId) {
  const accessToken = signPlatformToken(userId);
  const { exp } = jwt.decode(accessToken);
  return { accessToken, accessTokenExpiresAt: new Date(exp * 1000) };
}

/** Super admins get a platform session (no tenant); they enter tenants via /api/admin. */
async function issuePlatformAuthResult({ user, meta }) {
  const { refreshToken, refreshTokenExpiresAt } = await createSession({
    userId: user._id,
    kind: "platform",
    meta,
  });

  await AuditLog.create({
    actorId: user._id,
    action: "admin.login",
    targetType: "platform",
    ip: meta?.ip,
    userAgent: meta?.userAgent?.slice(0, 500),
  });

  return {
    user: serializeUser(user),
    isSuperAdmin: true,
    ...buildPlatformToken(user._id),
    refreshToken,
    refreshTokenExpiresAt,
  };
}

/** Best-effort revocation of the session behind a refresh token (if it is valid). */
async function revokeSessionFromToken(refreshToken, expectedUserId) {
  if (!refreshToken) return;
  try {
    const payload = verifyRefreshToken(refreshToken);
    if (expectedUserId && payload.sub !== String(expectedUserId)) return;
    await Session.updateOne(
      { _id: payload.sid, userId: payload.sub, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
  } catch {
    // Invalid/expired token: nothing to revoke
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function register({ name, email, password, tenantName }, meta) {
  if (await User.exists({ email })) {
    throw AppError.conflict("An account with this email already exists", "EMAIL_TAKEN");
  }

  const passwordHash = await hashPassword(password);
  let user;
  let tenant;

  try {
    // User, tenant and owner membership are created together or not at all
    await mongoose.connection.transaction(async (session) => {
      [user] = await User.create([{ name, email, passwordHash }], { session });

      const orgName = tenantName || `${name}'s Organization`;
      const slug = await generateUniqueSlug(orgName, session);
      [tenant] = await Tenant.create([{ name: orgName, slug }], { session });

      await Membership.create(
        [{ userId: user._id, tenantId: tenant._id, role: ROLES.OWNER }],
        { session }
      );
    });
  } catch (err) {
    // Lost a race with a concurrent registration for the same email
    if (err?.code === 11000 && err?.keyPattern?.email) {
      throw AppError.conflict("An account with this email already exists", "EMAIL_TAKEN");
    }
    throw err;
  }

  // Every new school starts on the free trial
  await startTrial(tenant);

  return issueAuthResult({ user, tenant, role: ROLES.OWNER, meta });
}

export async function login({ email, password }, meta) {
  const user = await User.findOne({ email }).select("+passwordHash +isSuperAdmin");

  // Always run bcrypt so response time doesn't reveal whether the email exists
  const passwordOk = await verifyPassword(password, user?.passwordHash);
  if (!user || !passwordOk || !user.isActive) {
    throw INVALID_CREDENTIALS();
  }

  if (user.isSuperAdmin) {
    // Two-step login: the password alone isn't enough for platform access
    if (user.twoFactor?.enabled) {
      return { requiresTenantSelection: false, requiresTwoFactor: true, twoFactorToken: signTwoFactorToken(user._id) };
    }
    return { requiresTenantSelection: false, ...(await issuePlatformAuthResult({ user, meta })) };
  }

  const memberships = await getActiveMemberships(user._id);

  if (memberships.length === 0) {
    throw AppError.forbidden(
      "Your account is not linked to any active organization",
      "NO_ACTIVE_TENANT"
    );
  }

  if (memberships.length === 1) {
    const [{ tenant, role }] = memberships;
    return { requiresTenantSelection: false, ...(await issueAuthResult({ user, tenant, role, meta })) };
  }

  // Several tenants: the client must call POST /api/auth/select-tenant
  return {
    requiresTenantSelection: true,
    user: serializeUser(user),
    tenants: memberships.map(({ tenant, role }) => ({ ...serializeTenant(tenant), role })),
    selectionToken: signTenantSelectionToken(user._id),
  };
}

export async function selectTenant(userId, tenantId, { currentRefreshToken, meta } = {}) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw AppError.unauthorized("Invalid access token", "TOKEN_INVALID");
  }

  const membership = await getVerifiedMembership(user._id, tenantId);
  if (!membership) {
    throw TENANT_ACCESS_DENIED();
  }

  // Switching tenant replaces the current session rather than adding another
  await revokeSessionFromToken(currentRefreshToken, user._id);

  return issueAuthResult({ user, tenant: membership.tenant, role: membership.role, meta });
}

/** Fresh access token for a session, or null if the session is no longer allowed. */
async function buildRefreshResult(session) {
  if (session.kind === "platform") {
    const user = await User.findById(session.userId).select("+isSuperAdmin");
    if (!user?.isActive || !user.isSuperAdmin) return null;
    return { user: serializeUser(user), isSuperAdmin: true, ...buildPlatformToken(user._id) };
  }

  const user = await User.findById(session.userId);
  const membership = user?.isActive && (await getVerifiedMembership(user._id, session.tenantId));
  if (!membership) return null;

  return {
    user: serializeUser(user),
    tenant: serializeTenant(membership.tenant),
    role: membership.role,
    ...buildAccessToken(user._id, membership.tenant._id, membership.role),
  };
}

export async function refresh(refreshToken) {
  if (!refreshToken) {
    throw AppError.unauthorized("Refresh token missing", "REFRESH_TOKEN_MISSING");
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw INVALID_REFRESH();
  }

  const session = await Session.findById(payload.sid);
  if (!session || String(session.userId) !== payload.sub || session.revokedAt) {
    throw INVALID_REFRESH();
  }

  const presentedHash = hashToken(payload.jti);
  const isCurrent = presentedHash === session.tokenHash;
  const isRecentlyRotated =
    presentedHash === session.previousTokenHash &&
    session.rotatedAt &&
    Date.now() - session.rotatedAt.getTime() < ROTATION_GRACE_MS;

  if (!isCurrent && !isRecentlyRotated) {
    // An old refresh token was replayed: assume it was stolen and end every session of this user
    await Session.updateMany(
      { userId: session.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw AppError.unauthorized("Session expired. Please log in again.", "REFRESH_TOKEN_REUSED");
  }

  // Re-check everything: the user, tenant, role or super admin flag may have changed since login
  const result = await buildRefreshResult(session);
  if (!result) {
    session.revokedAt = new Date();
    await session.save();
    throw INVALID_REFRESH();
  }

  if (isRecentlyRotated) {
    // A concurrent request already rotated this token and set the new cookie
    return { ...result, refreshToken: null, refreshTokenExpiresAt: null };
  }

  // Rotate: atomically swap the token hash so two concurrent rotations can't both win
  const newJti = generateTokenId();
  const rotated = await Session.findOneAndUpdate(
    { _id: session._id, tokenHash: presentedHash, revokedAt: null },
    {
      $set: {
        tokenHash: hashToken(newJti),
        previousTokenHash: presentedHash,
        rotatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (!rotated) {
    // Lost the race to another request within the same instant
    return { ...result, refreshToken: null, refreshTokenExpiresAt: null };
  }

  return {
    ...result,
    refreshToken: signRefreshToken({
      userId: session.userId,
      sessionId: session._id,
      jti: newJti,
      expiresAt: session.expiresAt,
    }),
    refreshTokenExpiresAt: session.expiresAt,
  };
}

export async function logout(refreshToken) {
  await revokeSessionFromToken(refreshToken);
}

export async function getCurrentUser({ id, tenantId, isImpersonating }) {
  if (isImpersonating) {
    const [user, tenant] = await Promise.all([User.findById(id), Tenant.findById(tenantId)]);
    return {
      user: serializeUser(user),
      tenant: serializeTenant(tenant),
      role: ROLES.OWNER,
      isImpersonating: true,
    };
  }

  const user = await User.findById(id);
  const membership = user?.isActive && (await getVerifiedMembership(user._id, tenantId));
  if (!membership) {
    throw AppError.unauthorized("Invalid access token", "TOKEN_INVALID");
  }

  return {
    user: serializeUser(user),
    tenant: serializeTenant(membership.tenant),
    role: membership.role,
  };
}

// ---------------------------------------------------------------------------
// Own account
// ---------------------------------------------------------------------------

function assertOwnAccount({ isImpersonating }) {
  // A super admin inside a school is using someone else's workspace, not their own account
  if (isImpersonating) throw AppError.forbidden("Super admin accounts are managed with `npm run superadmin`", "SUPER_ADMIN_PROTECTED");
}

export async function updateMe(actor, { name }) {
  assertOwnAccount(actor);
  const user = await User.findByIdAndUpdate(actor.id, { $set: { name } }, { returnDocument: "after" });
  if (!user) throw AppError.notFound("User not found");
  return { user: serializeUser(user) };
}

/** Changes the password and signs out every other device; the current one stays signed in. */
export async function changePassword(actor, { currentPassword, newPassword }, currentRefreshToken) {
  assertOwnAccount(actor);
  const user = await User.findById(actor.id).select("+passwordHash");
  if (!user) throw AppError.notFound("User not found");
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw AppError.badRequest("Current password is incorrect", "WRONG_PASSWORD", [{ field: "currentPassword", message: "Current password is incorrect" }]);
  }

  user.passwordHash = await hashPassword(newPassword);
  await user.save();

  let keep = null;
  try {
    const payload = verifyRefreshToken(currentRefreshToken);
    if (payload.sub === String(user._id)) keep = payload.sid;
  } catch {
    // No valid cookie: sign out everywhere
  }
  const { modifiedCount } = await Session.updateMany(
    { userId: user._id, revokedAt: null, ...(keep ? { _id: { $ne: keep } } : {}) },
    { $set: { revokedAt: new Date() } }
  );
  return { signedOutSessions: modifiedCount };
}

/** Second step of a super admin's login: the 6-digit code from their authenticator app. */
export async function completeTwoFactor({ token, code }, meta) {
  let payload;
  try {
    payload = verifyAccessToken(token, [TOKEN_TYPES.TWO_FACTOR]);
  } catch {
    throw AppError.unauthorized("That took too long. Sign in again.", "TWO_FACTOR_EXPIRED");
  }
  const user = await User.findById(payload.sub).select("+isSuperAdmin +twoFactor.secretEnc");
  const secret = user?.twoFactor?.enabled ? decrypt(user.twoFactor.secretEnc) : null;
  if (!user?.isActive || !user.isSuperAdmin || !secret) throw INVALID_CREDENTIALS();
  if (!verifyCode(secret, code)) {
    throw AppError.unauthorized("That code isn't right. Check your authenticator app and try again.", "TWO_FACTOR_INVALID");
  }
  return { requiresTenantSelection: false, ...(await issuePlatformAuthResult({ user, meta })) };
}
