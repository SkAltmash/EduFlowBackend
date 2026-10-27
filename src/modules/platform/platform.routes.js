// Super admin console routes (mounted on /api/admin next to the admin module) and the
// tenant-facing subscription status (/api/tenant/status).
import { Router } from "express";
import { z } from "zod";
import * as platform from "./platform.service.js";
import { getAccess } from "./subscription.js";
import { PLAN_FEATURES } from "../../models/PlatformPlan.js";
import { objectId } from "../auth/auth.validation.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";

const ctx = (req) => ({ adminId: req.admin.id, ip: req.ip, userAgent: req.get("user-agent") });
const money = z.number().int().min(0).max(1_000_000_000);
const date = z.coerce.date();

const subscriptionSchema = z
  .object({ planId: objectId, status: z.enum(["trial", "active", "suspended"]), cycle: z.enum(["monthly", "yearly"]), trialEndsAt: date, currentPeriodEnd: date })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
const paymentSchema = z.object({
  planId: objectId.optional(),
  amount: money,
  method: z.enum(["upi", "bank", "cash", "cheque", "card", "other"]).default("upi"),
  reference: z.string().trim().max(100).default(""),
  cycle: z.enum(["monthly", "yearly"]).default("monthly"),
  periods: z.number().int().min(1).max(36).default(1),
  note: z.string().trim().max(300).default(""),
});
const limitsSchema = z.object({
  studentLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
  features: z.partialRecord(z.enum(PLAN_FEATURES), z.boolean().nullable()).optional(),
});
const planSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(""),
  priceMonthly: money,
  priceYearly: money,
  studentLimit: z.number().int().min(0).max(1_000_000),
  features: z.partialRecord(z.enum(PLAN_FEATURES), z.boolean()).default({}),
  isDefault: z.boolean().default(false),
  archived: z.boolean().default(false),
  order: z.number().int().default(0),
});
const announcementSchema = z.object({
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().max(500).default(""),
  tone: z.enum(["info", "warning", "success"]).default("info"),
  linkUrl: z.union([z.literal(""), z.string().trim().url().max(300)]).default(""),
  linkLabel: z.string().trim().max(40).default(""),
  startsAt: date.optional(),
  endsAt: date.nullable().optional(),
  active: z.boolean().default(true),
});
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.enum(["all", "none", "trial", "active", "paying", "overdue", "expired", "suspended"]).default("all"),
  health: z.enum(["all", "active", "quiet", "never", "new"]).default("all"),
});
const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });

// Mounted inside the admin router, which already applies the IP allowlist, rate limit and super admin check
export const adminPlatformRouter = Router();
const r = adminPlatformRouter;
for (const name of ["schoolId", "planId", "announcementId", "noteId", "paymentId"]) {
  r.param(name, (req, res, next, value) => {
    if (!objectId.safeParse(value).success) throw AppError.badRequest(`Invalid ${name}`, "INVALID_ID");
    next();
  });
}

r.get("/dashboard", async (req, res) => res.json(await platform.dashboard()));
r.get("/search", validateQuery(z.object({ q: z.string().trim().min(2).max(100) })), async (req, res) => res.json(await platform.search(req.validatedQuery.q)));
r.get("/system", async (req, res) => res.json(await platform.system()));

r.get("/schools", validateQuery(listQuery), async (req, res) => res.json(await platform.listSchools(req.validatedQuery)));
r.get("/schools/:schoolId", async (req, res) => res.json(await platform.schoolDetail(req.params.schoolId)));
r.patch("/schools/:schoolId/subscription", validateBody(subscriptionSchema), async (req, res) => res.json(await platform.updateSubscription(ctx(req), req.params.schoolId, req.body)));
r.post("/schools/:schoolId/extend-trial", validateBody(z.object({ days: z.number().int().min(1).max(365) })), async (req, res) => res.json(await platform.extendTrial(ctx(req), req.params.schoolId, req.body)));
r.post("/schools/:schoolId/payments", validateBody(paymentSchema), async (req, res) => res.status(201).json(await platform.recordPayment(ctx(req), req.params.schoolId, req.body)));
r.delete("/schools/:schoolId/payments/:paymentId", async (req, res) => res.json(await platform.deletePayment(ctx(req), req.params.schoolId, req.params.paymentId)));
r.patch("/schools/:schoolId/limits", validateBody(limitsSchema), async (req, res) => res.json(await platform.updateLimits(ctx(req), req.params.schoolId, req.body)));
r.post("/schools/:schoolId/notes", validateBody(z.object({ text: z.string().trim().min(1).max(1000) })), async (req, res) => res.status(201).json(await platform.addNote(ctx(req), req.params.schoolId, req.body)));
r.delete("/schools/:schoolId/notes/:noteId", async (req, res) => res.json(await platform.deleteNote(req.params.schoolId, req.params.noteId)));
r.post("/schools/:schoolId/logout-all", async (req, res) => res.json(await platform.logoutAll(ctx(req), req.params.schoolId)));
r.get("/schools/:schoolId/export", async (req, res) => {
  const data = await platform.exportSchool(ctx(req), req.params.schoolId);
  res.setHeader("Content-Disposition", `attachment; filename="eduflow-${data.school.slug}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});
r.delete("/schools/:schoolId", validateBody(z.object({ confirm: z.string().trim().min(1).max(100) })), async (req, res) => res.json(await platform.deleteSchool(ctx(req), req.params.schoolId, req.body)));

r.get("/plans", async (req, res) => res.json(await platform.listPlans()));
r.post("/plans", validateBody(planSchema), async (req, res) => res.status(201).json(await platform.savePlan(ctx(req), null, req.body)));
r.patch("/plans/:planId", validateBody(planSchema.partial()), async (req, res) => res.json(await platform.savePlan(ctx(req), req.params.planId, req.body)));

r.get("/announcements", async (req, res) => res.json(await platform.listAnnouncements()));
r.post("/announcements", validateBody(announcementSchema), async (req, res) => res.status(201).json(await platform.saveAnnouncement(ctx(req), null, req.body)));
r.patch("/announcements/:announcementId", validateBody(announcementSchema.partial()), async (req, res) => res.json(await platform.saveAnnouncement(ctx(req), req.params.announcementId, req.body)));
r.delete("/announcements/:announcementId", async (req, res) => res.json(await platform.deleteAnnouncement(ctx(req), req.params.announcementId)));

r.get("/2fa", async (req, res) => res.json(await platform.twoFactorStatus(ctx(req))));
r.post("/2fa/setup", async (req, res) => res.json(await platform.twoFactorSetup(ctx(req))));
r.post("/2fa/enable", validateBody(codeSchema), async (req, res) => res.json(await platform.twoFactorEnable(ctx(req), req.body)));
r.post("/2fa/disable", validateBody(codeSchema), async (req, res) => res.json(await platform.twoFactorDisable(ctx(req), req.body)));

/** For every member of a school: its plan status, limits, features and announcements. */
export const tenantStatusRouter = Router();
tenantStatusRouter.get("/status", authenticate, async (req, res) => {
  const [subscription, announcements, { plans }] = await Promise.all([getAccess(req.user.tenantId), platform.activeAnnouncements(), platform.listPlans()]);
  // Schools see the plans on offer, without the per-plan school counts
  const offered = plans.filter((p) => !p.archived).map(({ schools: _schools, ...p }) => p);
  res.json({ subscription, announcements, plans: offered, support: { whatsapp: process.env.SUPPORT_WHATSAPP ?? "", email: process.env.SUPPORT_EMAIL ?? "" } });
});
