// Fee concessions: a standing concession per student (applied to unpaid dues and to plans
// assigned later), ready-made concession types, the assign preview and the concessions report.
import { z } from "zod";
import mongoose from "mongoose";
import FeePlan from "../../models/FeePlan.js";
import Invoice from "../../models/Invoice.js";
import SchoolSettings from "../../models/SchoolSettings.js";
import Student from "../../models/Student.js";
import User from "../../models/User.js";
import AppError from "../../utils/AppError.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import { advances, settleStudent } from "./fees.advance.js";
import { objectId } from "../auth/auth.validation.js";

export const CONCESSION_TYPES = ["percent", "amount", "fixed", "free"];
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export const concessionSchema = z
  .object({
    type: z.enum(CONCESSION_TYPES),
    // percent: 0-100; amount / fixed: whole paise; free: ignored
    value: z.number().min(0).default(0),
    reason: z.string().trim().max(100).default(""),
    presetId: objectId.optional(),
  })
  .refine((c) => c.type !== "percent" || c.value <= 100, { message: "Percent must be 0–100", path: ["value"] })
  .refine((c) => !["amount", "fixed"].includes(c.type) || Number.isInteger(c.value), { message: "Amount must be in whole paise", path: ["value"] })
  .refine((c) => c.type === "free" || c.value > 0 || c.type === "fixed", { message: "Enter a value", path: ["value"] });

/** Discount on one installment of `amount` paise. */
export function discountFor(amount, c) {
  if (!c?.type) return 0;
  if (c.type === "free") return amount;
  if (c.type === "percent") return Math.min(amount, Math.round((amount * (c.value ?? 0)) / 100));
  if (c.type === "amount") return Math.min(amount, c.value ?? 0);
  // fixed: the student pays `value` per installment
  return Math.max(0, amount - (c.value ?? 0));
}

/** Short text for receipts and reports: "Sibling (10% off)". */
export function concessionLabel(c) {
  if (!c?.type) return "";
  const what = c.type === "free" ? "free" : c.type === "percent" ? `${c.value}% off` : c.type === "amount" ? `${money.format(c.value / 100)} off` : `pays ${money.format(c.value / 100)}`;
  return c.reason ? `${c.reason} (${what})` : `Concession (${what})`;
}

function serializeConcession(c) {
  if (!c?.type) return null;
  return {
    type: c.type,
    value: c.value ?? 0,
    reason: c.reason || "",
    presetId: c.presetId ? String(c.presetId) : null,
    label: concessionLabel(c),
    updatedByName: c.updatedByName || "",
    updatedAt: c.updatedAt ?? null,
  };
}

/**
 * Brings a student's dues in line with their concession. Only dues that still have
 * something to pay are touched, never below what's already paid, and never dues whose
 * discount was set by hand on that due.
 */
async function syncDues(tenantId, studentId, concession, session) {
  const dues = await Invoice.find({ tenantId, studentId }).session(session ?? null);
  let changed = 0;
  for (const d of dues) {
    // One-off discounts set on a due by hand are left alone
    if (d.discountSource === "manual") continue;
    // Settled dues keep their history
    if (d.amount - d.discount - d.paid <= 0) continue;
    // A part-paid due gets the full concession; if that's less than what was paid,
    // the extra becomes advance (settleStudent below)
    const target = discountFor(d.amount, concession);
    if (target === d.discount) continue;
    d.discount = target;
    d.discountReason = target ? concessionLabel(concession) : "";
    d.discountSource = target ? "concession" : "";
    await d.save({ session });
    changed += 1;
  }
  return changed;
}

/** Sets (or clears, with null) a student's concession and updates their unpaid dues. */
export async function setStudentConcession(tenantId, user, studentId, concession) {
  const student = await Student.findOne({ _id: studentId, tenantId });
  if (!student) throw AppError.notFound("Student not found");
  const name = (await User.findById(user.id, { name: 1 }).lean())?.name ?? "";
  let updated = 0;
  await mongoose.connection.transaction(async (session) => {
    if (concession) {
      student.feeConcession = { ...concession, updatedBy: user.id, updatedByName: name, updatedAt: new Date() };
    } else {
      student.feeConcession = undefined;
    }
    await student.save({ session });
    updated = await syncDues(tenantId, student._id, concession, session);
    await settleStudent(tenantId, student._id, session);
  });
  return { concession: serializeConcession(student.feeConcession), duesUpdated: updated };
}

/** The class a plan is being assigned to, with each student's saved concession. */
export async function assignPreview(tenantId, planId, { grade, section }) {
  const plan = await FeePlan.findOne({ _id: planId, tenantId }).lean();
  if (!plan) throw AppError.notFound("Fee plan not found");
  const students = await Student.find({ tenantId, status: "active", grade, ...(section ? { section } : {}) }, { firstName: 1, lastName: 1, admissionNo: 1, rollNo: 1, section: 1, feeConcession: 1 })
    .collation({ locale: "en", numericOrdering: true })
    .sort({ section: 1, rollNo: 1, firstName: 1 })
    .lean();
  const [assignedIds, advanceOf] = await Promise.all([
    Invoice.distinct("studentId", { tenantId, planId: plan._id, studentId: { $in: students.map((s) => s._id) } }),
    advances(tenantId, students.map((s) => s._id)),
  ]);
  const assigned = new Set(assignedIds.map(String));
  return {
    installments: plan.installments.map((i) => ({ label: i.label, dueDate: i.dueDate, amount: i.items.reduce((t, it) => t + it.amount, 0) })),
    students: students.map((s) => ({
      id: String(s._id),
      fullName: fullName(s),
      admissionNo: s.admissionNo,
      rollNo: s.rollNo || "",
      section: s.section || "",
      concession: serializeConcession(s.feeConcession),
      assigned: assigned.has(String(s._id)),
      // Already paid; pays this plan's first installments when assigned
      advance: advanceOf.get(String(s._id)) ?? 0,
    })),
  };
}

/** Everyone with a concession: saved concession and how much it has taken off their dues. */
export async function report(tenantId, { from, to }) {
  const dueFilter = { tenantId: oid(tenantId), discount: { $gt: 0 }, ...(from || to ? { dueDate: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) };
  const [byStudent, withSaved] = await Promise.all([
    Invoice.aggregate([{ $match: dueFilter }, { $group: { _id: "$studentId", amount: { $sum: "$discount" }, dues: { $sum: 1 }, reasons: { $addToSet: "$discountReason" } } }]),
    Student.find({ tenantId, "feeConcession.type": { $exists: true } }, { _id: 1 }).lean(),
  ]);
  const ids = [...new Set([...byStudent.map((r) => String(r._id)), ...withSaved.map((s) => String(s._id))])];
  const students = await Student.find({ tenantId, _id: { $in: ids } }, { firstName: 1, lastName: 1, admissionNo: 1, grade: 1, section: 1, status: 1, feeConcession: 1 }).lean();
  const totals = new Map(byStudent.map((r) => [String(r._id), r]));

  const rows = students
    .map((s) => {
      const t = totals.get(String(s._id));
      return {
        id: String(s._id),
        fullName: fullName(s),
        admissionNo: s.admissionNo,
        grade: s.grade || "",
        section: s.section || "",
        status: s.status,
        concession: serializeConcession(s.feeConcession),
        amount: t?.amount ?? 0,
        dues: t?.dues ?? 0,
        reasons: (t?.reasons ?? []).filter(Boolean),
      };
    })
    .sort((a, b) => b.amount - a.amount || a.fullName.localeCompare(b.fullName));

  // Totals per reason ("Sibling", "RTE"…), from the saved concession or the dues' text
  const byReason = new Map();
  for (const r of rows) {
    const key = r.concession?.reason || r.reasons[0]?.replace(/\s*\(.*\)$/, "") || "Other";
    const g = byReason.get(key) ?? { reason: key, students: 0, amount: 0 };
    g.students += 1;
    g.amount += r.amount;
    byReason.set(key, g);
  }
  return {
    students: rows,
    totals: { students: rows.length, amount: rows.reduce((t, r) => t + r.amount, 0) },
    byReason: [...byReason.values()].sort((a, b) => b.amount - a.amount),
  };
}

// ---------------------------------------------------------------------------
// Ready-made concession types
// ---------------------------------------------------------------------------

const DEFAULT_PRESETS = [
  { name: "Sibling", type: "percent", value: 10 },
  { name: "Staff child", type: "percent", value: 50 },
  { name: "Scholarship", type: "percent", value: 25 },
  { name: "RTE", type: "free", value: 0 },
];

const presetSchema = z.object({
  presets: z
    .array(z.object({ id: objectId.optional(), name: z.string().trim().min(1, "Name is required").max(60), type: z.enum(CONCESSION_TYPES), value: z.number().min(0) }))
    .max(30),
});

export async function getPresets(tenantId) {
  const s = await SchoolSettings.findOne({ tenantId }, { concessionPresets: 1 }).lean();
  // A school that never saved presets starts with common ones
  const list = s?.concessionPresets ?? null;
  return { presets: (list ?? DEFAULT_PRESETS).map((p) => ({ id: p._id ? String(p._id) : null, name: p.name, type: p.type, value: p.value ?? 0 })), isDefault: !list };
}

export async function savePresets(tenantId, { presets }) {
  for (const p of presets) {
    if (p.type === "percent" && p.value > 100) throw AppError.badRequest(`${p.name}: percent must be 0–100`, "INVALID_PRESET");
  }
  await SchoolSettings.updateOne(
    { tenantId },
    { $set: { concessionPresets: presets.map((p) => ({ ...(p.id ? { _id: p.id } : {}), name: p.name, type: p.type, value: p.type === "free" ? 0 : p.value })) } },
    { upsert: true }
  );
  return getPresets(tenantId);
}

// ---------------------------------------------------------------------------
// Routes (mounted on the fees router: owners, admins and accountants)
// ---------------------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function mountConcessionRoutes(router) {
  router.get("/concession-presets", async (req, res) => res.json(await getPresets(req.user.tenantId)));
  router.put("/concession-presets", validateBody(presetSchema), async (req, res) => res.json(await savePresets(req.user.tenantId, req.body)));
  router.get("/concessions", validateQuery(z.object({ from: day.optional(), to: day.optional() })), async (req, res) => res.json(await report(req.user.tenantId, req.validatedQuery)));
  router.put("/students/:studentId/concession", validateBody(z.object({ concession: concessionSchema.nullable() })), async (req, res) =>
    res.json(await setStudentConcession(req.user.tenantId, req.user, req.params.studentId, req.body.concession))
  );
  router.get("/plans/:planId/preview", validateQuery(z.object({ grade: z.string().trim().min(1).max(50), section: z.string().trim().max(20).optional() })), async (req, res) =>
    res.json(await assignPreview(req.user.tenantId, req.params.planId, req.validatedQuery))
  );
}

export { serializeConcession };
