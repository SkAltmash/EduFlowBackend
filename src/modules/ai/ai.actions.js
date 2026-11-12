// Changes the AI assistant can prepare: record a fee payment, mark one student's attendance,
// add a note about a student. A prepare_* tool only finds the matching students in the
// member's own school and saves a pending AiAction; the app then asks the member which
// student (when several match) and to confirm. Confirming runs the same service as the
// app's own screens, with the member's own role and permissions, and is audit logged.
import { z } from "zod";
import AiAction from "../../models/AiAction.js";
import Attendance, { ATTENDANCE_STATUSES } from "../../models/Attendance.js";
import AuditLog from "../../models/AuditLog.js";
import Invoice from "../../models/Invoice.js";
import { ROLES } from "../../models/Membership.js";
import { PAYMENT_MODES } from "../../models/Payment.js";
import Student from "../../models/Student.js";
import StudentNote, { NOTE_KINDS } from "../../models/StudentNote.js";
import AppError from "../../utils/AppError.js";
import { editPermission, saveRegister } from "../attendance/attendance.service.js";
import { nameOf } from "../classroom/classroom.common.js";
import { createPayment } from "../fees/fees.service.js";
import { canTeachClass } from "../teaching/teaching.scope.js";
import { loadClassList } from "../academics/class-names.js";
import { ToolError, indiaToday } from "./ai.tools.js";

const FEE_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.ACCOUNTANT];
const TEACHING_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER];
const ROLES_BY_KIND = { fee_payment: FEE_ROLES, attendance: TEACHING_ROLES, class_attendance: TEACHING_ROLES, student_note: TEACHING_ROLES };

const PENDING_MINUTES = 30;
const MAX_CANDIDATES = 8;
const MAX_PAYMENT_RUPEES = 10_00_000;

const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
const cls = (s) => (s.grade ? (s.section ? `${s.grade}-${s.section}` : s.grade) : "");
const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const validDay = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

export function serializeAction(a) {
  return {
    id: String(a._id),
    kind: a.kind,
    status: a.status,
    query: a.query,
    params: a.params ?? {},
    candidates: (a.candidates ?? []).map((c) => ({ id: String(c.studentId), name: c.name, class: c.class, admissionNo: c.admissionNo, guardianName: c.guardianName, balance: c.balance ?? null, hasFeePlan: c.hasFeePlan ?? null, attendance: c.attendance ?? null })),
    studentId: a.studentId ? String(a.studentId) : null,
    result: a.result ?? null,
    error: a.error || null,
    expiresAt: a.expiresAt,
    createdAt: a.createdAt,
  };
}

/**
 * Students in this school matching a name or admission number: every word must start a
 * first or last name (or be the admission number). Current students first; students who
 * left only when no current one matches.
 */
async function findCandidates(ctx, query, { classScope = false } = {}) {
  const words = String(query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 4);
  if (!words.length) throw new ToolError("Say which student (name or admission number).");
  const and = words.map((w) => ({ $or: [{ firstName: new RegExp(`^${esc(w)}`, "i") }, { lastName: new RegExp(`^${esc(w)}`, "i") }, { admissionNo: new RegExp(`^${esc(w)}$`, "i") }] }));
  const fields = { firstName: 1, lastName: 1, admissionNo: 1, grade: 1, section: 1, guardianName: 1, status: 1 };
  let list = await Student.find({ tenantId: ctx.tenantId, status: "active", $and: and }, fields).collation({ locale: "en", numericOrdering: true }).sort({ grade: 1, section: 1, firstName: 1 }).limit(30).lean();
  if (!list.length) list = await Student.find({ tenantId: ctx.tenantId, $and: and }, fields).limit(30).lean();
  // Teachers mark attendance only for their own classes
  if (classScope) list = list.filter((s) => canTeachClass(ctx.scope, s.grade || "", s.section || ""));
  if (!list.length) throw new ToolError(`No student matching "${query}" in this school${classScope && ctx.scope.limited ? " (in your classes)" : ""}. Ask the user to check the name.`);
  if (list.length > MAX_CANDIDATES) throw new ToolError(`${list.length} students match "${query}". Ask the user for the full name, class or admission number.`);
  return list;
}

async function createAction(ctx, kind, query, params, students, extra = () => ({})) {
  const action = await AiAction.create({
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    kind,
    query: String(query).slice(0, 100),
    params,
    candidates: students.map((s) => ({ studentId: s._id, name: fullName(s), class: cls(s) + (s.status !== "active" ? " (left)" : ""), admissionNo: s.admissionNo, guardianName: s.guardianName || "", ...extra(s) })),
    expiresAt: new Date(Date.now() + PENDING_MINUTES * 60_000),
  });
  const n = students.length;
  return {
    // Sent to the app (not to the model): it opens the confirm dialog
    __action: serializeAction(action),
    status: "awaiting_confirmation",
    matchingStudents: n,
    message:
      n > 1
        ? `${n} students match. The app is showing the user a dialog to choose the right one and confirm. Nothing has been changed yet; tell the user to choose and confirm there.`
        : "The app is showing the user a dialog to confirm. Nothing has been changed yet; tell the user to check and confirm there.",
    ...(kind === "fee_payment" ? { ifNoFeePlan: "If noFeePlan lists the student, tell the user no fee plan is assigned to them yet and give the steps in howToAssignAFeePlan as a short numbered list." } : {}),
  };
}

/** Students in `roster` whose first/last names start with every word of `query` (or admission no). */
function matchInRoster(roster, query) {
  const words = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return roster.filter((s) => words.every((w) => [s.firstName, s.lastName].some((n) => String(n ?? "").toLowerCase().startsWith(w)) || String(s.admissionNo).toLowerCase() === w || String(s.rollNo ?? "") === w));
}

export const ACTION_TOOLS = [
  {
    name: "prepare_fee_payment",
    roles: FEE_ROLES,
    description:
      "Prepare recording a fee payment received from a student's family (e.g. '1000 fees for Sara'). Does NOT record it: the user picks the student if several match and confirms in the app. Ask for the amount if it wasn't given.",
    parameters: {
      type: "object",
      properties: {
        student: { type: "string", description: "Student's name or admission number, as the user said it" },
        amountRupees: { type: "number", description: "Amount received, in rupees" },
        mode: { type: "string", enum: [...PAYMENT_MODES], description: "Only if the user said how it was paid (cash, upi…)" },
        date: { type: "string", description: "YYYY-MM-DD, only if the user gave a date (default today)" },
        note: { type: "string", description: "Optional note on the receipt" },
      },
      required: ["student", "amountRupees"],
    },
    async run(ctx, a) {
      const rupees = Number(a.amountRupees);
      if (!Number.isFinite(rupees) || rupees <= 0) throw new ToolError("The amount must be more than zero.");
      if (rupees > MAX_PAYMENT_RUPEES) throw new ToolError("That amount is too large for one payment.");
      const date = validDay(a.date) ? a.date : ctx.today;
      if (date > ctx.today) throw new ToolError("A payment can't be recorded for a future date.");
      const students = await findCandidates(ctx, a.student);
      const balances = await Invoice.aggregate([
        { $match: { tenantId: ctx.oid, studentId: { $in: students.map((s) => s._id) } } },
        { $group: { _id: "$studentId", balance: { $sum: { $max: [0, { $subtract: [{ $subtract: ["$amount", "$discount"] }, "$paid"] }] } } } },
      ]);
      // A student with no dues at all has no fee plan assigned
      const balanceOf = new Map(balances.map((b) => [String(b._id), b.balance]));
      const params = { amount: Math.round(rupees * 100), mode: PAYMENT_MODES.includes(a.mode) ? a.mode : "cash", date, note: String(a.note ?? "").slice(0, 500) };
      const out = await createAction(ctx, "fee_payment", a.student, params, students, (s) => ({ balance: balanceOf.get(String(s._id)) ?? 0, hasFeePlan: balanceOf.has(String(s._id)) }));
      const noPlan = students.filter((s) => !balanceOf.has(String(s._id))).map(fullName);
      if (noPlan.length) {
        out.noFeePlan = noPlan;
        out.howToAssignAFeePlan =
          "Fees → Fee plans tab → open the plan for the student's class (or create one with “New fee plan”) → “Assign to students” → choose the class or the student → Assign. Until then this payment is kept as advance and is used automatically when a plan is assigned.";
      }
      return out;
    },
  },
  {
    name: "prepare_attendance",
    roles: TEACHING_ROLES,
    description: "Prepare marking ONE student's attendance for a day (e.g. 'mark Sara absent today'). Does NOT mark it: the user confirms in the app. For a whole class, tell them to use the Attendance page.",
    parameters: {
      type: "object",
      properties: {
        student: { type: "string", description: "Student's name or admission number" },
        status: { type: "string", enum: [...ATTENDANCE_STATUSES] },
        date: { type: "string", description: "YYYY-MM-DD (default today)" },
      },
      required: ["student", "status"],
    },
    async run(ctx, a) {
      if (!ATTENDANCE_STATUSES.includes(a.status)) throw new ToolError(`Status must be one of ${ATTENDANCE_STATUSES.join(", ")}.`);
      const date = validDay(a.date) ? a.date : ctx.today;
      const permission = editPermission(ctx.role, date);
      if (!permission.canEdit) throw new ToolError(permission.reason);
      const students = await findCandidates(ctx, a.student, { classScope: true });
      const marked = await Attendance.find({ tenantId: ctx.tenantId, date, studentId: { $in: students.map((s) => s._id) } }, { studentId: 1, status: 1 }).lean();
      const markedAs = new Map(marked.map((m) => [String(m.studentId), m.status]));
      return createAction(ctx, "attendance", a.student, { status: a.status, date }, students, (s) => ({ attendance: markedAs.get(String(s._id)) ?? "not marked" }));
    },
  },
  {
    name: "prepare_class_attendance",
    roles: TEACHING_ROLES,
    description:
      "Prepare marking attendance for a WHOLE class for a day, e.g. 'Class 5-A all present except Riya and Aman absent, Sara late'. Does NOT mark it: the app shows the register to check and confirm. Students not named get `everyone`.",
    parameters: {
      type: "object",
      properties: {
        grade: { type: "string", description: "Class name, e.g. \"5\"" },
        section: { type: "string", description: "Section, e.g. \"A\" (if the class has sections)" },
        everyone: { type: "string", enum: [...ATTENDANCE_STATUSES], description: "Status for everyone not listed in exceptions (default present)" },
        exceptions: {
          type: "array",
          description: "Students with a different status",
          items: { type: "object", properties: { student: { type: "string", description: "Name, roll number or admission number" }, status: { type: "string", enum: [...ATTENDANCE_STATUSES] } }, required: ["student", "status"] },
        },
        date: { type: "string", description: "YYYY-MM-DD (default today)" },
      },
      required: ["grade"],
    },
    async run(ctx, a) {
      const date = validDay(a.date) ? a.date : ctx.today;
      const permission = editPermission(ctx.role, date);
      if (!permission.canEdit) throw new ToolError(permission.reason);
      const r = (await loadClassList(ctx.tenantId)).resolve(a.grade, a.section ?? "");
      if (r.error) throw new ToolError(r.error.message);
      const { grade, section } = r;
      if (!grade) throw new ToolError("Which class?");
      if (!section) {
        const sections = (await Student.distinct("section", { tenantId: ctx.tenantId, status: "active", grade })).filter(Boolean);
        if (sections.length > 1) throw new ToolError(`Class ${grade} has sections ${sections.sort().join(", ")}. Ask which section.`);
      }
      if (!canTeachClass(ctx.scope, grade, section)) throw new ToolError(`You aren't assigned to class ${section ? `${grade}-${section}` : grade}.`);
      const roster = await Student.find({ tenantId: ctx.tenantId, status: "active", grade, section: section || { $in: ["", null] } }, { firstName: 1, lastName: 1, admissionNo: 1, rollNo: 1 })
        .collation({ locale: "en", numericOrdering: true })
        .sort({ rollNo: 1, firstName: 1 })
        .lean();
      if (!roster.length) throw new ToolError(`There are no active students in class ${section ? `${grade}-${section}` : grade}.`);
      const everyone = ATTENDANCE_STATUSES.includes(a.everyone) ? a.everyone : "present";
      const status = new Map(roster.map((s) => [String(s._id), everyone]));
      const unmatched = [];
      const ambiguous = [];
      for (const ex of Array.isArray(a.exceptions) ? a.exceptions.slice(0, 100) : []) {
        if (!ATTENDANCE_STATUSES.includes(ex?.status)) continue;
        const found = matchInRoster(roster, ex.student);
        if (found.length === 1) status.set(String(found[0]._id), ex.status);
        else if (!found.length) unmatched.push(String(ex.student).slice(0, 60));
        // Several match: left as `everyone`, flagged in the register to set by hand
        else ambiguous.push({ query: String(ex.student).slice(0, 60), status: ex.status, ids: found.map((s) => String(s._id)) });
      }
      const marked = await Attendance.find({ tenantId: ctx.tenantId, date, studentId: { $in: roster.map((s) => s._id) } }, { studentId: 1, status: 1 }).lean();
      const was = new Map(marked.map((m) => [String(m.studentId), m.status]));
      const entries = roster.map((s) => ({ studentId: String(s._id), name: fullName(s), rollNo: s.rollNo || "", status: status.get(String(s._id)), was: was.get(String(s._id)) ?? null }));
      const action = await AiAction.create({
        tenantId: ctx.tenantId,
        userId: ctx.user.id,
        kind: "class_attendance",
        query: section ? `${grade}-${section}` : grade,
        params: { grade, section, date, everyone, entries, unmatched, ambiguous },
        candidates: [],
        expiresAt: new Date(Date.now() + PENDING_MINUTES * 60_000),
      });
      const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((st) => [st, entries.filter((e) => e.status === st).length]));
      return {
        __action: serializeAction(action),
        status: "awaiting_confirmation",
        class: section ? `${grade}-${section}` : grade,
        date,
        students: entries.length,
        counts,
        alreadyMarked: marked.length,
        ...(unmatched.length ? { notFoundInClass: unmatched } : {}),
        ...(ambiguous.length ? { severalMatch: ambiguous.map((x) => x.query) } : {}),
        message:
          "The app is showing the user the class register to check and confirm. Nothing has been marked yet. Tell them the counts briefly" +
          (unmatched.length ? ", and that these names weren't found in the class (they can set them in the register)" : "") +
          (ambiguous.length ? ", and that some names match several students, highlighted in the register to set by hand" : "") +
          ".",
      };
    },
  },
  {
    name: "prepare_student_note",
    roles: TEACHING_ROLES,
    description: "Prepare adding a staff note about a student (praise, concern, meeting or general note), seen only by staff. Does NOT save it: the user confirms in the app.",
    parameters: {
      type: "object",
      properties: {
        student: { type: "string", description: "Student's name or admission number" },
        kind: { type: "string", enum: [...NOTE_KINDS] },
        text: { type: "string", description: "The note, written clearly" },
      },
      required: ["student", "text"],
    },
    async run(ctx, a) {
      const text = String(a.text ?? "").trim();
      if (text.length < 2) throw new ToolError("Say what the note should say.");
      const students = await findCandidates(ctx, a.student);
      return createAction(ctx, "student_note", a.student, { kind: NOTE_KINDS.includes(a.kind) ? a.kind : "note", text: text.slice(0, 1000) }, students);
    },
  },
];

// ---------------------------------------------------------------------------
// Confirm / cancel (from the app)
// ---------------------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const EDITS = {
  fee_payment: z.object({
    amount: z.number().int("Amount must be in whole paise").min(100, "The amount must be at least ₹1").max(MAX_PAYMENT_RUPEES * 100, "That amount is too large"),
    mode: z.enum(PAYMENT_MODES),
    date: day,
    note: z.string().trim().max(500).default(""),
  }),
  attendance: z.object({ status: z.enum(ATTENDANCE_STATUSES), date: day }),
  class_attendance: z.object({
    date: day,
    entries: z.array(z.object({ studentId: z.string(), status: z.enum(ATTENDANCE_STATUSES) })).min(1).max(500),
  }),
  student_note: z.object({ kind: z.enum(NOTE_KINDS), text: z.string().trim().min(2, "Write the note").max(1000) }),
};

async function mine(user, id) {
  const action = await AiAction.findOne({ _id: id, tenantId: user.tenantId, userId: user.id }).lean();
  if (!action) throw AppError.notFound("This action wasn't found.", "AI_ACTION_NOT_FOUND");
  return action;
}

export async function getAction(user, id) {
  return { action: serializeAction(await mine(user, id)) };
}

export async function cancelAction(user, id) {
  const a = await AiAction.findOneAndUpdate({ _id: id, tenantId: user.tenantId, userId: user.id, status: "pending" }, { $set: { status: "cancelled" } }, { new: true }).lean();
  if (!a) throw AppError.conflict("This action can't be cancelled now.", "AI_ACTION_NOT_PENDING");
  return { action: serializeAction(a) };
}

/** Runs the confirmed change for the chosen student, with any edits made in the dialog. */
export async function confirmAction(user, ctx, id, { studentId, ...changes }) {
  const action = await mine(user, id);
  if (action.status !== "pending") throw AppError.conflict(action.status === "done" ? "This was already done." : "This action is no longer open.", "AI_ACTION_NOT_PENDING");
  if (action.expiresAt < new Date()) throw new AppError(410, "This has expired. Ask the assistant again.", "AI_ACTION_EXPIRED");
  if (!ROLES_BY_KIND[action.kind].includes(user.role)) throw AppError.forbidden("Your role can't do this.", "AI_ACTION_NOT_ALLOWED");
  const whole = action.kind === "class_attendance";
  if (!whole && !action.candidates.some((c) => String(c.studentId) === studentId)) throw AppError.badRequest("Choose one of the students shown.", "AI_ACTION_BAD_STUDENT");

  const parsed = EDITS[action.kind].safeParse({ ...action.params, ...changes });
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => ({ field: String(i.path[0] ?? ""), message: i.message }));
    throw AppError.badRequest(details[0]?.message ?? "Check the details", "VALIDATION_ERROR", details);
  }
  const params = whole ? { ...action.params, ...parsed.data } : parsed.data;
  if (whole) {
    // Only the class's students, each once
    const inClass = new Set(action.params.entries.map((e) => e.studentId));
    if (params.entries.some((e) => !inClass.has(e.studentId)) || new Set(params.entries.map((e) => e.studentId)).size !== params.entries.length) {
      throw AppError.badRequest("The register changed. Ask the assistant again.", "AI_ACTION_BAD_STUDENT");
    }
  }
  if (params.date && params.date > indiaToday()) throw AppError.badRequest("The date can't be in the future.", "VALIDATION_ERROR", [{ field: "date", message: "The date can't be in the future." }]);

  // Only one confirm runs, even if the button is pressed twice
  const locked = await AiAction.findOneAndUpdate({ _id: id, status: "pending" }, { $set: { status: "running", ...(whole ? {} : { studentId }), params } }, { new: true });
  if (!locked) throw AppError.conflict("This is already being done.", "AI_ACTION_NOT_PENDING");

  try {
    let result;
    if (action.kind === "fee_payment") {
      const r = await createPayment(user.tenantId, user, { studentId, amount: params.amount, date: params.date, mode: params.mode, reference: "", note: params.note, kind: "receipt" });
      result = { paymentId: r.payment.id, receiptNo: r.payment.receiptNo, balance: r.currentBalance, advance: r.currentAdvance };
    } else if (whole) {
      await saveRegister(user.tenantId, user, { date: params.date, grade: params.grade, section: params.section || "", entries: params.entries.map(({ studentId: id, status }) => ({ studentId: id, status })) });
      result = { date: params.date, counts: Object.fromEntries(ATTENDANCE_STATUSES.map((st) => [st, params.entries.filter((e) => e.status === st).length])) };
    } else if (action.kind === "attendance") {
      const s = await Student.findOne({ _id: studentId, tenantId: user.tenantId }, { grade: 1, section: 1 }).lean();
      if (!s) throw AppError.notFound("Student not found");
      if (!s.grade) throw AppError.badRequest("This student has no class, so attendance can't be marked.", "STUDENT_NO_CLASS");
      await saveRegister(user.tenantId, user, { date: params.date, grade: s.grade, section: s.section || "", entries: [{ studentId, status: params.status }] });
      result = { status: params.status, date: params.date };
    } else {
      if (!(await Student.exists({ _id: studentId, tenantId: user.tenantId }))) throw AppError.notFound("Student not found");
      const note = await StudentNote.create({ tenantId: user.tenantId, studentId, kind: params.kind, text: params.text, createdBy: user.id, createdByName: await nameOf(user.id) });
      result = { noteId: String(note._id) };
    }
    const done = await AiAction.findByIdAndUpdate(id, { $set: { status: "done", result, error: "", doneAt: new Date() } }, { new: true }).lean();
    await AuditLog.create({
      actorId: user.id,
      tenantId: user.tenantId,
      ip: ctx.ip?.slice(0, 64),
      userAgent: ctx.userAgent?.slice(0, 500),
      action: `ai.${action.kind}`,
      targetType: "tenant",
      targetId: user.tenantId,
      metadata: { actionId: id, ...(whole ? { class: action.query, date: params.date, counts: result.counts } : { studentId, ...params }), ...(result.receiptNo ? { receiptNo: result.receiptNo } : {}) },
    }).catch(() => {});
    return { action: serializeAction(done) };
  } catch (err) {
    // Back to pending with the reason, so the member can fix it (e.g. another date) and retry
    await AiAction.updateOne({ _id: id }, { $set: { status: "pending", error: String(err?.message ?? "Failed").slice(0, 300) } });
    throw err;
  }
}
