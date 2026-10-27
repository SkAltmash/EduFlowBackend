import Membership, { ROLES } from "../../models/Membership.js";
import SchoolSettings from "../../models/SchoolSettings.js";
import Session from "../../models/Session.js";
import Tenant from "../../models/Tenant.js";
import TeachingAssignment from "../../models/TeachingAssignment.js";
import User from "../../models/User.js";
import AuditLog from "../../models/AuditLog.js";
import AppError from "../../utils/AppError.js";
import { hashPassword } from "../../utils/password.js";

const PROFILE_FIELDS = ["type", "board", "phone", "email", "website", "address", "city", "state", "pincode", "academicYearStart", "receiptNote"];
const PROFILE_DEFAULTS = { type: "school", board: "", phone: "", email: "", website: "", address: "", city: "", state: "", pincode: "", academicYearStart: 4, receiptNote: "" };

/** Owners and admins of a school, and what each may do to whom. */
const MANAGES = {
  // Owners manage everyone, including other owners
  [ROLES.OWNER]: Object.values(ROLES),
  // Admins run day-to-day staff but can't hand out or take away admin/owner rights
  [ROLES.ADMIN]: [ROLES.TEACHER, ROLES.ACCOUNTANT],
};

function audit(actor, ctx, entry) {
  return AuditLog.create({
    actorId: actor.id,
    tenantId: actor.tenantId,
    ip: ctx.ip?.slice(0, 64),
    userAgent: ctx.userAgent?.slice(0, 500),
    ...entry,
  });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getSchool(tenantId) {
  const [tenant, settings] = await Promise.all([Tenant.findById(tenantId).lean(), SchoolSettings.findOne({ tenantId }, { profile: 1 }).lean()]);
  if (!tenant) throw AppError.notFound("School not found");
  return {
    school: {
      id: String(tenant._id),
      name: tenant.name,
      slug: tenant.slug,
      ...PROFILE_DEFAULTS,
      ...Object.fromEntries(PROFILE_FIELDS.filter((k) => settings?.profile?.[k] !== undefined).map((k) => [k, settings.profile[k]])),
      createdAt: tenant.createdAt,
    },
  };
}

export async function updateSchool(actor, changes) {
  const { name, ...profile } = changes;
  if (name !== undefined) await Tenant.updateOne({ _id: actor.tenantId }, { $set: { name } });
  const set = Object.fromEntries(Object.entries(profile).map(([k, v]) => [`profile.${k}`, v]));
  if (Object.keys(set).length) {
    await SchoolSettings.updateOne({ tenantId: actor.tenantId }, { $set: { ...set, updatedBy: actor.id } }, { upsert: true });
  }
  return getSchool(actor.tenantId);
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export async function listMembers(tenantId) {
  const memberships = await Membership.find({ tenantId }).populate("userId", "name email isActive").sort({ createdAt: 1 }).lean();
  return {
    members: memberships
      .filter((m) => m.userId)
      .map((m) => ({
        userId: String(m.userId._id),
        name: m.userId.name,
        email: m.userId.email,
        isActive: m.userId.isActive,
        role: m.role,
        joinedAt: m.createdAt,
      })),
  };
}

function assertCanManage(actor, role) {
  if (!MANAGES[actor.role]?.includes(role)) {
    throw AppError.forbidden("Only an owner can give or change owner and admin access", "ROLE_NOT_ALLOWED");
  }
}

async function assertNotLastOwner(tenantId, userId) {
  const others = await Membership.countDocuments({ tenantId, role: ROLES.OWNER, userId: { $ne: userId } });
  if (others === 0) throw AppError.badRequest("The school must keep at least one owner", "LAST_OWNER");
}

/** Old tokens carry the old role (or access): end this person's sessions for this school. */
function revokeSessions(userId, tenantId) {
  return Session.updateMany({ userId, tenantId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/**
 * Adds a staff member. An existing EduFlow account (same email) is simply given access
 * and keeps its password; otherwise a new account is created with the password given.
 */
export async function addMember(actor, ctx, { email, role, name, password }) {
  assertCanManage(actor, role);

  let user = await User.findOne({ email }).select("+isSuperAdmin");
  let created = false;
  if (user) {
    if (user.isSuperAdmin) throw AppError.forbidden("This account can't be added to a school", "SUPER_ADMIN_PROTECTED");
    if (await Membership.exists({ userId: user._id, tenantId: actor.tenantId })) {
      throw AppError.conflict("This person is already on your team", "ALREADY_MEMBER");
    }
  } else {
    if (!name || !password) {
      throw AppError.badRequest("No account uses this email yet. Enter their name and a temporary password.", "NEW_ACCOUNT_DETAILS_REQUIRED", [
        ...(!name ? [{ field: "name", message: "Name is required for a new account" }] : []),
        ...(!password ? [{ field: "password", message: "Password is required for a new account" }] : []),
      ]);
    }
    user = await User.create({ name, email, passwordHash: await hashPassword(password) });
    created = true;
  }

  await Membership.create({ userId: user._id, tenantId: actor.tenantId, role });
  await audit(actor, ctx, { action: "membership.create", targetType: "membership", targetId: user._id, metadata: { email, role, newAccount: created } });
  return { ...(await listMembers(actor.tenantId)), created };
}

async function findMembership(actor, userId) {
  if (String(userId) === String(actor.id)) {
    throw AppError.badRequest("You can't change your own access. Ask another owner.", "CANNOT_CHANGE_SELF");
  }
  const membership = await Membership.findOne({ tenantId: actor.tenantId, userId });
  if (!membership) throw AppError.notFound("Team member not found");
  return membership;
}

export async function updateMember(actor, ctx, userId, { role }) {
  const membership = await findMembership(actor, userId);
  const before = membership.role;
  if (before === role) return listMembers(actor.tenantId);
  // Both the current and the new role must be within the actor's reach
  assertCanManage(actor, before);
  assertCanManage(actor, role);
  if (before === ROLES.OWNER) await assertNotLastOwner(actor.tenantId, userId);

  membership.role = role;
  await membership.save();
  await revokeSessions(userId, actor.tenantId);
  await audit(actor, ctx, { action: "membership.update", targetType: "membership", targetId: membership.userId, metadata: { before: { role: before }, after: { role } } });
  return listMembers(actor.tenantId);
}

export async function removeMember(actor, ctx, userId) {
  const membership = await findMembership(actor, userId);
  assertCanManage(actor, membership.role);
  if (membership.role === ROLES.OWNER) await assertNotLastOwner(actor.tenantId, userId);

  await membership.deleteOne();
  await TeachingAssignment.deleteMany({ tenantId: actor.tenantId, userId });
  await revokeSessions(userId, actor.tenantId);
  await audit(actor, ctx, { action: "membership.delete", targetType: "membership", targetId: membership.userId, metadata: { role: membership.role } });
  return listMembers(actor.tenantId);
}
