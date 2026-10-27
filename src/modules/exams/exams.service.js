import mongoose from "mongoose";
import Exam from "../../models/Exam.js";
import ExamResult from "../../models/ExamResult.js";
import SchoolSettings from "../../models/SchoolSettings.js";
import Student from "../../models/Student.js";
import Attendance from "../../models/Attendance.js";
import Tenant from "../../models/Tenant.js";
import AppError from "../../utils/AppError.js";
import { loadClassList } from "../academics/class-names.js";
import { assertTeachesClass, canMarkSubject, classFilter, markableSubjects, teacherScope } from "../teaching/teaching.scope.js";
import { DEFAULT_GRADING, SCALES, assignRanks, classStats, computeResult, letterGrade } from "./exams.grading.js";

const COLLATION = { locale: "en", numericOrdering: true };
const naturalCompare = (a, b) => (a ?? "").localeCompare(b ?? "", "en", { numeric: true });
const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
const round1 = (n) => Math.round(n * 10) / 10;
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getGrading(tenantId) {
  const s = await SchoolSettings.findOne({ tenantId }).lean();
  return { ...DEFAULT_GRADING, ...(s?.grading ?? {}) };
}

export async function getSettings(tenantId) {
  const grading = await getGrading(tenantId);
  return { grading, scales: SCALES };
}

export async function updateSettings(tenantId, userId, grading) {
  const set = Object.fromEntries(Object.entries(grading).map(([k, v]) => [`grading.${k}`, v]));
  await SchoolSettings.updateOne({ tenantId }, { $set: { ...set, updatedBy: userId }, $setOnInsert: { tenantId } }, { upsert: true });
  return getSettings(tenantId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeExam(e) {
  return {
    id: String(e._id),
    name: e.name,
    grade: e.grade,
    section: e.section || "",
    date: e.date,
    description: e.description || "",
    subjects: e.subjects.map((s) => ({ id: String(s._id), name: s.name, maxMarks: s.maxMarks, passMarks: s.passMarks ?? null })),
    maxTotal: e.subjects.reduce((t, s) => t + s.maxMarks, 0),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function serializeStudent(s) {
  return { id: String(s._id), fullName: fullName(s), admissionNo: s.admissionNo, rollNo: s.rollNo || "", grade: s.grade || "", section: s.section || "", status: s.status };
}

const marksMap = (result) => new Map((result?.marks ?? []).map((m) => [String(m.subjectId), { marks: m.marks, absent: m.absent }]));

/** Students who sit this exam: active students of the class (every section if the exam has none). */
function rosterFilter(tenantId, exam) {
  return { tenantId, status: "active", grade: exam.grade, ...(exam.section ? { section: exam.section } : {}) };
}

async function findExamOrThrow(tenantId, id) {
  const exam = await Exam.findOne({ _id: id, tenantId }).lean();
  if (!exam) throw AppError.notFound("Test not found");
  return exam;
}

/** Roster + results for an exam, with computed results, ranks and class stats. */
async function buildExamView(tenantId, exam, grading) {
  const [roster, results] = await Promise.all([
    Student.find(rosterFilter(tenantId, exam)).collation(COLLATION).lean(),
    ExamResult.find({ tenantId, examId: exam._id }).lean(),
  ]);
  const resultByStudent = new Map(results.map((r) => [String(r.studentId), r]));
  const inRoster = new Set(roster.map((s) => String(s._id)));
  // Students with marks who have since moved class or left still appear
  const extraIds = results.map((r) => r.studentId).filter((id) => !inRoster.has(String(id)));
  const extras = extraIds.length ? await Student.find({ tenantId, _id: { $in: extraIds } }).lean() : [];

  const rows = [...roster.map((s) => ({ s, current: true })), ...extras.map((s) => ({ s, current: false }))].map(({ s, current }) => {
    const r = resultByStudent.get(String(s._id));
    return {
      student: { ...serializeStudent(s), current },
      remarks: r?.remarks || "",
      updatedAt: r?.updatedAt ?? null,
      result: computeResult(exam.subjects, marksMap(r), grading),
    };
  });

  assignRanks(rows);
  rows.sort(
    (a, b) =>
      naturalCompare(a.student.section, b.student.section) ||
      naturalCompare(a.student.rollNo || "~", b.student.rollNo || "~") ||
      naturalCompare(a.student.fullName, b.student.fullName)
  );
  return { rows, stats: classStats(rows, exam.subjects, grading.scale) };
}

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

export async function listExams(tenantId, { page, limit, grade, section, month, search, mine }, user) {
  const filter = { tenantId };
  if (mine === "1" && user) {
    const scoped = classFilter(await teacherScope(user));
    // A class-wide test ("" section) belongs to every section's teacher
    if (scoped) filter.$or = scoped.$or.map((c) => (c.section ? { grade: c.grade, section: { $in: ["", c.section] } } : { grade: c.grade }));
  }
  if (grade) filter.grade = grade;
  if (section) filter.section = section;
  if (month) filter.date = { $gte: `${month}-01`, $lte: `${month}-31` };
  if (search) filter.name = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const [exams, total, grading] = await Promise.all([
    Exam.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Exam.countDocuments(filter),
    getGrading(tenantId),
  ]);

  // Light stats per exam: how many results are complete and the class average
  const results = await ExamResult.find({ tenantId, examId: { $in: exams.map((e) => e._id) } }).lean();
  const byExam = new Map();
  for (const r of results) {
    const list = byExam.get(String(r.examId)) ?? [];
    list.push(r);
    byExam.set(String(r.examId), list);
  }
  const rosterCounts = await Promise.all(exams.map((e) => Student.countDocuments(rosterFilter(tenantId, e))));

  return {
    exams: exams.map((e, i) => {
      const computed = (byExam.get(String(e._id)) ?? []).map((r) => computeResult(e.subjects, marksMap(r), grading));
      const done = computed.filter((c) => c.percent !== null);
      return {
        ...serializeExam(e),
        stats: {
          students: Math.max(rosterCounts[i], computed.length),
          completed: computed.filter((c) => c.status !== "pending").length,
          average: done.length ? round1(done.reduce((t, c) => t + c.percent, 0) / done.length) : null,
          passed: computed.filter((c) => c.status === "pass").length,
        },
      };
    }),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** The school's spelling of the class, or a 400 if it isn't in the class list. */
async function canonicalClass(tenantId, grade, section) {
  const r = (await loadClassList(tenantId)).resolve(grade, section);
  if (r.error || !r.grade) throw AppError.badRequest(r.error?.message ?? "Choose a class", "INVALID_CLASS", [r.error ?? { field: "grade", message: "Choose a class" }]);
  return { grade: r.grade, section: r.section };
}

export async function createExam(tenantId, user, input) {
  const userId = user.id;
  const data = { ...input, ...(await canonicalClass(tenantId, input.grade, input.section)) };
  assertTeachesClass(await teacherScope(user), data.grade, data.section, "create tests for");
  const exam = await Exam.create({ ...data, subjects: data.subjects.map(({ _id, ...s }) => s), tenantId, createdBy: userId });
  return getExam(tenantId, exam._id, user);
}

export async function getExam(tenantId, id, user) {
  const [exam, grading, scope] = await Promise.all([findExamOrThrow(tenantId, id), getGrading(tenantId), user ? teacherScope(user) : { limited: false, assignments: [] }]);
  const { rows, stats } = await buildExamView(tenantId, exam, grading);
  // Which subjects this member may enter marks for (all for admins and class teachers)
  const allowed = markableSubjects(scope, exam.grade, exam.section);
  const editable = exam.subjects.filter((s) => canMarkSubject(allowed, s.name)).map((s) => String(s._id));
  return {
    exam: serializeExam(exam),
    grading,
    students: rows,
    stats,
    access: { subjects: editable, all: editable.length === exam.subjects.length, canEditTest: allowed === null || (user && String(exam.createdBy) === String(user.id)) },
  };
}

/** Subjects that already have marks can be renamed or re-weighted, but not removed. */
export async function updateExam(tenantId, id, data, user) {
  const exam = await Exam.findOne({ _id: id, tenantId });
  if (!exam) throw AppError.notFound("Test not found");
  if (user) {
    const scope = await teacherScope(user);
    // Changing the test itself is for whoever created it, the class teacher or an admin
    if (markableSubjects(scope, exam.grade, exam.section) !== null && String(exam.createdBy) !== String(user.id)) {
      throw AppError.forbidden("Only the class teacher, its creator or an admin can change this test", "NOT_YOUR_CLASS");
    }
    if (data.grade !== undefined || data.section !== undefined) assertTeachesClass(scope, data.grade ?? exam.grade, data.section ?? exam.section, "move a test to");
  }
  if (data.grade !== undefined || data.section !== undefined) {
    Object.assign(data, await canonicalClass(tenantId, data.grade ?? exam.grade, data.section ?? exam.section));
  }

  if (data.subjects) {
    const kept = new Set(data.subjects.filter((s) => s._id).map((s) => s._id));
    const removed = exam.subjects.filter((s) => !kept.has(String(s._id))).map((s) => s._id);
    if (removed.length) {
      const inUse = await ExamResult.exists({
        tenantId,
        examId: exam._id,
        marks: { $elemMatch: { subjectId: { $in: removed }, $or: [{ marks: { $ne: null } }, { absent: true }] } },
      });
      if (inUse) throw AppError.conflict("A subject you removed already has marks. Clear its marks first.", "SUBJECT_HAS_MARKS");
    }
    // Lowering the maximum below marks already entered would make them invalid
    for (const s of data.subjects.filter((x) => x._id)) {
      const tooHigh = await ExamResult.exists({ tenantId, examId: exam._id, marks: { $elemMatch: { subjectId: oid(s._id), marks: { $gt: s.maxMarks } } } });
      if (tooHigh) throw AppError.conflict(`Some marks in ${s.name} are above ${s.maxMarks}. Fix them first.`, "MARKS_ABOVE_MAX");
    }
  }

  Object.assign(exam, data);
  await exam.save();
  return getExam(tenantId, exam._id, user);
}

export async function deleteExam(tenantId, id) {
  const exam = await findExamOrThrow(tenantId, id);
  await ExamResult.deleteMany({ tenantId, examId: exam._id });
  await Exam.deleteOne({ _id: exam._id, tenantId });
}

export async function saveMarks(tenantId, user, id, { entries }) {
  const userId = user.id;
  const exam = await findExamOrThrow(tenantId, id);
  const subjectById = new Map(exam.subjects.map((s) => [String(s._id), s]));
  const scope = await teacherScope(user);
  assertTeachesClass(scope, exam.grade, exam.section, "enter marks for");
  const allowed = markableSubjects(scope, exam.grade, exam.section);
  const mayEdit = (subjectId) => canMarkSubject(allowed, subjectById.get(subjectId)?.name);

  for (const e of entries) {
    for (const m of e.marks) {
      const s = subjectById.get(m.subjectId);
      if (!s) throw AppError.badRequest("Unknown subject. Refresh and try again.", "UNKNOWN_SUBJECT");
      if (m.marks !== null && m.marks > s.maxMarks) {
        throw AppError.badRequest(`${s.name}: marks can't be more than ${s.maxMarks}`, "MARKS_ABOVE_MAX");
      }
    }
  }

  // Only students of this class (or who already have marks here) can be marked
  const ids = entries.map((e) => e.studentId);
  const [eligible, existing] = await Promise.all([
    Student.find({ ...rosterFilter(tenantId, exam), _id: { $in: ids } }, { _id: 1 }).lean(),
    ExamResult.find({ tenantId, examId: exam._id, studentId: { $in: ids } }, { studentId: 1 }).lean(),
  ]);
  const inRoster = new Set([...eligible.map((s) => String(s._id)), ...existing.map((r) => String(r.studentId))]);
  const outside = ids.filter((sid) => !inRoster.has(sid));
  if (outside.length) {
    throw AppError.badRequest(`${outside.length} student(s) are not in this class. Refresh and try again.`, "STUDENT_NOT_IN_CLASS");
  }

  // Subject teachers: other subjects keep their saved marks whatever was sent
  const savedBy = new Map();
  if (allowed !== null) {
    const saved = await ExamResult.find({ tenantId, examId: exam._id, studentId: { $in: ids } }, { studentId: 1, marks: 1 }).lean();
    for (const r of saved) savedBy.set(String(r.studentId), new Map(r.marks.map((m) => [String(m.subjectId), m])));
  }
  const finalMarks = (e) => {
    const sent = new Map(e.marks.map((m) => [m.subjectId, m]));
    const saved = savedBy.get(e.studentId) ?? new Map();
    return exam.subjects
      .map((s) => {
        const sid = String(s._id);
        if (mayEdit(sid)) {
          const m = sent.get(sid);
          return m ? { subjectId: oid(sid), absent: m.absent, marks: m.absent ? null : m.marks } : saved.get(sid);
        }
        return saved.get(sid);
      })
      .filter(Boolean);
  };
  if (allowed !== null && entries.some((e) => e.remarks !== undefined)) {
    // Remarks on the report card are the class teacher's
    for (const e of entries) delete e.remarks;
  }

  await ExamResult.bulkWrite(
    entries.map((e) => ({
      updateOne: {
        filter: { tenantId: oid(tenantId), examId: exam._id, studentId: oid(e.studentId) },
        update: {
          $set: {
            // Absent wins over a number, and clears it
            marks: allowed === null ? e.marks.map((m) => ({ subjectId: oid(m.subjectId), absent: m.absent, marks: m.absent ? null : m.marks })) : finalMarks(e),
            updatedBy: oid(userId),
            ...(e.remarks !== undefined ? { remarks: e.remarks } : {}),
          },
          $setOnInsert: { tenantId: oid(tenantId), examId: exam._id, studentId: oid(e.studentId) },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  return getExam(tenantId, exam._id, user);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const monthRange = (month) => ({ $gte: `${month}-01`, $lte: `${month}-31` });

function attendanceSummary(records) {
  const counts = { present: 0, absent: 0, late: 0, leave: 0 };
  for (const r of records) counts[r.status] += 1;
  const counted = counts.present + counts.late + counts.absent;
  return { ...counts, days: records.length, rate: counted ? round1(((counts.present + counts.late) / counted) * 100) : null };
}

/** One student's month: every test (with result) and attendance. */
export async function studentMonthlyReport(tenantId, studentId, { month }) {
  const student = await Student.findOne({ _id: studentId, tenantId }).lean();
  if (!student) throw AppError.notFound("Student not found");

  const [grading, tenant, results, attendance] = await Promise.all([
    getGrading(tenantId),
    Tenant.findById(tenantId).lean(),
    ExamResult.find({ tenantId, studentId }).lean(),
    Attendance.find({ tenantId, studentId, date: monthRange(month) }, { status: 1, date: 1 }).lean(),
  ]);

  // Tests this month: those the student has marks in, plus their current class's tests
  const examIds = results.map((r) => r.examId);
  const exams = await Exam.find({
    tenantId,
    date: monthRange(month),
    $or: [
      { _id: { $in: examIds } },
      { grade: student.grade, section: { $in: ["", student.section || ""] } },
    ],
  })
    .sort({ date: 1 })
    .lean();
  const resultByExam = new Map(results.map((r) => [String(r.examId), r]));

  const tests = exams.map((e) => {
    const r = resultByExam.get(String(e._id));
    return { exam: serializeExam(e), result: computeResult(e.subjects, marksMap(r), grading), remarks: r?.remarks || "" };
  });
  const scored = tests.filter((t) => t.result.percent !== null);
  const average = scored.length ? round1(scored.reduce((t, x) => t + x.result.percent, 0) / scored.length) : null;

  return {
    school: { name: tenant?.name ?? "" },
    student: { ...serializeStudent(student), guardianName: student.guardianName || "" },
    month,
    grading,
    tests,
    summary: { tests: tests.length, completed: scored.length, average, grade: letterGrade(average, grading.scale) },
    attendance: attendanceSummary(attendance),
  };
}

/** Every student of a class for a month: test average and attendance (for sharing and export). */
export async function classMonthlyReport(tenantId, { grade, section, month }) {
  const grading = await getGrading(tenantId);
  const students = await Student.find({ tenantId, status: "active", grade, ...(section ? { section } : {}) }).collation(COLLATION).lean();
  const ids = students.map((s) => s._id);
  const [exams, attendance] = await Promise.all([
    Exam.find({ tenantId, grade, date: monthRange(month), ...(section ? { section: { $in: ["", section] } } : {}) }).sort({ date: 1 }).lean(),
    Attendance.find({ tenantId, studentId: { $in: ids }, date: monthRange(month) }, { studentId: 1, status: 1 }).lean(),
  ]);
  const results = await ExamResult.find({ tenantId, examId: { $in: exams.map((e) => e._id) }, studentId: { $in: ids } }).lean();
  const resultKey = new Map(results.map((r) => [`${r.examId}:${r.studentId}`, r]));
  const attendanceBy = new Map();
  for (const a of attendance) {
    const list = attendanceBy.get(String(a.studentId)) ?? [];
    list.push(a);
    attendanceBy.set(String(a.studentId), list);
  }

  const rows = students
    .map((s) => {
      // Only tests that apply to this student's section
      const mine = exams.filter((e) => !e.section || e.section === (s.section || ""));
      const tests = mine.map((e) => ({
        examId: String(e._id),
        result: computeResult(e.subjects, marksMap(resultKey.get(`${e._id}:${s._id}`)), grading),
      }));
      const scored = tests.filter((t) => t.result.percent !== null);
      const average = scored.length ? round1(scored.reduce((t, x) => t + x.result.percent, 0) / scored.length) : null;
      return {
        student: serializeStudent(s),
        tests: tests.map((t) => ({ examId: t.examId, percent: t.result.percent, grade: t.result.grade, status: t.result.status })),
        average,
        grade: letterGrade(average, grading.scale),
        attendance: attendanceSummary(attendanceBy.get(String(s._id)) ?? []),
      };
    })
    .sort(
      (a, b) =>
        naturalCompare(a.student.section, b.student.section) ||
        naturalCompare(a.student.rollNo || "~", b.student.rollNo || "~") ||
        naturalCompare(a.student.fullName, b.student.fullName)
    );

  return {
    grade,
    section,
    month,
    grading,
    exams: exams.map(serializeExam),
    students: rows,
  };
}
