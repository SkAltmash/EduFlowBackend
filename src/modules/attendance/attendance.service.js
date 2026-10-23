import mongoose from "mongoose";
import Attendance, { ATTENDANCE_STATUSES } from "../../models/Attendance.js";
import Student from "../../models/Student.js";
import { ROLES } from "../../models/Membership.js";
import AppError from "../../utils/AppError.js";

// Natural ordering: "Grade 2" < "Grade 10", roll "9" < "10"
const COLLATION = { locale: "en", numericOrdering: true };

/** Teachers may mark or correct the last N days; owners and admins any past day. */
export const TEACHER_EDIT_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const naturalCompare = (a, b) => a.localeCompare(b, "en", { numeric: true });
const emptyCounts = () => Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, 0]));

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Latest calendar day anywhere on Earth right now (UTC+14). The server doesn't
 * know the school's time zone, so "today" for the school is at most this.
 */
function latestToday() {
  return new Date(Date.now() + 14 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Attendance rate ignores approved leave: (present + late) / (present + late + absent). */
function rate(counts) {
  const counted = counts.present + counts.late + counts.absent;
  return counted === 0 ? null : Math.round(((counts.present + counts.late) / counted) * 1000) / 10;
}

/** Whether `role` may change marks for `date`, and why not. */
export function editPermission(role, date) {
  if (role === ROLES.ACCOUNTANT) return { canEdit: false, reason: "Accountants can view attendance but not mark it." };
  if (date > latestToday()) return { canEdit: false, reason: "Attendance can't be marked for a future date." };
  if (role === ROLES.TEACHER && date < addDays(latestToday(), -(TEACHER_EDIT_WINDOW_DAYS + 1))) {
    return {
      canEdit: false,
      reason: `Teachers can only change the last ${TEACHER_EDIT_WINDOW_DAYS} days. Ask an admin to correct older records.`,
    };
  }
  return { canEdit: true, reason: null };
}

function serializeStudentRow(s) {
  return {
    id: String(s._id),
    admissionNo: s.admissionNo,
    fullName: [s.firstName, s.lastName].filter(Boolean).join(" "),
    rollNo: s.rollNo || "",
    status: s.status,
  };
}

function sortByRoll(rows) {
  return rows.sort((a, b) => naturalCompare(a.rollNo || "~", b.rollNo || "~") || naturalCompare(a.fullName, b.fullName));
}

// ---------------------------------------------------------------------------
// Day overview
// ---------------------------------------------------------------------------

/**
 * Every class with active students, plus how much of it is marked on `date`.
 * A class's `students` counts its current active students plus anyone marked in it
 * that day (e.g. moved class since), matching what the register shows.
 */
export async function listClasses(tenantId, { date }) {
  const [students, records] = await Promise.all([
    Student.find({ tenantId, status: "active" }, { grade: 1, section: 1 }).lean(),
    Attendance.find({ tenantId, date }, { studentId: 1, grade: 1, section: 1, status: 1 }).lean(),
  ]);

  const classes = new Map();
  const get = (grade, section) => {
    const k = `${grade}\u0000${section}`;
    if (!classes.has(k)) classes.set(k, { grade, section, ids: new Set(), marked: 0, counts: emptyCounts() });
    return classes.get(k);
  };

  let unassigned = 0;
  for (const st of students) {
    if (!st.grade) unassigned += 1;
    else get(st.grade, st.section || "").ids.add(String(st._id));
  }
  for (const r of records) {
    const c = get(r.grade, r.section || "");
    c.ids.add(String(r.studentId));
    c.counts[r.status] += 1;
    c.marked += 1;
  }

  return {
    date,
    classes: [...classes.values()]
      .map(({ ids, ...c }) => ({ ...c, students: ids.size, rate: rate(c.counts) }))
      .sort((a, b) => naturalCompare(a.grade, b.grade) || naturalCompare(a.section, b.section)),
    // Active students without a class can't appear in any register
    unassigned,
  };
}

// ---------------------------------------------------------------------------
// Register (one class, one day)
// ---------------------------------------------------------------------------

export async function getRegister(tenantId, role, { date, grade, section }) {
  const [students, records] = await Promise.all([
    Student.find({ tenantId, status: "active", grade, section }).collation(COLLATION).lean(),
    Attendance.find({ tenantId, date, grade, section }).populate("markedBy", "name").lean(),
  ]);

  const recordByStudent = new Map(records.map((r) => [String(r.studentId), r]));
  const listed = new Set(students.map((s) => String(s._id)));

  // Students marked in this class that day but since moved class or left
  const missingIds = records.map((r) => r.studentId).filter((id) => !listed.has(String(id)));
  const former = missingIds.length
    ? await Student.find({ tenantId, _id: { $in: missingIds } }).lean()
    : [];

  const rows = sortByRoll(
    [...students.map((s) => ({ ...serializeStudentRow(s), current: true })), ...former.map((s) => ({ ...serializeStudentRow(s), current: false }))]
  ).map((row) => {
    const r = recordByStudent.get(row.id);
    return { ...row, attendance: r ? { status: r.status, note: r.note || "" } : null };
  });

  const counts = emptyCounts();
  for (const r of records) counts[r.status] += 1;

  const last = records.reduce((latest, r) => (!latest || r.updatedAt > latest.updatedAt ? r : latest), null);

  return {
    date,
    grade,
    section,
    students: rows,
    summary: { total: rows.length, marked: records.length, unmarked: rows.length - records.length, ...counts, rate: rate(counts) },
    lastMarked: last ? { at: last.updatedAt, by: last.markedBy?.name ?? null } : null,
    ...editPermission(role, date),
    teacherEditWindowDays: TEACHER_EDIT_WINDOW_DAYS,
  };
}

export async function saveRegister(tenantId, user, { date, grade, section, entries }) {
  const permission = editPermission(user.role, date);
  if (!permission.canEdit) throw AppError.forbidden(permission.reason, "ATTENDANCE_LOCKED");

  const ids = entries.map((e) => e.studentId);
  const [students, existing] = await Promise.all([
    Student.find({ tenantId, _id: { $in: ids } }, { grade: 1, section: 1 }).lean(),
    Attendance.find({ tenantId, date, studentId: { $in: ids } }, { studentId: 1, grade: 1, section: 1 }).lean(),
  ]);

  const studentById = new Map(students.map((s) => [String(s._id), s]));
  const existingById = new Map(existing.map((r) => [String(r.studentId), r]));

  // A student belongs in this register if they're in the class now, or were marked in it that day
  const invalid = entries.filter(({ studentId }) => {
    const s = studentById.get(studentId);
    if (!s) return true;
    const inClass = s.grade === grade && (s.section || "") === section;
    const r = existingById.get(studentId);
    return !inClass && !(r && r.grade === grade && r.section === section);
  });
  if (invalid.length) {
    throw AppError.badRequest(
      `${invalid.length} student(s) are not in class ${section ? `${grade} - ${section}` : grade}. Refresh and try again.`,
      "STUDENT_NOT_IN_CLASS",
      invalid.map((e) => ({ field: "studentId", message: e.studentId }))
    );
  }

  await Attendance.bulkWrite(
    entries.map(({ studentId, status, note }) => ({
      updateOne: {
        filter: { tenantId: oid(tenantId), studentId: oid(studentId), date },
        update: {
          $set: { status, grade, section, markedBy: oid(user.id), ...(note !== undefined ? { note } : {}) },
          $setOnInsert: { tenantId: oid(tenantId), studentId: oid(studentId), date },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  return getRegister(tenantId, user.role, { date, grade, section });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Per-student totals for a class over a date range, plus the day-by-day grid. */
export async function classReport(tenantId, { grade, section, from, to }) {
  const records = await Attendance.find(
    { tenantId, grade, section, date: { $gte: from, $lte: to } },
    { studentId: 1, date: 1, status: 1 }
  ).lean();

  const ids = [...new Set(records.map((r) => String(r.studentId)))];
  const [current, others] = await Promise.all([
    Student.find({ tenantId, status: "active", grade, section }).lean(),
    Student.find({ tenantId, _id: { $in: ids } }).lean(),
  ]);
  const studentsById = new Map([...current, ...others].map((s) => [String(s._id), s]));

  const rows = new Map();
  for (const s of studentsById.values()) {
    rows.set(String(s._id), { student: serializeStudentRow(s), counts: emptyCounts(), days: {} });
  }
  for (const r of records) {
    const row = rows.get(String(r.studentId));
    if (!row) continue; // student was deleted
    row.counts[r.status] += 1;
    row.days[r.date] = r.status;
  }

  const dates = [...new Set(records.map((r) => r.date))].sort();
  const totals = emptyCounts();
  for (const r of records) totals[r.status] += 1;

  return {
    grade,
    section,
    from,
    to,
    dates,
    students: [...rows.values()]
      .map((r) => ({ ...r, marked: Object.keys(r.days).length, rate: rate(r.counts) }))
      .sort((a, b) => naturalCompare(a.student.rollNo || "~", b.student.rollNo || "~") || naturalCompare(a.student.fullName, b.student.fullName)),
    summary: { days: dates.length, ...totals, rate: rate(totals) },
  };
}

/** One student's marks and totals over a date range. */
export async function studentHistory(tenantId, studentId, { from, to }) {
  if (!(await Student.exists({ _id: studentId, tenantId }))) throw AppError.notFound("Student not found");

  const records = await Attendance.find(
    { tenantId, studentId, date: { $gte: from, $lte: to } },
    { date: 1, status: 1, note: 1, grade: 1, section: 1 }
  )
    .sort({ date: 1 })
    .lean();

  const counts = emptyCounts();
  for (const r of records) counts[r.status] += 1;

  return {
    from,
    to,
    records: records.map((r) => ({ date: r.date, status: r.status, note: r.note || "", grade: r.grade, section: r.section })),
    summary: { marked: records.length, ...counts, rate: rate(counts) },
  };
}
