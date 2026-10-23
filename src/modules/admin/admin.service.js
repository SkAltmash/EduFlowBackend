import jwt from "jsonwebtoken";
import User from "../../models/User.js";
import Tenant from "../../models/Tenant.js";
import Membership, { ROLES } from "../../models/Membership.js";
import Session from "../../models/Session.js";
import AuditLog from "../../models/AuditLog.js";
import AppError from "../../utils/AppError.js";
import { hashPassword } from "../../utils/password.js";
import { signAccessToken } from "../../utils/jwt.js";
import { serializeTenant, serializeUser } from "../auth/auth.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statusFilter(status) {
  if (status === "active") return { isActive: true };
  if (status === "inactive") return { isActive: false };
  return {};
}

function pageInfo(page, limit, total) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** ctx = { adminId, ip, userAgent } — built by the controller from the request. */
function audit(ctx, entry) {
  return AuditLog.create({
    actorId: ctx.adminId,
    ip: ctx.ip?.slice(0, 64),
    userAgent: ctx.userAgent?.slice(0, 500),
    ...entry,
  });
}

function revokeSessions(filter) {
  return Session.updateMany({ ...filter, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

async function findTenantOrThrow(id) {
  const tenant = await Tenant.findById(id);
  if (!tenant) throw AppError.notFound("Tenant not found");
  return tenant;
}

async function findUserOrThrow(id) {
  const user = await User.findById(id).select("+isSuperAdmin");
  if (!user) throw AppError.notFound("User not found");
  return user;
}

/** Super admin accounts can only be changed from the CLI, never through the API. */
function assertNotSuperAdmin(user) {
  if (user.isSuperAdmin) {
    throw AppError.forbidden(
      "Super admin accounts can only be managed with `npm run superadmin`",
      "SUPER_ADMIN_PROTECTED"
    );
  }
}

async function assertNotLastOwner(tenantId, userId) {
  const otherOwners = await Membership.countDocuments({
    tenantId,
    role: ROLES.OWNER,
    userId: { $ne: userId },
  });
  if (otherOwners === 0) {
    throw AppError.badRequest("A tenant must keep at least one owner", "LAST_OWNER");
  }
}

function serializeMember(membership) {
  return {
    userId: String(membership.userId._id),
    name: membership.userId.name,
    email: membership.userId.email,
    isActive: membership.userId.isActive,
    role: membership.role,
    joinedAt: membership.createdAt,
  };
}

async function getMembers(tenantId) {
  const memberships = await Membership.find({ tenantId })
    .populate("userId", "name email isActive")
    .sort({ createdAt: 1 })
    .lean();
  return memberships.filter((m) => m.userId).map(serializeMember);
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export async function getStats() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [tenants, activeTenants, newTenants, users, activeUsers, newUsers, memberships, activeSessions] =
    await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ isActive: true }),
      Tenant.countDocuments({ createdAt: { $gte: since } }),
      User.countDocuments(),
      User.countDocuments({ isActive: true }),
      User.countDocuments({ createdAt: { $gte: since } }),
      Membership.countDocuments(),
      Session.countDocuments({ revokedAt: null, expiresAt: { $gt: new Date() } }),
    ]);

  return {
    tenants: { total: tenants, active: activeTenants, inactive: tenants - activeTenants, last30Days: newTenants },
    users: { total: users, active: activeUsers, inactive: users - activeUsers, last30Days: newUsers },
    memberships,
    activeSessions,
  };
}

export async function listAuditLogs({ page, limit, action, actorId, targetId }) {
  const filter = {
    ...(action ? { action } : {}),
    ...(actorId ? { actorId } : {}),
    ...(targetId ? { targetId } : {}),
  };
  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("actorId", "name email")
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    logs: logs.map(({ __v, actorId: actor, ...log }) => ({
      ...log,
      actor: actor ? { id: String(actor._id), name: actor.name, email: actor.email } : null,
    })),
    pagination: pageInfo(page, limit, total),
  };
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export async function listTenants({ page, limit, status, search }) {
  const filter = { ...statusFilter(status) };
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: re }, { slug: re }];
  }

  const [tenants, total] = await Promise.all([
    Tenant.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Tenant.countDocuments(filter),
  ]);

  const counts = await Membership.aggregate([
    { $match: { tenantId: { $in: tenants.map((t) => t._id) } } },
    { $group: { _id: "$tenantId", members: { $sum: 1 } } },
  ]);
  const countByTenant = new Map(counts.map((c) => [String(c._id), c.members]));

  return {
    tenants: tenants.map((t) => ({
      ...serializeTenant(t),
      isActive: t.isActive,
      memberCount: countByTenant.get(String(t._id)) || 0,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    pagination: pageInfo(page, limit, total),
  };
}

export async function getTenant(id) {
  const tenant = await findTenantOrThrow(id);
  return {
    tenant: { ...serializeTenant(tenant), isActive: tenant.isActive, createdAt: tenant.createdAt, updatedAt: tenant.updatedAt },
    members: await getMembers(tenant._id),
  };
}

export async function updateTenant(ctx, id, changes) {
  const tenant = await findTenantOrThrow(id);
  const before = { name: tenant.name, isActive: tenant.isActive };

  Object.assign(tenant, changes);
  await tenant.save();

  if (changes.isActive === false && before.isActive) {
    // Log everyone out of a suspended tenant immediately
    await revokeSessions({ tenantId: tenant._id });
  }

  await audit(ctx, {
    action: "tenant.update",
    targetType: "tenant",
    targetId: tenant._id,
    tenantId: tenant._id,
    metadata: { before, after: { name: tenant.name, isActive: tenant.isActive } },
  });

  return getTenant(tenant._id);
}

/**
 * Issues a tenant-scoped access token so the super admin can use the normal
 * tenant routes (acting with the owner role). No refresh token: call again
 * when it expires. Every entry is audited.
 */
export async function enterTenant(ctx, id) {
  const tenant = await findTenantOrThrow(id);

  const accessToken = signAccessToken({
    userId: ctx.adminId,
    tenantId: tenant._id,
    role: ROLES.OWNER,
    impersonation: true,
  });

  await audit(ctx, {
    action: "tenant.enter",
    targetType: "tenant",
    targetId: tenant._id,
    tenantId: tenant._id,
  });

  return {
    tenant: serializeTenant(tenant),
    role: ROLES.OWNER,
    isImpersonating: true,
    accessToken,
    accessTokenExpiresAt: new Date(jwt.decode(accessToken).exp * 1000),
  };
}

export async function listTenantMembers(tenantId) {
  await findTenantOrThrow(tenantId);
  return { members: await getMembers(tenantId) };
}

export async function addMember(ctx, tenantId, { email, role }) {
  const tenant = await findTenantOrThrow(tenantId);
  const user = await User.findOne({ email }).select("+isSuperAdmin");
  if (!user) throw AppError.notFound("No user with that email");
  assertNotSuperAdmin(user);

  if (await Membership.exists({ userId: user._id, tenantId: tenant._id })) {
    throw AppError.conflict("User is already a member of this tenant", "ALREADY_MEMBER");
  }

  await Membership.create({ userId: user._id, tenantId: tenant._id, role });
  await audit(ctx, {
    action: "membership.create",
    targetType: "membership",
    targetId: user._id,
    tenantId: tenant._id,
    metadata: { email: user.email, role },
  });

  return { members: await getMembers(tenant._id) };
}

export async function updateMember(ctx, tenantId, userId, { role }) {
  const membership = await Membership.findOne({ tenantId, userId });
  if (!membership) throw AppError.notFound("Membership not found");

  const before = membership.role;
  if (before === ROLES.OWNER && role !== ROLES.OWNER) {
    await assertNotLastOwner(tenantId, userId);
  }

  membership.role = role;
  await membership.save();
  // Old tokens carry the old role: force a fresh login for this tenant
  await revokeSessions({ userId, tenantId });

  await audit(ctx, {
    action: "membership.update",
    targetType: "membership",
    targetId: membership.userId,
    tenantId: membership.tenantId,
    metadata: { before: { role: before }, after: { role } },
  });

  return { members: await getMembers(tenantId) };
}

export async function removeMember(ctx, tenantId, userId) {
  const membership = await Membership.findOne({ tenantId, userId });
  if (!membership) throw AppError.notFound("Membership not found");

  if (membership.role === ROLES.OWNER) {
    await assertNotLastOwner(tenantId, userId);
  }

  await membership.deleteOne();
  await revokeSessions({ userId, tenantId });

  await audit(ctx, {
    action: "membership.delete",
    targetType: "membership",
    targetId: membership.userId,
    tenantId: membership.tenantId,
    metadata: { role: membership.role },
  });

  return { members: await getMembers(tenantId) };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function listUsers({ page, limit, status, search }) {
  const filter = { ...statusFilter(status) };
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: re }, { email: re }];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("+isSuperAdmin")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  const counts = await Membership.aggregate([
    { $match: { userId: { $in: users.map((u) => u._id) } } },
    { $group: { _id: "$userId", tenants: { $sum: 1 } } },
  ]);
  const countByUser = new Map(counts.map((c) => [String(c._id), c.tenants]));

  return {
    users: users.map((u) => ({
      ...serializeUser(u),
      isSuperAdmin: Boolean(u.isSuperAdmin),
      tenantCount: countByUser.get(String(u._id)) || 0,
    })),
    pagination: pageInfo(page, limit, total),
  };
}

export async function getUser(id) {
  const user = await findUserOrThrow(id);
  const memberships = await Membership.find({ userId: user._id }).populate("tenantId").lean();

  return {
    user: { ...serializeUser(user), isSuperAdmin: Boolean(user.isSuperAdmin) },
    memberships: memberships
      .filter((m) => m.tenantId)
      .map((m) => ({
        tenant: { ...serializeTenant(m.tenantId), isActive: m.tenantId.isActive },
        role: m.role,
        joinedAt: m.createdAt,
      })),
  };
}

export async function updateUser(ctx, id, changes) {
  const user = await findUserOrThrow(id);
  assertNotSuperAdmin(user);

  const before = { name: user.name, isActive: user.isActive };
  Object.assign(user, changes);
  await user.save();

  if (changes.isActive === false && before.isActive) {
    await revokeSessions({ userId: user._id });
  }

  await audit(ctx, {
    action: "user.update",
    targetType: "user",
    targetId: user._id,
    metadata: { before, after: { name: user.name, isActive: user.isActive } },
  });

  return getUser(user._id);
}

export async function resetUserPassword(ctx, id, { password }) {
  const user = await findUserOrThrow(id);
  assertNotSuperAdmin(user);

  user.passwordHash = await hashPassword(password);
  await user.save();
  await revokeSessions({ userId: user._id });

  await audit(ctx, { action: "user.reset_password", targetType: "user", targetId: user._id });
}
