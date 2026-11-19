// Read-only tools the AI assistant can call. Every tool runs with the signed-in member's
// school and role: a teacher never gets fee tools and only sees their own classes'
// attendance and results; an accountant never gets attendance or results. Results are kept
// small (at most MAX_ROWS rows) and carry `link`s to the app's pages.
import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Payment from "../../models/Payment.js";
import Student from "../../models/Student.js";
import { ROLES } from "../../models/Membership.js";
import { classReport, listClasses, studentHistory } from "../attendance/attendance.service.js";
import { feeRegister, studentLedger, summary as feeSummary } from "../fees/fees.service.js";
import { getExam, listExams } from "../exams/exams.service.js";
import { leaderboard } from "../performance/performance.service.js";
import { loadClassList } from "../academics/class-names.js";
import { canTeachClass, classFilter, teacherScope } from "../teaching/teaching.scope.js";
import { findGuides } from "./ai.help.js";

const MAX_ROWS = 40;
const rupees = (paise) => Math.round((paise ?? 0) / 100);
const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
const cls = (grade, section) => (grade ? (section ? `${grade}-${section}` : grade) : "");
const studentLink = (id) => `/app/students?student=${id}`;
const feeLink = (id) => `/app/fees?student=${id}`;
const receiptLink = (id) => `/app/fees?receipt=${id}`;

/** Today and the first of this month, in India time (YYYY-MM-DD). */
export function indiaToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
const monthStart = (day) => `${day.slice(0, 8)}01`;
const validDay = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

const FEE_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.ACCOUNTANT];
const TEACHING_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER];

/** Thrown inside a tool: sent back to the model as the tool's error, so it can tell the user. */
export class ToolError extends Error {}

function rangeOf(args, today) {
  const to = validDay(args.to) ?? today;
  const from = validDay(args.from) ?? monthStart(to);
  if (from > to) throw new ToolError("`from` must be on or before `to`.");
  return { from, to };
}

function assertClass(ctx, grade, section) {
  if (grade && !canTeachClass(ctx.scope, grade, section ?? "")) throw new ToolError(`You aren't assigned to class ${cls(grade, section)}.`);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "how_to",
    roles: null,
    description: "Exact steps for doing something in Zaref Campus (adding students, fee plans, collecting fees, tests, report cards, promotion, staff, WhatsApp, notices, presentations…). Use it for every 'how do I…' question instead of guessing.",
    parameters: { type: "object", properties: { topic: { type: "string", description: "What the user wants to do, in a few English words (translate if asked in Hindi/Marathi)" } }, required: ["topic"] },
    async run(ctx, a) {
      return findGuides(ctx.role, a.topic);
    },
  },
  {
    name: "list_classes",
    roles: null,
    description: "The school's classes (or batches) with their sections and number of active students. Use it to find the exact class name before other tools.",
    parameters: { type: "object", properties: {} },
    async run(ctx) {
      const [list, counts] = await Promise.all([
        loadClassList(ctx.tenantId),
        Student.aggregate([{ $match: { tenantId: ctx.oid, status: "active" } }, { $group: { _id: { g: "$grade", s: "$section" }, n: { $sum: 1 } } }]),
      ]);
      const by = new Map();
      for (const c of counts) {
        const g = c._id.g || "(no class)";
        const e = by.get(g) ?? { grade: g, students: 0, sections: {} };
        e.students += c.n;
        if (c._id.s) e.sections[c._id.s] = c.n;
        by.set(g, e);
      }
      const rows = [...by.values()].sort((a, b) => list.compareGrades(a.grade, b.grade));
      return { classes: rows, totalActiveStudents: rows.reduce((t, r) => t + r.students, 0) };
    },
  },
  {
    name: "find_students",
    roles: null,
    description: "Find students by name, admission number or guardian phone, and/or list a class. Returns ids to use with student_details.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, admission number or phone (optional)" },
        grade: { type: "string", description: "Exact class name, e.g. \"5\" (optional)" },
        section: { type: "string", description: "Section, e.g. \"A\" (optional)" },
        includeInactive: { type: "boolean", description: "Also students who left (default false)" },
      },
    },
    async run(ctx, a) {
      const filter = { tenantId: ctx.tenantId, ...(a.includeInactive ? {} : { status: "active" }) };
      if (a.grade) filter.grade = a.grade;
      if (a.section) filter.section = a.section;
      if (a.query) {
        const re = new RegExp(String(a.query).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ firstName: re }, { lastName: re }, { admissionNo: re }, { guardianName: re }, { guardianPhone: re }];
      }
      const total = await Student.countDocuments(filter);
      const list = await Student.find(filter, { firstName: 1, lastName: 1, admissionNo: 1, grade: 1, section: 1, rollNo: 1, guardianName: 1, status: 1 })
        .collation({ locale: "en", numericOrdering: true })
        .sort({ grade: 1, section: 1, rollNo: 1, firstName: 1 })
        .limit(MAX_ROWS)
        .lean();
      return {
        total,
        shown: list.length,
        students: list.map((s) => ({ id: String(s._id), name: fullName(s), admissionNo: s.admissionNo, class: cls(s.grade, s.section), rollNo: s.rollNo || "", guardian: s.guardianName || "", status: s.status, link: studentLink(s._id) })),
      };
    },
  },
  {
    name: "student_details",
    roles: null,
    description: "One student's profile, this month's attendance and fee position (what the user's role may see).",
    parameters: { type: "object", properties: { studentId: { type: "string", description: "Id from find_students" } }, required: ["studentId"] },
    async run(ctx, a) {
      if (!mongoose.isValidObjectId(a.studentId)) throw new ToolError("Unknown student id. Use find_students first.");
      const s = await Student.findOne({ _id: a.studentId, tenantId: ctx.tenantId }).lean();
      if (!s) throw new ToolError("Student not found.");
      const out = {
        id: String(s._id),
        name: fullName(s),
        admissionNo: s.admissionNo,
        class: cls(s.grade, s.section),
        rollNo: s.rollNo || "",
        status: s.status,
        guardian: s.guardianName || "",
        link: studentLink(s._id),
      };
      if (TEACHING_ROLES.includes(ctx.role) && canTeachClass(ctx.scope, s.grade, s.section)) {
        const h = await studentHistory(ctx.tenantId, s._id, { from: monthStart(ctx.today), to: ctx.today });
        out.attendanceThisMonth = h.summary;
        out.absentDays = h.records.filter((r) => r.status === "absent").map((r) => r.date);
      }
      if (FEE_ROLES.includes(ctx.role)) {
        const l = await studentLedger(ctx.tenantId, s._id, { today: ctx.today });
        out.fees = {
          totalFee: rupees(l.totals.billed - l.totals.discount),
          paid: rupees(l.totals.paid),
          balance: rupees(l.totals.balance),
          overdue: rupees(l.totals.overdue),
          advance: rupees(l.totals.advance),
          concession: l.student.concession?.label ?? null,
          link: feeLink(s._id),
        };
      }
      return out;
    },
  },
  {
    name: "attendance_today",
    roles: TEACHING_ROLES,
    description: "Today's attendance by class: which classes are marked, present/absent counts and rate.",
    parameters: { type: "object", properties: {} },
    async run(ctx) {
      const r = await listClasses(ctx.tenantId, { date: ctx.today });
      const classes = r.classes.filter((c) => canTeachClass(ctx.scope, c.grade, c.section));
      return {
        date: ctx.today,
        classes: classes.map((c) => ({ class: cls(c.grade, c.section), students: c.students, marked: c.marked, ...c.counts, ratePercent: c.rate })),
        notMarkedYet: classes.filter((c) => c.marked === 0).map((c) => cls(c.grade, c.section)),
      };
    },
  },
  {
    name: "attendance_report",
    roles: TEACHING_ROLES,
    description: "Attendance per student over a date range (default: this month), for one class or the whole school. Use belowPercent to list students under a rate (e.g. 75).",
    parameters: {
      type: "object",
      properties: {
        grade: { type: "string", description: "Class name (optional; whole school if left out)" },
        section: { type: "string", description: "Section (optional)" },
        from: { type: "string", description: "YYYY-MM-DD (default: first of this month)" },
        to: { type: "string", description: "YYYY-MM-DD (default: today)" },
        belowPercent: { type: "number", description: "Only students whose attendance rate is below this" },
      },
    },
    async run(ctx, a) {
      const { from, to } = rangeOf(a, ctx.today);
      let rows;
      if (a.grade) {
        assertClass(ctx, a.grade, a.section);
        const r = await classReport(ctx.tenantId, { grade: a.grade, section: a.section ?? "", from, to });
        rows = r.students.map((x) => ({ id: x.student.id, name: x.student.fullName, class: cls(a.grade, a.section), ...x.counts, ratePercent: x.rate }));
      } else {
        const scoped = classFilter(ctx.scope);
        const match = { tenantId: ctx.oid, date: { $gte: from, $lte: to }, ...(scoped ?? {}) };
        const agg = await Attendance.aggregate([{ $match: match }, { $group: { _id: "$studentId", present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } }, late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } }, absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } }, leave: { $sum: { $cond: [{ $eq: ["$status", "leave"] }, 1, 0] } } } }]);
        const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: agg.map((x) => x._id) } }, { firstName: 1, lastName: 1, grade: 1, section: 1 }).lean();
        const byId = new Map(students.map((s) => [String(s._id), s]));
        rows = agg
          .map((x) => {
            const s = byId.get(String(x._id));
            const counted = x.present + x.late + x.absent;
            return s && { id: String(x._id), name: fullName(s), class: cls(s.grade, s.section), present: x.present, late: x.late, absent: x.absent, leave: x.leave, ratePercent: counted ? Math.round(((x.present + x.late) / counted) * 1000) / 10 : null };
          })
          .filter(Boolean);
      }
      if (typeof a.belowPercent === "number") rows = rows.filter((r) => r.ratePercent !== null && r.ratePercent < a.belowPercent);
      rows.sort((x, y) => (x.ratePercent ?? 101) - (y.ratePercent ?? 101));
      return { from, to, total: rows.length, shown: Math.min(rows.length, MAX_ROWS), students: rows.slice(0, MAX_ROWS).map((r) => ({ ...r, link: studentLink(r.id) })) };
    },
  },
  {
    name: "fee_dues",
    roles: FEE_ROLES,
    description: "Students who owe fees, largest balance first, optionally one class or only overdue. Amounts in rupees.",
    parameters: {
      type: "object",
      properties: {
        grade: { type: "string", description: "Class name (optional)" },
        section: { type: "string", description: "Section (optional)" },
        overdueOnly: { type: "boolean", description: "Only students with overdue dues" },
      },
    },
    async run(ctx, a) {
      const r = await feeRegister(ctx.tenantId, { page: 1, limit: MAX_ROWS, grade: a.grade || undefined, section: a.section || undefined, status: a.overdueOnly ? "overdue" : "due", sort: a.overdueOnly ? "overdue" : "balance", today: ctx.today });
      return {
        total: r.pagination.total,
        shown: r.students.length,
        totals: { balance: rupees(r.totals.balance), overdue: rupees(r.totals.overdue) },
        students: r.students.map((s) => ({ id: s.id, name: s.fullName, class: cls(s.grade, s.section), balance: rupees(s.balance), overdue: rupees(s.overdue), nextDue: s.nextDue, link: feeLink(s.id) })),
      };
    },
  },
  {
    name: "fee_collections",
    roles: FEE_ROLES,
    description: "Fees collected over a date range (default: this month) by payment mode, plus the school's total dues and overdue. Amounts in rupees.",
    parameters: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } } },
    async run(ctx, a) {
      const { from, to } = rangeOf(a, ctx.today);
      const s = await feeSummary(ctx.tenantId, { from, to, today: ctx.today });
      return {
        from,
        to,
        collected: rupees(s.collected.amount),
        receipts: s.collected.count,
        byMode: s.byMode.map((m) => ({ mode: m.mode, amount: rupees(m.amount), receipts: m.count })),
        allDues: { balance: rupees(s.dues.balance), overdue: rupees(s.dues.overdue), overdueStudents: s.dues.overdueStudents, collectionRatePercent: s.dues.collectionRate },
        dueInNext30Days: rupees(s.upcoming.amount),
      };
    },
  },
  {
    name: "student_receipts",
    roles: FEE_ROLES,
    description:
      "A student's fee receipts (latest first) with receipt number, date, amount and mode, and a link that opens the receipt to print or send. Give the student's name or admission number directly (no need for find_students).",
    parameters: {
      type: "object",
      properties: {
        student: { type: "string", description: "Name or admission number" },
        limit: { type: "integer", description: "How many receipts (default 5)" },
      },
      required: ["student"],
    },
    async run(ctx, a) {
      const words = String(a.student ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 4);
      if (!words.length) throw new ToolError("Which student?");
      const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const students = await Student.find(
        { tenantId: ctx.tenantId, $and: words.map((w) => ({ $or: [{ firstName: new RegExp(`^${esc(w)}`, "i") }, { lastName: new RegExp(`^${esc(w)}`, "i") }, { admissionNo: new RegExp(`^${esc(w)}$`, "i") }] })) },
        { firstName: 1, lastName: 1, grade: 1, section: 1, admissionNo: 1 }
      )
        .limit(6)
        .lean();
      if (!students.length) throw new ToolError(`No student matching "${a.student}" in this school.`);
      const limit = Math.min(Math.max(Number(a.limit) || 5, 1), 20);
      const payments = await Payment.find({ tenantId: ctx.tenantId, studentId: { $in: students.map((s) => s._id) } }, { receiptNo: 1, studentId: 1, date: 1, amount: 1, mode: 1, kind: 1, voided: 1, createdAt: 1 })
        .sort({ date: -1, createdAt: -1 })
        .limit(limit * students.length)
        .lean();
      return {
        ...(students.length > 1 ? { note: `${students.length} students match; receipts for each are listed. Ask the user which one if it matters.` } : {}),
        students: students.map((s) => ({
          name: fullName(s),
          class: cls(s.grade, s.section),
          admissionNo: s.admissionNo,
          feeAccountLink: feeLink(s._id),
          receipts: payments
            .filter((p) => String(p.studentId) === String(s._id))
            .slice(0, limit)
            .map((p) => ({
              receiptNo: p.receiptNo,
              date: p.date,
              amount: rupees(p.amount),
              mode: p.mode,
              ...(p.kind === "opening" ? { paidBeforeJoining: true } : {}),
              ...(p.voided?.at ? { voided: true } : {}),
              link: receiptLink(p._id),
            })),
        })),
      };
    },
  },
  {
    name: "test_results",
    roles: TEACHING_ROLES,
    description: "Results of a test: class average, pass rate, top students and who failed or was absent. Picks the most recent test matching the name and class.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Part of the test name, e.g. \"half-yearly\" (optional)" },
        grade: { type: "string", description: "Class name (optional)" },
        section: { type: "string", description: "Section (optional)" },
        top: { type: "integer", description: "How many top students to list (default 5)" },
      },
    },
    async run(ctx, a) {
      const list = await listExams(ctx.tenantId, { page: 1, limit: 10, grade: a.grade || undefined, section: a.section || undefined, search: a.name || undefined }, ctx.user);
      const allowed = list.exams.filter((e) => canTeachClass(ctx.scope, e.grade, e.section));
      if (!allowed.length) return { found: false, message: "No matching test." };
      const view = await getExam(ctx.tenantId, allowed[0].id, ctx.user);
      const done = view.students.filter((r) => r.result.status !== "pending");
      const top = Math.min(Math.max(Number(a.top) || 5, 1), 15);
      return {
        test: { name: view.exam.name, class: cls(view.exam.grade, view.exam.section), date: view.exam.date, maxTotal: view.exam.maxTotal, subjects: view.exam.subjects.map((s) => s.name) },
        otherMatchingTests: allowed.slice(1, 5).map((e) => ({ name: e.name, class: cls(e.grade, e.section), date: e.date })),
        stats: view.stats,
        top: done
          .filter((r) => r.result.rank)
          .sort((x, y) => x.result.rank - y.result.rank)
          .slice(0, top)
          .map((r) => ({ rank: r.result.rank, name: r.student.fullName, percent: r.result.percent, grade: r.result.grade, link: studentLink(r.student.id) })),
        failed: done.filter((r) => r.result.status === "fail").slice(0, MAX_ROWS).map((r) => ({ name: r.student.fullName, percent: r.result.percent, link: studentLink(r.student.id) })),
        absent: done.filter((r) => r.result.status === "absent").map((r) => r.student.fullName),
        marksMissing: view.students.filter((r) => r.result.status === "pending").length,
      };
    },
  },
  {
    name: "leaderboard",
    roles: TEACHING_ROLES,
    description: "Top students by overall score (test marks and attendance) over a period (default: this month), for the school or one class.",
    parameters: {
      type: "object",
      properties: {
        grade: { type: "string" },
        section: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        top: { type: "integer", description: "Default 10" },
      },
    },
    async run(ctx, a) {
      const { from, to } = rangeOf(a, ctx.today);
      if (a.grade) assertClass(ctx, a.grade, a.section);
      else if (ctx.scope.limited) throw new ToolError("Give a class you teach.");
      const r = await leaderboard(ctx.tenantId, { from, to, grade: a.grade || undefined, section: a.section || undefined });
      const rows = (r.students ?? r.rows ?? []).filter((x) => x.rank?.overall).sort((x, y) => x.rank.overall - y.rank.overall);
      const top = Math.min(Math.max(Number(a.top) || 10, 1), 20);
      return {
        from,
        to,
        students: rows.slice(0, top).map((x) => ({ rank: x.rank.overall, name: x.fullName, class: cls(x.grade, x.section), score: x.score, marksPercent: x.marks?.average ?? null, attendancePercent: x.attendance?.rate ?? null, change: x.change, link: studentLink(x.id) })),
      };
    },
  },
];

/** The tools this member may use (declarations for Gemini, and runners by name); `extra` adds more (the prepare_* actions). */
export async function toolsFor(user, extra = []) {
  const scope = await teacherScope(user);
  const available = [...TOOLS, ...extra].filter((t) => !t.roles || t.roles.includes(user.role));
  const ctx = { tenantId: user.tenantId, oid: new mongoose.Types.ObjectId(String(user.tenantId)), user, role: user.role, scope, today: indiaToday() };
  return {
    declarations: available.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })),
    async run(name, args) {
      const tool = available.find((t) => t.name === name);
      if (!tool) return { error: `The tool ${name} isn't available for your role.` };
      try {
        return await tool.run(ctx, args ?? {});
      } catch (err) {
        // Tool problems go back to the model as data; anything else is a real error
        if (err instanceof ToolError || err?.status === 403 || err?.status === 404 || err?.status === 400) return { error: err.message };
        throw err;
      }
    },
  };
}
