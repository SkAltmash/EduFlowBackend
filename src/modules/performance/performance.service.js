import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import Exam from "../../models/Exam.js";
import ExamResult from "../../models/ExamResult.js";
import Student from "../../models/Student.js";
import { computeResult, letterGrade } from "../exams/exams.grading.js";
import { getGrading } from "../exams/exams.service.js";
import { loadClassList } from "../academics/class-names.js";

const DAY_MS = 86_400_000;
const round1 = (n) => Math.round(n * 10) / 10;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
const marksMap = (r) => new Map((r?.marks ?? []).map((m) => [String(m.subjectId), { marks: m.marks, absent: m.absent }]));

/** Overall score: test marks matter most, attendance shows consistency. */
export const WEIGHTS = { marks: 70, attendance: 30 };
/** Below this attendance rate a student needs attention (common minimum rule). */
const LOW_ATTENDANCE = 75;

/**
 * Needs test marks: attendance alone can't put a student without tests above one who sat
 * them (such students still rank on the attendance board). No attendance yet = marks alone.
 */
function score(marks, attendance) {
  if (marks === null) return null;
  if (attendance === null) return marks;
  return round1((marks * WEIGHTS.marks + attendance * WEIGHTS.attendance) / 100);
}

/** Marks and attendance per student for one date range. */
async function measure(tenantId, studentIds, { from, to, grade, section }, grading) {
  const examFilter = { tenantId, date: { $gte: from, $lte: to } };
  if (grade) Object.assign(examFilter, { grade, ...(section ? { section: { $in: ["", section] } } : {}) });

  const [exams, attendance] = await Promise.all([
    Exam.find(examFilter, { name: 1, date: 1, subjects: 1 }).lean(),
    Attendance.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(String(tenantId)), studentId: { $in: studentIds }, date: { $gte: from, $lte: to } } },
      { $group: { _id: { s: "$studentId", st: "$status" }, n: { $sum: 1 } } },
    ]),
  ]);
  const results = exams.length
    ? await ExamResult.find({ tenantId, examId: { $in: exams.map((e) => e._id) }, studentId: { $in: studentIds } }, { examId: 1, studentId: 1, marks: 1 }).lean()
    : [];

  const examById = new Map(exams.map((e) => [String(e._id), e]));
  const marks = new Map();
  // Subject name (case-insensitive) → percents and who is below the pass mark
  const subjects = new Map();
  for (const r of results) {
    const exam = examById.get(String(r.examId));
    const res = computeResult(exam.subjects, marksMap(r), grading);
    res.subjects.forEach((sr, i) => {
      if (sr.percent === null) return;
      const name = exam.subjects[i].name.trim();
      const key = name.toLowerCase();
      const g = subjects.get(key) ?? { name, percents: [], below: new Set(), exams: new Set() };
      g.percents.push(sr.percent);
      g.exams.add(String(exam._id));
      if (sr.passed === false) g.below.add(String(r.studentId));
      subjects.set(key, g);
    });
    if (res.percent === null) continue;
    const m = marks.get(String(r.studentId)) ?? { percents: [], passed: 0, failed: 0, best: null };
    m.percents.push(res.percent);
    if (res.status === "pass") m.passed += 1;
    if (res.status === "fail") m.failed += 1;
    if (!m.best || res.percent > m.best.percent) m.best = { name: exam.name, date: exam.date, percent: res.percent };
    marks.set(String(r.studentId), m);
  }

  const att = new Map();
  for (const a of attendance) {
    const key = String(a._id.s);
    const c = att.get(key) ?? { present: 0, absent: 0, late: 0, leave: 0 };
    c[a._id.st] += a.n;
    att.set(key, c);
  }

  const out = new Map();
  for (const id of studentIds) {
    const m = marks.get(String(id));
    const c = att.get(String(id)) ?? { present: 0, absent: 0, late: 0, leave: 0 };
    const counted = c.present + c.late + c.absent;
    const average = m ? round1(m.percents.reduce((a, b) => a + b, 0) / m.percents.length) : null;
    const rate = counted ? round1(((c.present + c.late) / counted) * 100) : null;
    out.set(String(id), {
      marks: { average, grade: average === null ? null : letterGrade(average, grading.scale), tests: m?.percents.length ?? 0, passed: m?.passed ?? 0, failed: m?.failed ?? 0, best: m?.best ?? null },
      attendance: { rate, ...c, days: counted + c.leave },
      score: score(average, rate),
    });
  }
  const subjectSummary = [...subjects.values()]
    .map((g) => ({ name: g.name, average: round1(g.percents.reduce((a, b) => a + b, 0) / g.percents.length), entries: g.percents.length, tests: g.exams.size, below: [...g.below] }))
    .sort((a, b) => a.average - b.average);
  return { measures: out, tests: exams.length, subjects: subjectSummary };
}

/** Competition ranking (1, 1, 3) by a value, highest first; nulls unranked. */
function rankBy(rows, value) {
  const sorted = rows.filter((r) => value(r) !== null).sort((a, b) => value(b) - value(a));
  const ranks = new Map();
  sorted.forEach((r, i) => ranks.set(r.id, i > 0 && value(sorted[i - 1]) === value(r) ? ranks.get(sorted[i - 1].id) : i + 1));
  return ranks;
}

/**
 * Leaderboard data for a period: every active student (optionally one class) with
 * average test marks, attendance, an overall score and the change since the previous
 * period of the same length. Computed fresh on every call, so it is always live.
 */
export async function leaderboard(tenantId, { from, to, grade, section }) {
  const studentFilter = { tenantId, status: "active", ...(grade ? { grade } : {}), ...(grade && section ? { section } : {}) };
  const [students, grading, classList] = await Promise.all([
    Student.find(studentFilter, { firstName: 1, lastName: 1, admissionNo: 1, grade: 1, section: 1, rollNo: 1 }).lean(),
    getGrading(tenantId),
    loadClassList(tenantId),
  ]);
  const ids = students.map((s) => s._id);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  const previous = { from: addDays(from, -days), to: addDays(from, -1) };

  const [now, before] = await Promise.all([
    measure(tenantId, ids, { from, to, grade, section }, grading),
    measure(tenantId, ids, { ...previous, grade, section }, grading),
  ]);

  const rows = students.map((s) => {
    const m = now.measures.get(String(s._id));
    const p = before.measures.get(String(s._id));
    return {
      id: String(s._id),
      fullName: fullName(s),
      admissionNo: s.admissionNo,
      grade: s.grade || "",
      section: s.section || "",
      rollNo: s.rollNo || "",
      ...m,
      previous: { marks: p.marks.average, attendance: p.attendance.rate, score: p.score },
      change: m.score !== null && p.score !== null ? round1(m.score - p.score) : null,
    };
  });

  const overall = rankBy(rows, (r) => r.score);
  const byMarks = rankBy(rows, (r) => r.marks.average);
  const byAttendance = rankBy(rows, (r) => r.attendance.rate);
  // Rank inside each class too ("2nd in 5-A")
  const classRank = new Map();
  const groups = new Map();
  for (const r of rows) groups.set(`${r.grade}\u0000${r.section}`, [...(groups.get(`${r.grade}\u0000${r.section}`) ?? []), r]);
  for (const g of groups.values()) for (const [id, rank] of rankBy(g, (r) => r.score)) classRank.set(id, rank);

  for (const r of rows) {
    r.rank = { overall: overall.get(r.id) ?? null, marks: byMarks.get(r.id) ?? null, attendance: byAttendance.get(r.id) ?? null, inClass: classRank.get(r.id) ?? null };
  }

  const avg = (vals) => {
    const v = vals.filter((x) => x !== null);
    return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const classes = [...groups.values()]
    .map((g) => {
      const top = g.filter((r) => r.rank.inClass === 1).sort((a, b) => a.fullName.localeCompare(b.fullName));
      return {
        grade: g[0].grade,
        section: g[0].section,
        students: g.length,
        marks: avg(g.map((r) => r.marks.average)),
        attendance: avg(g.map((r) => r.attendance.rate)),
        score: avg(g.map((r) => r.score)),
        toppers: top.map((r) => r.id),
      };
    })
    .filter((c) => c.grade)
    .sort((a, b) => classList.compareGrades(a.grade, b.grade) || a.section.localeCompare(b.section, "en", { numeric: true }));

  return {
    range: { from, to },
    previous,
    weights: WEIGHTS,
    passPercent: grading.passPercent,
    lowAttendance: LOW_ATTENDANCE,
    summary: {
      students: rows.length,
      ranked: overall.size,
      tests: now.tests,
      marks: avg(rows.map((r) => r.marks.average)),
      attendance: avg(rows.map((r) => r.attendance.rate)),
      perfectAttendance: rows.filter((r) => r.attendance.rate === 100 && r.attendance.days >= 5).length,
    },
    // Weakest subject first
    subjects: now.subjects,
    students: rows.sort((a, b) => (a.rank.overall ?? Infinity) - (b.rank.overall ?? Infinity) || a.fullName.localeCompare(b.fullName)),
    classes,
    generatedAt: new Date().toISOString(),
  };
}
