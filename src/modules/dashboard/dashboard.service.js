import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Exam from "../../models/Exam.js";
import ExamResult from "../../models/ExamResult.js";
import Student from "../../models/Student.js";
import { ROLES } from "../../models/Membership.js";
import { listClasses } from "../attendance/attendance.service.js";
import { summary as feeSummary } from "../fees/fees.service.js";
import CorrectionRequest from "../../models/CorrectionRequest.js";
import Homework from "../../models/Homework.js";
import Notice from "../../models/Notice.js";
import StudentLeave from "../../models/StudentLeave.js";
import { canTeachClass, classFilter, teacherScope } from "../teaching/teaching.scope.js";
import { mine as myClasses } from "../teaching/teaching.service.js";
import { periodsFor } from "../classroom/timetable.js";

const DAY_MS = 86_400_000;
/** Days of attendance shown in the trend. */
export const TREND_DAYS = 14;
const ABSENT_LIST_LIMIT = 8;
const RECENT_TESTS = 5;

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");

/** Same rule as the attendance module: leave doesn't count against the rate. */
function rate({ present = 0, late = 0, absent = 0 }) {
  const counted = present + late + absent;
  return counted === 0 ? null : Math.round(((present + late) / counted) * 1000) / 10;
}

async function studentStats(tenantId, monthStart, scoped) {
  const [byStatus, newThisMonth] = await Promise.all([
    Student.aggregate([{ $match: { tenantId: oid(tenantId), ...(scoped ?? {}) } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Student.countDocuments({ tenantId, createdAt: { $gte: new Date(`${monthStart}T00:00:00Z`) }, ...(scoped ?? {}) }),
  ]);
  const count = (s) => byStatus.find((x) => x._id === s)?.count ?? 0;
  return { active: count("active"), total: byStatus.reduce((n, x) => n + x.count, 0), newThisMonth };
}

async function attendanceStats(tenantId, date, scope) {
  const from = addDays(date, -(TREND_DAYS - 1));
  const scoped = classFilter(scope) ?? {};
  const [all, byDay, absentRecords] = await Promise.all([
    listClasses(tenantId, { date }),
    Attendance.aggregate([
      { $match: { tenantId: oid(tenantId), date: { $gte: from, $lte: date }, ...scoped } },
      { $group: { _id: { date: "$date", status: "$status" }, count: { $sum: 1 } } },
    ]),
    Attendance.find({ tenantId, date, status: "absent", ...scoped }, { studentId: 1, grade: 1, section: 1 }).limit(50).lean(),
  ]);
  // A teacher's dashboard covers their own classes
  const today = { ...all, classes: all.classes.filter((c) => canTeachClass(scope, c.grade, c.section)) };

  const counts = { present: 0, absent: 0, late: 0, leave: 0 };
  for (const c of today.classes) for (const k of Object.keys(counts)) counts[k] += c.counts[k];

  // One point per calendar day; days nobody marked (weekends, holidays) have rate null
  const perDay = new Map();
  for (const row of byDay) {
    const d = perDay.get(row._id.date) ?? {};
    d[row._id.status] = row.count;
    perDay.set(row._id.date, d);
  }
  const trend = Array.from({ length: TREND_DAYS }, (_, i) => {
    const d = addDays(from, i);
    const c = perDay.get(d) ?? {};
    return { date: d, rate: rate(c), marked: (c.present ?? 0) + (c.absent ?? 0) + (c.late ?? 0) + (c.leave ?? 0) };
  });

  const students = absentRecords.length
    ? await Student.find({ tenantId, _id: { $in: absentRecords.map((r) => r.studentId) } }, { firstName: 1, lastName: 1, guardianPhone: 1 }).lean()
    : [];
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const absent = absentRecords
    .map((r) => {
      const s = byId.get(String(r.studentId));
      return s && { id: String(s._id), fullName: fullName(s), grade: r.grade, section: r.section || "", hasPhone: Boolean(s.guardianPhone) };
    })
    .filter(Boolean)
    .sort((a, b) => a.grade.localeCompare(b.grade, "en", { numeric: true }) || a.section.localeCompare(b.section) || a.fullName.localeCompare(b.fullName));

  const classes = today.classes.filter((c) => c.students > 0);
  return {
    date,
    counts,
    rate: rate(counts),
    classes: classes.map(({ grade, section, students: n, marked, rate: r }) => ({ grade, section, students: n, marked, rate: r })),
    classesMarked: classes.filter((c) => c.marked > 0).length,
    classesTotal: classes.length,
    absent: absent.slice(0, ABSENT_LIST_LIMIT),
    absentTotal: absent.length,
    trend,
  };
}

async function testStats(tenantId, scope) {
  const scoped = classFilter(scope);
  const examScope = scoped ? { $or: scoped.$or.map((c) => (c.section ? { grade: c.grade, section: { $in: ["", c.section] } } : { grade: c.grade })) } : {};
  const exams = await Exam.find({ tenantId, ...examScope }, { name: 1, grade: 1, section: 1, date: 1, subjects: 1 })
    .sort({ date: -1, createdAt: -1 })
    .limit(RECENT_TESTS)
    .lean();
  if (!exams.length) return { recent: [] };

  const [marked, ...classSizes] = await Promise.all([
    // A student counts as marked once any subject has marks or is marked absent
    ExamResult.aggregate([
      { $match: { tenantId: oid(tenantId), examId: { $in: exams.map((e) => e._id) } } },
      { $match: { marks: { $elemMatch: { $or: [{ marks: { $ne: null } }, { absent: true }] } } } },
      { $group: { _id: "$examId", count: { $sum: 1 } } },
    ]),
    ...exams.map((e) => Student.countDocuments({ tenantId, status: "active", grade: e.grade, ...(e.section ? { section: e.section } : {}) })),
  ]);

  return {
    recent: exams.map((e, i) => ({
      id: String(e._id),
      name: e.name,
      grade: e.grade,
      section: e.section || "",
      date: e.date,
      subjects: e.subjects.length,
      marked: marked.find((m) => String(m._id) === String(e._id))?.count ?? 0,
      students: classSizes[i],
    })),
  };
}

async function feeStats(tenantId, date, monthStart) {
  const s = await feeSummary(tenantId, { from: monthStart, to: date, today: date });
  return {
    collectedToday: s.byDay.find((d) => d.date === date)?.amount ?? 0,
    collectedMonth: s.collected,
    outstanding: s.dues.balance,
    overdue: s.dues.overdue,
    overdueStudents: s.dues.overdueStudents,
    collectionRate: s.dues.collectionRate,
    upcoming: s.upcoming,
    recent: s.recent.slice(0, 5),
  };
}

/** Birthdays today and in the next 6 days among active students (in scope). */
async function birthdays(tenantId, date, scoped) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(date, i));
  const students = await Student.find(
    {
      tenantId,
      status: "active",
      ...(scoped ?? {}),
      $expr: { $in: [{ $dateToString: { format: "%m-%d", date: "$dateOfBirth" } }, days.map((d) => d.slice(5))] },
    },
    { firstName: 1, lastName: 1, grade: 1, section: 1, dateOfBirth: 1 }
  ).lean();
  return students
    .map((s) => {
      const md = s.dateOfBirth.toISOString().slice(5, 10);
      const on = days.find((d) => d.slice(5) === md);
      return { id: String(s._id), fullName: fullName(s), grade: s.grade || "", section: s.section || "", date: on, age: Number(on.slice(0, 4)) - s.dateOfBirth.getUTCFullYear(), today: on === date };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.fullName.localeCompare(b.fullName));
}

/** Leave covering today, in scope. */
async function leavesToday(tenantId, date, scoped) {
  const leaves = await StudentLeave.find({ tenantId, from: { $lte: date }, to: { $gte: date } }, { studentId: 1, reason: 1, to: 1 }).lean();
  if (!leaves.length) return [];
  const students = await Student.find({ tenantId, _id: { $in: leaves.map((l) => l.studentId) }, status: "active", ...(scoped ?? {}) }, { firstName: 1, lastName: 1, grade: 1, section: 1 }).lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));
  return leaves
    .filter((l) => byId.has(String(l.studentId)))
    .map((l) => {
      const s = byId.get(String(l.studentId));
      return { id: String(l._id), studentId: String(s._id), fullName: fullName(s), grade: s.grade || "", section: s.section || "", reason: l.reason || "", until: l.to };
    });
}

async function noticeStats(tenantId, userId) {
  const [latest, unread] = await Promise.all([
    Notice.find({ tenantId }, { title: 1, audience: 1, createdAt: 1, createdByName: 1, pinned: 1, readBy: 1 }).sort({ pinned: -1, createdAt: -1 }).limit(3).lean(),
    Notice.countDocuments({ tenantId, audience: "staff", readBy: { $ne: oid(userId) } }),
  ]);
  return {
    unread,
    latest: latest.map((n) => ({ id: String(n._id), title: n.title, audience: n.audience, pinned: n.pinned, createdAt: n.createdAt, createdByName: n.createdByName || "", read: (n.readBy ?? []).some((id) => String(id) === String(userId)) })),
  };
}

/**
 * One call for the home screen. Sections a role can't see are left out (null): teachers get
 * no money, accountants no attendance or tests. A teacher with assigned classes sees only
 * those classes ("My day"): their attendance, tests, birthdays and leave, plus today's periods.
 */
export async function overview(tenantId, user, { date }) {
  const role = user.role;
  const monthStart = `${date.slice(0, 7)}-01`;
  const seesFees = role !== ROLES.TEACHER;
  const seesTeaching = role !== ROLES.ACCOUNTANT;
  const scope = await teacherScope(user);
  const scoped = classFilter(scope);
  // Weekday of the browser's date: 1 = Monday … 7 = Sunday
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

  const [students, attendance, tests, fees, mine, periods, notices, bdays, leaves, homeworkToday, corrections] = await Promise.all([
    studentStats(tenantId, monthStart, scoped),
    seesTeaching ? attendanceStats(tenantId, date, scope) : null,
    seesTeaching ? testStats(tenantId, scope) : null,
    seesFees ? feeStats(tenantId, date, monthStart) : null,
    role === ROLES.TEACHER ? myClasses(user) : null,
    seesTeaching ? periodsFor(tenantId, user.id, weekday) : [],
    noticeStats(tenantId, user.id),
    seesTeaching ? birthdays(tenantId, date, scoped) : [],
    seesTeaching ? leavesToday(tenantId, date, scoped) : [],
    seesTeaching ? Homework.countDocuments({ tenantId, date, ...(role === ROLES.TEACHER ? { createdBy: user.id } : {}) }) : 0,
    role === ROLES.OWNER || role === ROLES.ADMIN ? CorrectionRequest.countDocuments({ tenantId, status: "open" }) : 0,
  ]);
  return {
    date,
    scope: { limited: scope.limited, classes: mine?.classes ?? [] },
    students,
    attendance,
    tests,
    fees,
    today: { periods, birthdays: bdays, leaves, homeworkPosted: homeworkToday },
    notices,
    corrections,
  };
}
