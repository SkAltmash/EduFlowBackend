// Subscription status, limits and feature access for a school, plus activity tracking.
import PlatformPlan, { PLAN_FEATURES } from "../../models/PlatformPlan.js";
import Student from "../../models/Student.js";
import Tenant from "../../models/Tenant.js";
import TenantActivity from "../../models/TenantActivity.js";
import AppError from "../../utils/AppError.js";

export const TRIAL_DAYS = 7;
/** Days after a paid period ends before the school becomes read-only. */
export const GRACE_DAYS = 3;
const DAY_MS = 86_400_000;

const DEFAULT_PLANS = [
  { name: "Basic", description: "Students, attendance, fees, tests and WhatsApp click-to-send.", priceMonthly: 99900, priceYearly: 999000, studentLimit: 300, features: { whatsappApi: false, homework: true, timetable: true, performance: true }, isDefault: true, order: 1 },
  { name: "Pro", description: "Everything, plus automatic WhatsApp and unlimited students.", priceMonthly: 199900, priceYearly: 1999000, studentLimit: 0, features: { whatsappApi: true, homework: true, timetable: true, performance: true }, order: 2 },
];

/** Creates the starting plans the first time they're needed. */
export async function ensureDefaultPlans() {
  if (await PlatformPlan.exists({})) return;
  try {
    await PlatformPlan.insertMany(DEFAULT_PLANS);
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
}

/** Puts a new school on the free trial of the default plan. */
export async function startTrial(tenant, session) {
  await ensureDefaultPlans();
  const plan = await PlatformPlan.findOne({ isDefault: true, archived: false }).lean();
  tenant.subscription = { status: "trial", planId: plan?._id, cycle: "monthly", trialEndsAt: new Date(Date.now() + TRIAL_DAYS * DAY_MS), updatedAt: new Date() };
  await tenant.save({ session });
}

const asObject = (m) => (m instanceof Map ? Object.fromEntries(m) : (m ?? {}));

/**
 * What a school may do right now.
 * status: none (older school, no plan yet) | trial | active | overdue (in grace) | expired | suspended
 */
export function computeAccess(tenant, plan) {
  const sub = tenant.subscription;
  const now = Date.now();
  const planFeatures = plan ? asObject(plan.features) : {};
  const overrides = asObject(tenant.featureOverrides);
  const features = Object.fromEntries(PLAN_FEATURES.map((f) => [f, overrides[f] ?? (plan ? planFeatures[f] !== false : true)]));
  const studentLimit = tenant.studentLimitOverride ?? (plan?.studentLimit || 0);

  let status = "none";
  let endsAt = null;
  if (sub?.status === "suspended") status = "suspended";
  else if (sub?.status === "trial") {
    endsAt = sub.trialEndsAt ?? null;
    status = endsAt && now > new Date(endsAt).getTime() ? "expired" : "trial";
  } else if (sub?.status === "active") {
    endsAt = sub.currentPeriodEnd ?? null;
    const end = endsAt ? new Date(endsAt).getTime() : Infinity;
    status = now <= end ? "active" : now <= end + GRACE_DAYS * DAY_MS ? "overdue" : "expired";
  }
  const daysLeft = endsAt ? Math.ceil((new Date(endsAt).getTime() - now) / DAY_MS) : null;
  return {
    status,
    planId: plan ? String(plan._id) : null,
    planName: plan?.name ?? null,
    cycle: sub?.cycle ?? "monthly",
    trialEndsAt: sub?.trialEndsAt ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    endsAt,
    daysLeft,
    readOnly: status === "expired" || status === "suspended",
    studentLimit,
    features,
  };
}

// Small in-memory cache: the access check runs on every write request
const cache = new Map();
const TTL_MS = 60_000;

export async function getAccess(tenantId) {
  const key = String(tenantId);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - TTL_MS) return hit.access;
  const tenant = await Tenant.findById(tenantId, { subscription: 1, studentLimitOverride: 1, featureOverrides: 1 }).lean();
  if (!tenant) return computeAccess({}, null);
  const plan = tenant.subscription?.planId ? await PlatformPlan.findById(tenant.subscription.planId).lean() : null;
  const access = computeAccess(tenant, plan);
  cache.set(key, { at: Date.now(), access });
  return access;
}

export function invalidateAccess(tenantId) {
  if (tenantId) cache.delete(String(tenantId));
  else cache.clear();
}

/** 402 when the school's plan doesn't include a feature. */
export function requireFeature(feature) {
  return async (req, res, next) => {
    if (req.user?.isImpersonating) return next();
    const access = await getAccess(req.user.tenantId);
    if (!access.features[feature]) {
      throw new AppError(402, "This feature isn't part of your plan. Upgrade to use it.", "FEATURE_NOT_IN_PLAN");
    }
    next();
  };
}

/** Throws when adding `adding` students would pass the plan's student limit. */
export async function assertStudentCapacity(tenantId, adding = 1) {
  const access = await getAccess(tenantId);
  if (!access.studentLimit) return;
  const active = await Student.countDocuments({ tenantId, status: "active" });
  if (active + adding > access.studentLimit) {
    throw new AppError(
      402,
      `Your ${access.planName ?? ""} plan allows ${access.studentLimit} active students (you have ${active}). Upgrade your plan to add more.`.replace("  ", " "),
      "STUDENT_LIMIT"
    );
  }
}

// Activity: at most one write per school per day per server
const seen = new Map();
export function recordActivity(tenantId) {
  const day = new Date().toISOString().slice(0, 10);
  const key = String(tenantId);
  if (seen.get(key) === day) return;
  seen.set(key, day);
  // Fire and forget: activity tracking must never slow down or fail a request
  Promise.all([
    TenantActivity.updateOne({ tenantId, day }, { $inc: { requests: 1 } }, { upsert: true }),
    Tenant.updateOne({ _id: tenantId }, { $set: { lastActiveAt: new Date() } }),
  ]).catch(() => seen.delete(key));
}
