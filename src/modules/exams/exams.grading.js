// Grading: letter grades from percentages, pass/fail, totals and ranks.
// Pure functions, shared by the API responses, reports and WhatsApp messages.

/** Bands from the top; a percentage gets the first band whose `min` it reaches. */
export const SCALES = {
  // CBSE scholastic 8-point scale
  cbse: [
    { grade: "A1", min: 91 },
    { grade: "A2", min: 81 },
    { grade: "B1", min: 71 },
    { grade: "B2", min: 61 },
    { grade: "C1", min: 51 },
    { grade: "C2", min: 41 },
    { grade: "D", min: 33 },
    { grade: "E", min: 0 },
  ],
  simple: [
    { grade: "A+", min: 90 },
    { grade: "A", min: 80 },
    { grade: "B+", min: 70 },
    { grade: "B", min: 60 },
    { grade: "C", min: 50 },
    { grade: "D", min: 40 },
    { grade: "E", min: 33 },
    { grade: "F", min: 0 },
  ],
};

export const DEFAULT_GRADING = Object.freeze({ scale: "cbse", passPercent: 33 });

const round1 = (n) => Math.round(n * 10) / 10;

export function letterGrade(percent, scale = "cbse") {
  if (percent === null || percent === undefined) return null;
  const bands = SCALES[scale] ?? SCALES.cbse;
  return (bands.find((b) => percent >= b.min) ?? bands.at(-1)).grade;
}

/** Pass mark for a subject: its own, or the school's pass percentage of the maximum. */
export function passMarkFor(subject, passPercent) {
  return subject.passMarks ?? Math.ceil((subject.maxMarks * passPercent) / 100);
}

/**
 * One student's result for one exam.
 * marksBySubject: Map(subjectId -> { marks: number|null, absent: boolean })
 * status: "pending" (some marks not entered), "absent" (absent in every subject), "pass" or "fail".
 */
export function computeResult(subjects, marksBySubject, grading) {
  let total = 0;
  let max = 0;
  let entered = 0;
  let absentCount = 0;
  let failedSubjects = 0;

  const perSubject = subjects.map((s) => {
    const m = marksBySubject.get(String(s._id));
    const absent = Boolean(m?.absent);
    const marks = absent ? null : (m?.marks ?? null);
    const done = absent || marks !== null;
    if (done) entered += 1;
    if (absent) absentCount += 1;
    const percent = marks !== null ? round1((marks / s.maxMarks) * 100) : null;
    const passed = absent ? false : marks !== null ? marks >= passMarkFor(s, grading.passPercent) : null;
    if (passed === false) failedSubjects += 1;
    total += marks ?? 0;
    max += s.maxMarks;
    return {
      subjectId: String(s._id),
      marks,
      absent,
      percent,
      grade: absent ? "AB" : letterGrade(percent, grading.scale),
      passed,
    };
  });

  const complete = entered === subjects.length;
  const allAbsent = complete && absentCount === subjects.length;
  const percent = complete && !allAbsent ? round1((total / max) * 100) : null;

  return {
    subjects: perSubject,
    total: complete ? total : null,
    max,
    percent,
    grade: percent !== null ? letterGrade(percent, grading.scale) : null,
    status: !complete ? "pending" : allAbsent ? "absent" : failedSubjects > 0 ? "fail" : "pass",
    failedSubjects,
    entered,
  };
}

/** Standard competition ranking (1, 2, 2, 4) by percentage; pending/absent students get no rank. */
export function assignRanks(rows) {
  const ranked = rows.filter((r) => r.result.percent !== null).sort((a, b) => b.result.percent - a.result.percent);
  let prev = null;
  let rank = 0;
  ranked.forEach((r, i) => {
    if (r.result.percent !== prev) rank = i + 1;
    prev = r.result.percent;
    r.result.rank = rank;
  });
  for (const r of rows) r.result.rank ??= null;
  return ranked.length;
}

/** Class statistics over students with a final result. */
export function classStats(rows, subjects, scale) {
  const done = rows.filter((r) => r.result.percent !== null);
  const percents = done.map((r) => r.result.percent);
  const distribution = Object.fromEntries((SCALES[scale] ?? SCALES.cbse).map((b) => [b.grade, 0]));
  for (const r of done) distribution[r.result.grade] = (distribution[r.result.grade] ?? 0) + 1;

  const subjectStats = subjects.map((s, i) => {
    const marks = rows.map((r) => r.result.subjects[i]?.marks).filter((m) => m !== null && m !== undefined);
    return {
      subjectId: String(s._id),
      average: marks.length ? round1(marks.reduce((t, m) => t + m, 0) / marks.length) : null,
      highest: marks.length ? Math.max(...marks) : null,
    };
  });

  return {
    students: rows.length,
    completed: done.length,
    pending: rows.filter((r) => r.result.status === "pending").length,
    absent: rows.filter((r) => r.result.status === "absent").length,
    passed: rows.filter((r) => r.result.status === "pass").length,
    failed: rows.filter((r) => r.result.status === "fail").length,
    average: percents.length ? round1(percents.reduce((t, p) => t + p, 0) / percents.length) : null,
    highest: percents.length ? Math.max(...percents) : null,
    lowest: percents.length ? Math.min(...percents) : null,
    passRate: done.length ? round1((rows.filter((r) => r.result.status === "pass").length / done.length) * 100) : null,
    distribution,
    subjects: subjectStats,
  };
}
