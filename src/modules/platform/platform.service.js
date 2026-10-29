// Super admin console: growth, schools (subscription, usage, notes), plans, announcements,
// search, system health, data export/delete and two-step login.
import mongoose from "mongoose";
import Announcement from "../../models/Announcement.js";
import Attendance from "../../models/Attendance.js";
import AuditLog from "../../models/AuditLog.js";
import Exam from "../../models/Exam.js";
import Membership from "../../models/Membership.js";
import Payment from "../../models/Payment.js";
import PlatformPlan, { PLAN_FEATURES } from "../../models/PlatformPlan.js";
import PlatformSettings from "../../models/PlatformSettings.js";
import SchoolSettings from "../../models/SchoolSettings.js";
import Session from "../../models/Session.js";
import Student from "../../models/Student.js";
import SubscriptionPayment from "../../models/SubscriptionPayment.js";
import Tenant from "../../models/Tenant.js";
import TenantActivity from "../../models/TenantActivity.js";
import User from "../../models/User.js";
import WhatsAppMessage from "../../models/WhatsAppMessage.js";
import AppError from "../../utils/AppError.js";
import { canEncrypt, decrypt, encrypt } from "../../utils/crypto.js";
import { errorStats } from "../../middleware/errorHandler.js";
import { TRIAL_DAYS, computeAccess, ensureDefaultPlans, invalidateAccess } from "./subscription.js";
import { newSecret, otpauthUrl, verifyCode } from "./totp.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { verifyRefreshToken } from "../../utils/jwt.js";
import { checkUploadPermission, forgetCloudinaryConfig, pingCloudinary } from "./cloudinary.js";

const DAY_MS = 86_400_000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const escapeRegex = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const asObject = (m) => (m instanceof Map ? Object.fromEntries(m) : (m ?? {}));
/** A school's subscription as a plain object (it's a nested path, not a sub-document). */
const subOf = (t) => ({ ...(t.toObject().subscription ?? {}) });

function audit(ctx, entry) {
  return AuditLog.create({ actorId: ctx.adminId, ip: ctx.ip?.slice(0, 64), userAgent: ctx.userAgent?.slice(0, 500), ...entry });
}

async function plansById() {
  await ensureDefaultPlans();
  const plans = await PlatformPlan.find().lean();
  return new Map(plans.map((p) => [String(p._id), p]));
}

const planOf = (t, plans) => (t.subscription?.planId ? plans.get(String(t.subscription.planId)) : null);

/** Monthly revenue a school brings in right now (0 unless paying). */
function monthlyValue(t, plan, access) {
  if (!plan || !["active", "overdue"].includes(access.status)) return 0;
  return access.cycle === "yearly" ? Math.round((plan.priceYearly || plan.priceMonthly * 12) / 12) : plan.priceMonthly;
}

/** active (used in the last 7 days), quiet (not for 7+ days), never (signed up 3+ days ago, never used), new */
function healthOf(t) {
  const now = Date.now();
  if (!t.lastActiveAt) return now - new Date(t.createdAt).getTime() > 3 * DAY_MS ? "never" : "new";
  return now - new Date(t.lastActiveAt).getTime() > 7 * DAY_MS ? "quiet" : "active";
}

function serializeSchool(t, plan, extra = {}) {
  const access = computeAccess(t, plan);
  return {
    id: String(t._id),
    name: t.name,
    slug: t.slug,
    isActive: t.isActive,
    createdAt: t.createdAt,
    lastActiveAt: t.lastActiveAt ?? null,
    health: healthOf(t),
    subscription: access,
    mrr: monthlyValue(t, plan, access),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function dashboard() {
  const now = Date.now();
  const [tenants, plans] = await Promise.all([Tenant.find({}, { name: 1, slug: 1, isActive: 1, createdAt: 1, lastActiveAt: 1, subscription: 1, studentLimitOverride: 1, featureOverrides: 1 }).lean(), plansById()]);
  const schools = tenants.map((t) => serializeSchool(t, planOf(t, plans)));

  const byStatus = {};
  for (const s of schools) byStatus[s.subscription.status] = (byStatus[s.subscription.status] ?? 0) + 1;
  const mrr = schools.reduce((t, s) => t + s.mrr, 0);

  // Signups per week, last 12 weeks (weeks start on Monday)
  const monday = (d) => {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return isoDay(x);
  };
  const weeks = Array.from({ length: 12 }, (_, i) => monday(now - (11 - i) * 7 * DAY_MS));
  const signups = weeks.map((w) => ({ week: w, count: tenants.filter((t) => monday(t.createdAt) === w).length }));

  // Revenue per month, last 12 months
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - (11 - i));
    return d.toISOString().slice(0, 7);
  });
  const payAgg = await SubscriptionPayment.aggregate([
    { $match: { createdAt: { $gte: new Date(`${months[0]}-01T00:00:00Z`) } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  const revenue = months.map((m) => ({ month: m, amount: payAgg.find((p) => p._id === m)?.amount ?? 0 }));
  const [lifetime] = await SubscriptionPayment.aggregate([{ $group: { _id: null, amount: { $sum: "$amount" } } }]);

  // Trial → paid: schools old enough to have finished a trial that ever paid
  const paidIds = new Set((await SubscriptionPayment.distinct("tenantId")).map(String));
  const matured = tenants.filter((t) => now - new Date(t.createdAt).getTime() > TRIAL_DAYS * DAY_MS);
  const conversion = matured.length ? Math.round((matured.filter((t) => paidIds.has(String(t._id))).length / matured.length) * 1000) / 10 : null;

  // Active schools this week vs the week before
  const activeIn = async (from, to) => (await TenantActivity.distinct("tenantId", { day: { $gte: isoDay(from), $lt: isoDay(to) } })).length;
  const [activeThisWeek, activeLastWeek] = await Promise.all([activeIn(now - 7 * DAY_MS, now + DAY_MS), activeIn(now - 14 * DAY_MS, now - 7 * DAY_MS)]);

  // Setup funnel: how far schools get
  const [withStudents, withAttendance, withTests, withFees] = await Promise.all([
    Student.distinct("tenantId"),
    Attendance.distinct("tenantId"),
    Exam.distinct("tenantId"),
    Payment.distinct("tenantId"),
  ]);
  const funnel = [
    { step: "Signed up", count: tenants.length },
    { step: "Added students", count: withStudents.length },
    { step: "Marked attendance", count: withAttendance.length },
    { step: "Created a test", count: withTests.length },
    { step: "Collected fees", count: withFees.length },
  ];

  const top = await Student.aggregate([{ $match: { status: "active" } }, { $group: { _id: "$tenantId", students: { $sum: 1 } } }, { $sort: { students: -1 } }, { $limit: 5 }]);
  const nameOf = new Map(tenants.map((t) => [String(t._id), t.name]));

  const list = (pred, sort) => schools.filter(pred).sort(sort).slice(0, 10);
  return {
    totals: {
      schools: tenants.length,
      byStatus,
      mrr,
      arr: mrr * 12,
      lifetimeRevenue: lifetime?.amount ?? 0,
      conversion,
      activeThisWeek,
      activeLastWeek,
      newThisMonth: tenants.filter((t) => new Date(t.createdAt).toISOString().slice(0, 7) === new Date(now).toISOString().slice(0, 7)).length,
    },
    signups,
    revenue,
    funnel,
    topSchools: top.map((t) => ({ id: String(t._id), name: nameOf.get(String(t._id)) ?? "(deleted)", students: t.students })),
    lists: {
      trialsEnding: list((s) => s.subscription.status === "trial" && (s.subscription.daysLeft ?? 99) <= 3, (a, b) => a.subscription.daysLeft - b.subscription.daysLeft),
      renewalsDue: list((s) => ["active", "overdue"].includes(s.subscription.status) && (s.subscription.daysLeft ?? 99) <= 30, (a, b) => a.subscription.daysLeft - b.subscription.daysLeft),
      expired: list((s) => s.subscription.status === "expired", (a, b) => new Date(b.subscription.endsAt) - new Date(a.subscription.endsAt)),
      quiet: list((s) => s.health === "quiet" || s.health === "never", (a, b) => new Date(a.lastActiveAt ?? a.createdAt) - new Date(b.lastActiveAt ?? b.createdAt)),
    },
  };
}

// ---------------------------------------------------------------------------
// Schools
// ---------------------------------------------------------------------------

export async function listSchools({ page, limit, search, status, health }) {
  const filter = {};
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: re }, { slug: re }];
  }
  const [tenants, plans] = await Promise.all([Tenant.find(filter, { notes: 0 }).sort({ createdAt: -1 }).lean(), plansById()]);
  let rows = tenants.map((t) => serializeSchool(t, planOf(t, plans)));
  if (status && status !== "all") rows = rows.filter((r) => (status === "paying" ? ["active", "overdue"].includes(r.subscription.status) : r.subscription.status === status));
  if (health && health !== "all") rows = rows.filter((r) => r.health === health);

  const total = rows.length;
  rows = rows.slice((page - 1) * limit, page * limit);
  const ids = rows.map((r) => oid(r.id));
  const [students, members] = await Promise.all([
    Student.aggregate([{ $match: { tenantId: { $in: ids }, status: "active" } }, { $group: { _id: "$tenantId", n: { $sum: 1 } } }]),
    Membership.aggregate([{ $match: { tenantId: { $in: ids } } }, { $group: { _id: "$tenantId", n: { $sum: 1 } } }]),
  ]);
  const sMap = new Map(students.map((x) => [String(x._id), x.n]));
  const mMap = new Map(members.map((x) => [String(x._id), x.n]));
  return {
    schools: rows.map((r) => ({ ...r, students: sMap.get(r.id) ?? 0, members: mMap.get(r.id) ?? 0 })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function findTenant(id) {
  const t = await Tenant.findById(id);
  if (!t) throw AppError.notFound("School not found");
  return t;
}

export async function schoolDetail(id) {
  const t = await Tenant.findById(id).lean();
  if (!t) throw AppError.notFound("School not found");
  const plans = await plansById();
  const plan = planOf(t, plans);
  const tid = t._id;
  const since7 = isoDay(Date.now() - 7 * DAY_MS);
  const monthStart = `${isoDay(Date.now()).slice(0, 7)}-01`;

  const [settings, memberships, studentsActive, studentsTotal, attendance7, fees, whatsapp30, tests, activeDays, payments, auditLog] = await Promise.all([
    SchoolSettings.findOne({ tenantId: tid }, { profile: 1 }).lean(),
    Membership.find({ tenantId: tid }).populate("userId", "name email isActive").lean(),
    Student.countDocuments({ tenantId: tid, status: "active" }),
    Student.countDocuments({ tenantId: tid }),
    Attendance.countDocuments({ tenantId: tid, date: { $gte: since7 } }),
    Payment.aggregate([{ $match: { tenantId: tid, date: { $gte: monthStart }, "voided.at": { $exists: false }, kind: { $ne: "opening" } } }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
    WhatsAppMessage.countDocuments({ tenantId: tid, createdAt: { $gte: new Date(Date.now() - 30 * DAY_MS) } }),
    Exam.countDocuments({ tenantId: tid }),
    TenantActivity.countDocuments({ tenantId: tid, day: { $gte: isoDay(Date.now() - 30 * DAY_MS) } }),
    SubscriptionPayment.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(50).lean(),
    AuditLog.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(20).populate("actorId", "name email").lean(),
  ]);

  return {
    school: serializeSchool(t, plan, {
      profile: settings?.profile ?? {},
      studentLimitOverride: t.studentLimitOverride ?? null,
      featureOverrides: asObject(t.featureOverrides),
    }),
    members: memberships
      .filter((m) => m.userId)
      .map((m) => ({ userId: String(m.userId._id), name: m.userId.name, email: m.userId.email, isActive: m.userId.isActive, role: m.role, joinedAt: m.createdAt })),
    usage: {
      studentsActive,
      studentsTotal,
      staff: memberships.length,
      attendanceLast7Days: attendance7,
      feesThisMonth: fees[0]?.amount ?? 0,
      receiptsThisMonth: fees[0]?.count ?? 0,
      whatsappLast30Days: whatsapp30,
      tests,
      activeDaysLast30: activeDays,
    },
    payments: payments.map((p) => ({ id: String(p._id), planName: p.planName ?? "", amount: p.amount, method: p.method, reference: p.reference, cycle: p.cycle, periods: p.periods, periodStart: p.periodStart, periodEnd: p.periodEnd, note: p.note, recordedByName: p.recordedByName ?? "", createdAt: p.createdAt })),
    notes: (t.notes ?? []).map((n) => ({ id: String(n._id), text: n.text, byName: n.byName ?? "", at: n.at })).reverse(),
    audit: auditLog.map((a) => ({ id: String(a._id), action: a.action, actor: a.actorId ? { name: a.actorId.name, email: a.actorId.email } : null, metadata: a.metadata ?? null, createdAt: a.createdAt })),
  };
}

async function adminName(ctx) {
  return (await User.findById(ctx.adminId, { name: 1 }).lean())?.name ?? "";
}

export async function updateSubscription(ctx, id, changes) {
  const t = await findTenant(id);
  if (changes.planId && !(await PlatformPlan.exists({ _id: changes.planId }))) throw AppError.badRequest("Plan not found", "INVALID_PLAN");
  const before = subOf(t);
  t.subscription = { ...before, ...changes, updatedAt: new Date() };
  if (!t.subscription.status) t.subscription.status = "trial";
  await t.save();
  invalidateAccess(id);
  await audit(ctx, { action: "subscription.update", targetType: "tenant", targetId: t._id, tenantId: t._id, metadata: { before, after: changes } });
  return schoolDetail(id);
}

export async function extendTrial(ctx, id, { days }) {
  const t = await findTenant(id);
  const from = Math.max(Date.now(), t.subscription?.status === "trial" && t.subscription.trialEndsAt ? new Date(t.subscription.trialEndsAt).getTime() : 0);
  if (!t.subscription?.planId) {
    await ensureDefaultPlans();
    const def = await PlatformPlan.findOne({ isDefault: true }).lean();
    t.subscription = { ...subOf(t), planId: def?._id };
  }
  t.subscription.status = "trial";
  t.subscription.trialEndsAt = new Date(from + days * DAY_MS);
  t.subscription.updatedAt = new Date();
  await t.save();
  invalidateAccess(id);
  await audit(ctx, { action: "subscription.extend_trial", targetType: "tenant", targetId: t._id, tenantId: t._id, metadata: { days, until: t.subscription.trialEndsAt } });
  return schoolDetail(id);
}

const addMonths = (date, n) => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
};

/** Records a payment received outside the app and extends the paid period. */
export async function recordPayment(ctx, id, { planId, amount, method, reference, cycle, periods, note }) {
  const t = await findTenant(id);
  const plan = await PlatformPlan.findById(planId ?? t.subscription?.planId).lean();
  if (!plan) throw AppError.badRequest("Choose a plan", "INVALID_PLAN");
  // A renewal continues from the end of the current paid period; otherwise from today
  const currentEnd = t.subscription?.status === "active" && t.subscription.currentPeriodEnd ? new Date(t.subscription.currentPeriodEnd).getTime() : 0;
  const periodStart = new Date(Math.max(Date.now(), currentEnd));
  const periodEnd = addMonths(periodStart, (cycle === "yearly" ? 12 : 1) * periods);
  const name = await adminName(ctx);
  await SubscriptionPayment.create({ tenantId: t._id, planId: plan._id, planName: plan.name, amount, method, reference, cycle, periods, periodStart, periodEnd, note, recordedBy: ctx.adminId, recordedByName: name });
  t.subscription = { status: "active", planId: plan._id, cycle, trialEndsAt: t.subscription?.trialEndsAt, currentPeriodEnd: periodEnd, updatedAt: new Date() };
  await t.save();
  invalidateAccess(id);
  await audit(ctx, { action: "subscription.payment", targetType: "tenant", targetId: t._id, tenantId: t._id, metadata: { amount, plan: plan.name, cycle, periods, until: periodEnd } });
  return schoolDetail(id);
}

export async function deletePayment(ctx, id, paymentId) {
  const p = await SubscriptionPayment.findOneAndDelete({ _id: paymentId, tenantId: id });
  if (!p) throw AppError.notFound("Payment not found");
  await audit(ctx, { action: "subscription.payment_delete", targetType: "tenant", targetId: oid(id), tenantId: oid(id), metadata: { amount: p.amount, recordedAt: p.createdAt } });
  return schoolDetail(id);
}

export async function updateLimits(ctx, id, { studentLimit, features }) {
  const t = await findTenant(id);
  if (studentLimit !== undefined) t.studentLimitOverride = studentLimit === null ? undefined : studentLimit;
  if (features) {
    const current = asObject(t.featureOverrides);
    for (const [k, v] of Object.entries(features)) {
      if (!PLAN_FEATURES.includes(k)) continue;
      if (v === null) delete current[k];
      else current[k] = v;
    }
    t.featureOverrides = Object.keys(current).length ? current : undefined;
  }
  await t.save();
  invalidateAccess(id);
  await audit(ctx, { action: "tenant.limits", targetType: "tenant", targetId: t._id, tenantId: t._id, metadata: { studentLimit, features } });
  return schoolDetail(id);
}

export async function addNote(ctx, id, { text }) {
  const t = await findTenant(id);
  t.notes.push({ text, by: ctx.adminId, byName: await adminName(ctx) });
  await t.save();
  return schoolDetail(id);
}

export async function deleteNote(id, noteId) {
  await Tenant.updateOne({ _id: id }, { $pull: { notes: { _id: noteId } } });
  return schoolDetail(id);
}

export async function logoutAll(ctx, id) {
  const t = await findTenant(id);
  const { modifiedCount } = await Session.updateMany({ tenantId: t._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit(ctx, { action: "tenant.logout_all", targetType: "tenant", targetId: t._id, tenantId: t._id, metadata: { sessions: modifiedCount } });
  return { sessionsEnded: modifiedCount };
}

/** Every model holding one school's data (by its tenantId field). */
function tenantModels() {
  return Object.values(mongoose.models).filter((m) => m.schema.path("tenantId") && !["AuditLog", "Session"].includes(m.modelName));
}

/** Everything one school has, as JSON (for a data request or before deleting). */
export async function exportSchool(ctx, id) {
  const t = await Tenant.findById(id).lean();
  if (!t) throw AppError.notFound("School not found");
  const data = { exportedAt: new Date().toISOString(), school: t };
  for (const m of tenantModels()) {
    if (m.modelName === "Membership") continue;
    data[m.collection.collectionName] = await m.find({ tenantId: t._id }).lean();
  }
  const memberships = await Membership.find({ tenantId: t._id }).populate("userId", "name email isActive createdAt").lean();
  data.members = memberships.map((m) => ({ role: m.role, joinedAt: m.createdAt, user: m.userId }));
  await audit(ctx, { action: "tenant.export", targetType: "tenant", targetId: t._id, tenantId: t._id });
  return data;
}

/** Permanently removes a school and all its data. Accounts left without any school go too. */
export async function deleteSchool(ctx, id, { confirm }) {
  const t = await findTenant(id);
  if (confirm !== t.slug) throw AppError.badRequest(`Type the school's ID (${t.slug}) to confirm`, "CONFIRM_MISMATCH");
  const memberIds = (await Membership.find({ tenantId: t._id }, { userId: 1 }).lean()).map((m) => m.userId);
  const removed = {};
  await mongoose.connection.transaction(async (session) => {
    for (const m of tenantModels()) {
      const r = await m.deleteMany({ tenantId: t._id }, { session });
      if (r.deletedCount) removed[m.collection.collectionName] = r.deletedCount;
    }
    await Session.deleteMany({ tenantId: t._id }, { session });
    // Accounts that belonged only to this school (never super admins)
    const stillMember = new Set((await Membership.distinct("userId", { userId: { $in: memberIds } }).session(session)).map(String));
    const orphanIds = memberIds.filter((u) => !stillMember.has(String(u)));
    if (orphanIds.length) removed.users = (await User.deleteMany({ _id: { $in: orphanIds }, isSuperAdmin: { $ne: true } }, { session })).deletedCount;
    await Tenant.deleteOne({ _id: t._id }, { session });
  });
  invalidateAccess(id);
  await audit(ctx, { action: "tenant.delete", targetType: "tenant", targetId: t._id, metadata: { name: t.name, slug: t.slug, removed } });
  return { deleted: true, removed };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function serializePlan(p, schools = 0) {
  return { id: String(p._id), name: p.name, description: p.description ?? "", priceMonthly: p.priceMonthly, priceYearly: p.priceYearly, studentLimit: p.studentLimit, features: { ...Object.fromEntries(PLAN_FEATURES.map((f) => [f, true])), ...asObject(p.features) }, isDefault: p.isDefault, archived: p.archived, order: p.order, schools };
}

export async function listPlans() {
  await ensureDefaultPlans();
  const [plans, counts] = await Promise.all([PlatformPlan.find().sort({ archived: 1, order: 1, createdAt: 1 }).lean(), Tenant.aggregate([{ $group: { _id: "$subscription.planId", n: { $sum: 1 } } }])]);
  const byPlan = new Map(counts.map((c) => [String(c._id), c.n]));
  return { plans: plans.map((p) => serializePlan(p, byPlan.get(String(p._id)) ?? 0)), features: PLAN_FEATURES };
}

export async function savePlan(ctx, id, data) {
  if (data.isDefault) await PlatformPlan.updateMany({ _id: { $ne: id ?? null } }, { $set: { isDefault: false } });
  const plan = id ? await PlatformPlan.findByIdAndUpdate(id, { $set: data }, { returnDocument: "after" }) : await PlatformPlan.create(data);
  if (!plan) throw AppError.notFound("Plan not found");
  invalidateAccess();
  await audit(ctx, { action: id ? "plan.update" : "plan.create", targetType: "platform", targetId: plan._id, metadata: data });
  return listPlans();
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const serializeAnnouncement = (a) => ({ id: String(a._id), title: a.title, body: a.body, tone: a.tone, linkUrl: a.linkUrl, linkLabel: a.linkLabel, startsAt: a.startsAt, endsAt: a.endsAt ?? null, active: a.active, createdAt: a.createdAt });

export async function listAnnouncements() {
  return { announcements: (await Announcement.find().sort({ createdAt: -1 }).limit(50).lean()).map(serializeAnnouncement) };
}

export async function saveAnnouncement(ctx, id, data) {
  const a = id ? await Announcement.findByIdAndUpdate(id, { $set: data }, { returnDocument: "after" }) : await Announcement.create({ ...data, createdBy: ctx.adminId });
  if (!a) throw AppError.notFound("Announcement not found");
  await audit(ctx, { action: id ? "announcement.update" : "announcement.create", targetType: "platform", targetId: a._id, metadata: { title: a.title } });
  return listAnnouncements();
}

export async function deleteAnnouncement(ctx, id) {
  await Announcement.deleteOne({ _id: id });
  return listAnnouncements();
}

/** What schools see right now. */
export async function activeAnnouncements() {
  const now = new Date();
  const list = await Announcement.find({ active: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gt: now } }] }).sort({ startsAt: -1 }).limit(3).lean();
  return list.map(serializeAnnouncement);
}

// ---------------------------------------------------------------------------
// Search, system, two-step login
// ---------------------------------------------------------------------------

export async function search(q) {
  const re = new RegExp(escapeRegex(q.trim()), "i");
  const [tenants, users, profiles] = await Promise.all([
    Tenant.find({ $or: [{ name: re }, { slug: re }] }, { name: 1, slug: 1 }).limit(8).lean(),
    User.find({ $or: [{ name: re }, { email: re }] }, { name: 1, email: 1 }).limit(8).lean(),
    SchoolSettings.find({ $or: [{ "profile.phone": re }, { "profile.email": re }, { "profile.city": re }] }, { tenantId: 1, profile: 1 }).limit(8).lean(),
  ]);
  const extra = profiles.length ? await Tenant.find({ _id: { $in: profiles.map((p) => p.tenantId) } }, { name: 1, slug: 1 }).lean() : [];
  const schools = [...new Map([...tenants, ...extra].map((t) => [String(t._id), t])).values()].map((t) => ({ id: String(t._id), name: t.name, slug: t.slug }));
  const memberships = await Membership.find({ userId: { $in: users.map((u) => u._id) } }).populate("tenantId", "name").lean();
  return {
    schools,
    users: users.map((u) => ({ id: String(u._id), name: u.name, email: u.email, schools: memberships.filter((m) => String(m.userId) === String(u._id) && m.tenantId).map((m) => ({ id: String(m.tenantId._id), name: m.tenantId.name, role: m.role })) })),
  };
}

export async function system() {
  const t0 = Date.now();
  let dbOk = true;
  try {
    await mongoose.connection.db.admin().ping();
  } catch {
    dbOk = false;
  }
  const dbMs = Date.now() - t0;
  const [failed24h, sent24h, sessions, plansCount] = await Promise.all([
    WhatsAppMessage.countDocuments({ status: "failed", createdAt: { $gte: new Date(Date.now() - DAY_MS) } }),
    WhatsAppMessage.countDocuments({ createdAt: { $gte: new Date(Date.now() - DAY_MS) } }),
    Session.countDocuments({ revokedAt: null, expiresAt: { $gt: new Date() } }),
    PlatformPlan.countDocuments(),
  ]);
  const mem = process.memoryUsage();
  return {
    api: { ok: true, uptimeSeconds: Math.round(process.uptime()), node: process.version, version: process.env.npm_package_version ?? "1.0.0", commit: (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || null, memoryMb: Math.round(mem.rss / 1048576) },
    database: { ok: dbOk, pingMs: dbMs, name: mongoose.connection.name, host: mongoose.connection.host },
    errors: errorStats,
    whatsapp: { sentLast24h: sent24h, failedLast24h: failed24h },
    sessions,
    plans: plansCount,
    encryption: canEncrypt(),
  };
}

export async function twoFactorStatus(ctx) {
  const u = await User.findById(ctx.adminId, { twoFactor: 1, email: 1 }).lean();
  return { enabled: Boolean(u?.twoFactor?.enabled), encryptionAvailable: canEncrypt() };
}

export async function twoFactorSetup(ctx) {
  if (!canEncrypt()) throw AppError.badRequest("Set DATA_ENCRYPTION_KEY on the server first: the secret must be stored encrypted.", "ENCRYPTION_UNAVAILABLE");
  // Load the current secret too, so starting a new setup doesn't wipe a working one
  const u = await User.findById(ctx.adminId).select("+twoFactor.secretEnc");
  const secret = newSecret();
  u.twoFactor = { enabled: Boolean(u.twoFactor?.enabled), secretEnc: u.twoFactor?.secretEnc, pendingEnc: encrypt(secret) };
  await u.save();
  return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
}

export async function twoFactorEnable(ctx, { code }) {
  const u = await User.findById(ctx.adminId).select("+twoFactor.pendingEnc +twoFactor.secretEnc");
  const secret = decrypt(u?.twoFactor?.pendingEnc);
  if (!secret) throw AppError.badRequest("Start the setup again", "NO_PENDING_SETUP");
  if (!verifyCode(secret, code)) throw AppError.badRequest("That code isn't right. Check the time on your phone and try again.", "TWO_FACTOR_INVALID");
  u.twoFactor = { enabled: true, secretEnc: u.twoFactor.pendingEnc, pendingEnc: undefined };
  await u.save();
  await audit(ctx, { action: "admin.2fa_enable", targetType: "user", targetId: u._id });
  return { enabled: true };
}

export async function twoFactorDisable(ctx, { code }) {
  const u = await User.findById(ctx.adminId).select("+twoFactor.secretEnc");
  const secret = decrypt(u?.twoFactor?.secretEnc);
  if (!u?.twoFactor?.enabled || !secret) return { enabled: false };
  if (!verifyCode(secret, code)) throw AppError.badRequest("That code isn't right", "TWO_FACTOR_INVALID");
  u.twoFactor = { enabled: false };
  await u.save();
  await audit(ctx, { action: "admin.2fa_disable", targetType: "user", targetId: u._id });
  return { enabled: false };
}

// ---------------------------------------------------------------------------
// Platform settings (support contact shown to schools)
// ---------------------------------------------------------------------------

let settingsCache = null;
let settingsAt = 0;

// What schools may see (support contact only)
const serializeSettings = (s) => ({ supportWhatsapp: s?.supportWhatsapp ?? "", supportEmail: s?.supportEmail ?? "", updatedAt: s?.updatedAt ?? null });

/** Support contact, cached; safe to show to schools. */
export async function getSettings() {
  if (settingsCache && Date.now() - settingsAt < 60_000) return settingsCache;
  settingsCache = serializeSettings(await PlatformSettings.findOne({ key: "platform" }).lean());
  settingsAt = Date.now();
  return settingsCache;
}

/** Everything for the console; the Cloudinary secret is never sent back, only whether it's set. */
export async function getAdminSettings() {
  const s = await PlatformSettings.findOne({ key: "platform" }).lean();
  const c = s?.cloudinary ?? {};
  return {
    ...serializeSettings(s),
    cloudinary: { cloudName: c.cloudName ?? "", apiKey: c.apiKey ?? "", folder: c.folder || "eduflow", secretSet: Boolean(c.apiSecretEnc), secretReadable: Boolean(decrypt(c.apiSecretEnc)) },
    encryptionAvailable: canEncrypt(),
  };
}

export async function saveSettings(ctx, { cloudinary, ...data }) {
  const set = { ...data, updatedBy: ctx.adminId };
  if (cloudinary) {
    const current = (await PlatformSettings.findOne({ key: "platform" }, { cloudinary: 1 }).lean())?.cloudinary ?? {};
    // An empty secret keeps the saved one
    const secret = cloudinary.apiSecret || decrypt(current.apiSecretEnc);
    const clearing = !cloudinary.cloudName && !cloudinary.apiKey && !cloudinary.apiSecret;
    if (!clearing) {
      if (!cloudinary.cloudName || !cloudinary.apiKey || !secret) throw AppError.badRequest("Enter the cloud name, API key and API secret", "CLOUDINARY_INCOMPLETE");
      if (!canEncrypt()) throw AppError.badRequest("Set DATA_ENCRYPTION_KEY on the server first; the API secret is stored encrypted.", "ENCRYPTION_UNAVAILABLE");
      const keys = { cloudName: cloudinary.cloudName, apiKey: cloudinary.apiKey, apiSecret: secret, folder: cloudinary.folder };
      await pingCloudinary(keys);
      await checkUploadPermission(keys);
    }
    set.cloudinary = clearing
      ? { cloudName: "", apiKey: "", apiSecretEnc: "", folder: cloudinary.folder || "eduflow" }
      : { cloudName: cloudinary.cloudName, apiKey: cloudinary.apiKey, apiSecretEnc: cloudinary.apiSecret ? encrypt(cloudinary.apiSecret) : current.apiSecretEnc, folder: cloudinary.folder || "eduflow" };
  }
  await PlatformSettings.updateOne({ key: "platform" }, { $set: set }, { upsert: true });
  settingsCache = null;
  forgetCloudinaryConfig();
  // Never log the secret
  const logged = { ...data, ...(cloudinary ? { cloudinary: { cloudName: cloudinary.cloudName, apiKey: cloudinary.apiKey, folder: cloudinary.folder, secretChanged: Boolean(cloudinary.apiSecret) } } : {}) };
  await audit(ctx, { action: "platform.settings_update", targetType: "platform", metadata: logged });
  return getAdminSettings();
}

/** Checks the saved Cloudinary keys still work. */
export async function testCloudinary() {
  const c = (await PlatformSettings.findOne({ key: "platform" }, { cloudinary: 1 }).lean())?.cloudinary;
  const apiSecret = decrypt(c?.apiSecretEnc);
  if (!c?.cloudName || !c.apiKey || !apiSecret) throw AppError.badRequest("Cloudinary isn't set up yet", "CLOUDINARY_NOT_SET");
  const keys = { cloudName: c.cloudName, apiKey: c.apiKey, apiSecret, folder: c.folder };
  await pingCloudinary(keys);
  await checkUploadPermission(keys);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Super admins
// ---------------------------------------------------------------------------

export async function listSuperAdmins(ctx) {
  const admins = await User.find({ isSuperAdmin: true }).select("+isSuperAdmin").sort({ createdAt: 1 }).lean();
  return {
    admins: admins.map((u) => ({ id: String(u._id), name: u.name, email: u.email, isActive: u.isActive, twoFactor: Boolean(u.twoFactor?.enabled), createdAt: u.createdAt, isYou: String(u._id) === String(ctx.adminId) })),
  };
}

/** Makes someone a super admin: promotes an existing account, or creates one with the given password. */
export async function addSuperAdmin(ctx, { email, name, password }) {
  let user = await User.findOne({ email }).select("+isSuperAdmin");
  const created = !user;
  if (user?.isSuperAdmin) throw AppError.conflict(`${email} is already a super admin`, "ALREADY_SUPER_ADMIN");
  if (user) {
    user.isSuperAdmin = true;
    if (!user.isActive) user.isActive = true;
    await user.save();
    // Their next sign-in gives a console session instead of a school one
    await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  } else {
    if (!name || !password) throw AppError.badRequest("No account with that email. Enter a name and password to create one.", "NAME_PASSWORD_REQUIRED");
    user = await User.create({ name, email, passwordHash: await hashPassword(password), isSuperAdmin: true });
  }
  await audit(ctx, { action: "superadmin.add", targetType: "user", targetId: user._id, metadata: { email, created } });
  return listSuperAdmins(ctx);
}

export async function removeSuperAdmin(ctx, userId) {
  if (String(userId) === String(ctx.adminId)) throw AppError.badRequest("You can't remove yourself. Ask another super admin.", "CANNOT_REMOVE_SELF");
  const user = await User.findById(userId).select("+isSuperAdmin");
  if (!user?.isSuperAdmin) throw AppError.notFound("Super admin not found");
  if ((await User.countDocuments({ isSuperAdmin: true, isActive: true, _id: { $ne: user._id } })) === 0) throw AppError.badRequest("There must be at least one super admin", "LAST_SUPER_ADMIN");
  user.isSuperAdmin = false;
  await user.save();
  await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit(ctx, { action: "superadmin.remove", targetType: "user", targetId: user._id, metadata: { email: user.email } });
  return listSuperAdmins(ctx);
}

async function findSuperAdmin(userId) {
  const user = await User.findById(userId).select("+isSuperAdmin");
  if (!user?.isSuperAdmin) throw AppError.notFound("Super admin not found");
  return user;
}

/** Name and email of any super admin (including yourself). */
export async function updateSuperAdmin(ctx, userId, { name, email }) {
  const user = await findSuperAdmin(userId);
  const before = { name: user.name, email: user.email };
  if (email && email !== user.email) {
    if (await User.exists({ email, _id: { $ne: user._id } })) throw AppError.conflict("Another account already uses that email", "EMAIL_TAKEN");
    user.email = email;
  }
  if (name) user.name = name;
  await user.save();
  await audit(ctx, { action: "superadmin.update", targetType: "user", targetId: user._id, metadata: { before, after: { name: user.name, email: user.email } } });
  return listSuperAdmins(ctx);
}

/** Sets a new password for another super admin and signs them out everywhere. */
export async function resetSuperAdminPassword(ctx, userId, { password }) {
  if (String(userId) === String(ctx.adminId)) throw AppError.badRequest("Use \"Change my password\" for your own account", "USE_OWN_PASSWORD_CHANGE");
  const user = await findSuperAdmin(userId);
  user.passwordHash = await hashPassword(password);
  await user.save();
  await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit(ctx, { action: "superadmin.reset_password", targetType: "user", targetId: user._id });
}

/** Your own password: needs the current one; other devices are signed out, this one stays. */
export async function changeOwnPassword(ctx, { currentPassword, newPassword }, refreshToken) {
  const user = await User.findById(ctx.adminId).select("+passwordHash");
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw AppError.badRequest("Current password is incorrect", "WRONG_PASSWORD", [{ field: "currentPassword", message: "Current password is incorrect" }]);
  }
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  let keep = null;
  try {
    const payload = verifyRefreshToken(refreshToken);
    if (payload.sub === String(user._id)) keep = payload.sid;
  } catch {
    // No valid cookie: sign out everywhere
  }
  const { modifiedCount } = await Session.updateMany({ userId: user._id, revokedAt: null, ...(keep ? { _id: { $ne: keep } } : {}) }, { $set: { revokedAt: new Date() } });
  await audit(ctx, { action: "superadmin.change_own_password", targetType: "user", targetId: user._id });
  return { signedOutSessions: modifiedCount };
}
