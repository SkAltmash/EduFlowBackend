import Membership, { ROLES } from "../../models/Membership.js";
import SchoolSettings from "../../models/SchoolSettings.js";
import Session from "../../models/Session.js";
import Tenant from "../../models/Tenant.js";
import TeachingAssignment from "../../models/TeachingAssignment.js";
import User from "../../models/User.js";
import AuditLog from "../../models/AuditLog.js";
import AppError from "../../utils/AppError.js";
import { hashPassword } from "../../utils/password.js";
import { cloudinaryConfig, destroyImage, sign } from "../platform/cloudinary.js";

const PROFILE_FIELDS = ["type", "board", "phone", "email", "website", "address", "city", "state", "pincode", "academicYearStart", "receiptNote", "logoUrl"];
const PROFILE_DEFAULTS = { type: "school", board: "", phone: "", email: "", website: "", address: "", city: "", state: "", pincode: "", academicYearStart: 4, receiptNote: "", logoUrl: "" };

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

export const RECEIPT_SHOW = ["logo", "schoolName", "title", "contact", "guardian", "amountInWords", "summary", "concessions", "receivedBy", "signature", "footer"];
export const RECEIPT_DEFAULTS = {
  title: "Fee receipt",
  accent: "indigo",
  prefix: "R",
  signatureLabel: "Authorised signature",
  paper: "a5",
  twoCopies: false,
  show: Object.fromEntries(RECEIPT_SHOW.map((k) => [k, true])),
};

function serializeReceipt(r) {
  return {
    ...RECEIPT_DEFAULTS,
    ...Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => k in RECEIPT_DEFAULTS && k !== "show")),
    show: { ...RECEIPT_DEFAULTS.show, ...Object.fromEntries(Object.entries(r?.show ?? {}).filter(([k]) => RECEIPT_SHOW.includes(k))) },
  };
}

export const REPORT_SHOW = ["logo", "schoolName", "title", "contact", "admissionNo", "rollNo", "gradeColumn", "resultColumn", "percentage", "rank", "resultBox", "remarks", "attendance"];
export const REPORT_DEFAULTS = {
  title: "Report card",
  monthlyTitle: "Monthly progress report",
  accent: "indigo",
  signatures: ["Class teacher", "Principal", "Parent"],
  note: "",
  paper: "a4",
  show: Object.fromEntries(REPORT_SHOW.map((k) => [k, true])),
};

function serializeReportCard(r) {
  return {
    ...REPORT_DEFAULTS,
    ...Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => k in REPORT_DEFAULTS && k !== "show")),
    show: { ...REPORT_DEFAULTS.show, ...Object.fromEntries(Object.entries(r?.show ?? {}).filter(([k]) => REPORT_SHOW.includes(k))) },
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getSchool(tenantId) {
  const [tenant, settings] = await Promise.all([Tenant.findById(tenantId).lean(), SchoolSettings.findOne({ tenantId }, { profile: 1, receipt: 1, reportCard: 1 }).lean()]);
  if (!tenant) throw AppError.notFound("School not found");
  return {
    school: {
      id: String(tenant._id),
      name: tenant.name,
      slug: tenant.slug,
      ...PROFILE_DEFAULTS,
      ...Object.fromEntries(PROFILE_FIELDS.filter((k) => settings?.profile?.[k] !== undefined).map((k) => [k, settings.profile[k]])),
      createdAt: tenant.createdAt,
      // Whether the platform has image uploads set up (Settings shows the logo upload)
      logoUploads: Boolean(await cloudinaryConfig()),
      // How fee receipts look
      receipt: serializeReceipt(settings?.receipt),
      // How report cards look
      reportCard: serializeReportCard(settings?.reportCard),
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

/** Receipt look (and the note under it, kept with the profile). */
export async function updateReceipt(actor, ctx, { receiptNote, ...receipt }) {
  const current = (await SchoolSettings.findOne({ tenantId: actor.tenantId }, { receipt: 1 }).lean())?.receipt;
  const next = serializeReceipt({ ...serializeReceipt(current), ...receipt, show: { ...serializeReceipt(current).show, ...(receipt.show ?? {}) } });
  await SchoolSettings.updateOne(
    { tenantId: actor.tenantId },
    { $set: { receipt: next, ...(receiptNote !== undefined ? { "profile.receiptNote": receiptNote } : {}), updatedBy: actor.id } },
    { upsert: true }
  );
  await audit(actor, ctx, { action: "school.receipt_update", targetType: "tenant", targetId: actor.tenantId, metadata: { ...receipt, ...(receiptNote !== undefined ? { receiptNote } : {}) } });
  return getSchool(actor.tenantId);
}

/** Report card and progress report look. */
export async function updateReportCard(actor, ctx, changes) {
  const current = serializeReportCard((await SchoolSettings.findOne({ tenantId: actor.tenantId }, { reportCard: 1 }).lean())?.reportCard);
  const next = serializeReportCard({ ...current, ...changes, show: { ...current.show, ...(changes.show ?? {}) } });
  await SchoolSettings.updateOne({ tenantId: actor.tenantId }, { $set: { reportCard: next, updatedBy: actor.id } }, { upsert: true });
  await audit(actor, ctx, { action: "school.report_card_update", targetType: "tenant", targetId: actor.tenantId, metadata: changes });
  return getSchool(actor.tenantId);
}

/** The prefix for new receipt numbers ("R" unless the school chose its own). */
export async function receiptPrefix(tenantId, session) {
  const s = await SchoolSettings.findOne({ tenantId }, { "receipt.prefix": 1 }).session(session ?? null).lean();
  return s?.receipt?.prefix || "R";
}

// ---------------------------------------------------------------------------
// Logo (uploaded by the browser straight to Cloudinary)
// ---------------------------------------------------------------------------

const logoPublicId = (folder, tenantId) => `${folder}/schools/${tenantId}/logo`;

/** A one-off signed upload for this school's logo slot (same public id, so a new logo replaces the old one). */
export async function logoUploadSignature(tenantId) {
  const cfg = await cloudinaryConfig();
  if (!cfg) throw AppError.badRequest("Logo upload isn't set up on EduFlow yet. Contact support.", "UPLOADS_NOT_CONFIGURED");
  const params = {
    allowed_formats: "png,jpg,jpeg,webp",
    invalidate: "true",
    overwrite: "true",
    public_id: logoPublicId(cfg.folder, tenantId),
    timestamp: Math.floor(Date.now() / 1000),
    // Stored at most 600 px: plenty for receipts and report cards
    transformation: "c_limit,w_600,h_600",
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`,
    fields: { ...params, api_key: cfg.apiKey, signature: sign(params, cfg.apiSecret) },
  };
}

/** Saves the uploaded logo, after checking it is this school's image on our Cloudinary account. */
export async function saveLogo(actor, ctx, { url }) {
  const cfg = await cloudinaryConfig();
  if (!cfg) throw AppError.badRequest("Logo upload isn't set up on EduFlow yet. Contact support.", "UPLOADS_NOT_CONFIGURED");
  const publicId = logoPublicId(cfg.folder, actor.tenantId);
  const expected = new RegExp(`^https://res\\.cloudinary\\.com/${cfg.cloudName}/image/upload/(v\\d+/)?${publicId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(png|jpe?g|webp)$`);
  if (!expected.test(url)) throw AppError.badRequest("That isn't this school's uploaded logo", "INVALID_LOGO_URL");
  await SchoolSettings.updateOne({ tenantId: actor.tenantId }, { $set: { "profile.logoUrl": url, "profile.logoPublicId": publicId, updatedBy: actor.id } }, { upsert: true });
  await audit(actor, ctx, { action: "school.logo_update", targetType: "tenant", targetId: actor.tenantId });
  return getSchool(actor.tenantId);
}

export async function removeLogo(actor, ctx) {
  const s = await SchoolSettings.findOne({ tenantId: actor.tenantId }, { "profile.logoPublicId": 1 }).lean();
  await SchoolSettings.updateOne({ tenantId: actor.tenantId }, { $set: { "profile.logoUrl": "", "profile.logoPublicId": "", updatedBy: actor.id } });
  await destroyImage(s?.profile?.logoPublicId);
  await audit(actor, ctx, { action: "school.logo_remove", targetType: "tenant", targetId: actor.tenantId });
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
