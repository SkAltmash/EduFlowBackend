import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Exam from "../../models/Exam.js";
import ExamResult from "../../models/ExamResult.js";
import Student from "../../models/Student.js";
import { ROLES } from "../../models/Membership.js";
import { listClasses } from "../attendance/attendance.service.js";
import { summary as feeSummary } from "../fees/fees.service.js";

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

async function studentStats(tenantId, monthStart) {
  const [byStatus, newThisMonth] = await Promise.all([
    Student.aggregate([{ $match: { tenantId: oid(tenantId) } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Student.countDocuments({ tenantId, createdAt: { $gte: new Date(`${monthStart}T00:00:00Z`) } }),
  ]);
  const count = (s) => byStatus.find((x) => x._id === s)?.count ?? 0;
  return { active: count("active"), total: byStatus.reduce((n, x) => n + x.count, 0), newThisMonth };
}

async function attendanceStats(tenantId, date) {
  const from = addDays(date, -(TREND_DAYS - 1));
  const [today, byDay, absentRecords] = await Promise.all([
    listClasses(tenantId, { date }),
    Attendance.aggregate([
      { $match: { tenantId: oid(tenantId), date: { $gte: from, $lte: date } } },
      { $group: { _id: { date: "$date", status: "$status" }, count: { $sum: 1 } } },
    ]),
    Attendance.find({ tenantId, date, status: "absent" }, { studentId: 1, grade: 1, section: 1 }).limit(50).lean(),
  ]);

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

async function testStats(tenantId) {
  const exams = await Exam.find({ tenantId }, { name: 1, grade: 1, section: 1, date: 1, subjects: 1 })
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

/**
 * One call for the home screen. Sections a role can't open elsewhere are left out
 * (null): teachers get no money, accountants no attendance or tests.
 */
export async function overview(tenantId, role, { date }) {
  const monthStart = `${date.slice(0, 7)}-01`;
  const seesFees = role !== ROLES.TEACHER;
  const seesTests = role !== ROLES.ACCOUNTANT;
  const seesAttendance = role !== ROLES.ACCOUNTANT;

  const [students, attendance, tests, fees] = await Promise.all([
    studentStats(tenantId, monthStart),
    seesAttendance ? attendanceStats(tenantId, date) : null,
    seesTests ? testStats(tenantId) : null,
    seesFees ? feeStats(tenantId, date, monthStart) : null,
  ]);
  return { date, students, attendance, tests, fees };
}
