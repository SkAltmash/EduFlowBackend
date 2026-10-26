// What each WhatsApp message says. One definition serves both modes:
//  - `text`: the formatted message for click-to-send (wa.me links)
//  - `params`: the values for the approved template ({{1}}, {{2}}, …) in API mode
// The template bodies below are what each school submits to Meta (category: Utility).

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });
export const formatMoney = (paise) => money.format(paise / 100);

export function formatDay(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatMonth(month) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export const TEMPLATES = {
  exam_result: {
    title: "Test result",
    suggestedName: "test_result",
    body: "Dear {{1}}, here are the results of {{2}} in {{3}} held on {{4}}: {{5}}. Total: {{6}}, grade {{7}}. {{8}} Regards, {{9}}.",
    example: ["Mr. Sharma", "Aarav Sharma", "Unit Test 1", "12 Oct 2026", "Maths 45/50, Science 38/50", "83/100 (83%)", "A2", "Rank 3 of 30. Result: Pass.", "Sunrise Public School"],
  },
  progress_report: {
    title: "Monthly progress report",
    suggestedName: "progress_report",
    body: "Dear {{1}}, progress report of {{2}} for {{3}}: tests {{4}}. Average {{5}}, grade {{6}}. Attendance {{7}}. Regards, {{8}}.",
    example: ["Mr. Sharma", "Aarav Sharma", "October 2026", "Unit Test 1 83%, Maths Weekly 90%", "86.5%", "A2", "90.9% (20 of 22 days)", "Sunrise Public School"],
  },
  fee_receipt: {
    title: "Fee receipt",
    suggestedName: "fee_receipt",
    body: "Dear {{1}}, we have received {{2}} towards the fees of {{3}}. Receipt no: {{4}}, dated {{5}}. Balance due: {{6}}. Thank you, {{7}}.",
    example: ["Mr. Sharma", "₹5,000", "Aarav Sharma", "R00041", "23 Oct 2026", "₹13,000", "Sunrise Public School"],
  },
  fee_reminder: {
    title: "Fee reminder",
    suggestedName: "fee_reminder",
    body: "Dear {{1}}, this is a reminder from {{2}} that fees of {{3}} for {{4}} are pending. {{5}} Please ignore this message if you have already paid.",
    example: ["Mr. Sharma", "Sunrise Public School", "₹9,000", "Aarav Sharma", "Overdue since 10 Oct 2026."],
  },
  absence: {
    title: "Absence / late alert",
    suggestedName: "attendance_alert",
    body: "Dear {{1}}, {{2}} was marked {{3}} at {{4}} on {{5}}. {{6}} Please contact the school if you have any questions.",
    example: ["Mr. Sharma", "Aarav Sharma", "absent", "Sunrise Public School", "23 Oct 2026", "Remark: Fever."],
  },
  attendance_summary: {
    title: "Monthly attendance report",
    suggestedName: "attendance_report",
    body: "Dear {{1}}, attendance report of {{2}} for {{3}}: present on {{4}} of {{5}} school days ({{6}}). Absent: {{7}}, late: {{8}}. Regards, {{9}}.",
    example: ["Mr. Sharma", "Aarav Sharma", "October 2026", "20", "22", "90.9%", "2", "1", "Sunrise Public School"],
  },
};

/** Template parameters can't contain newlines, tabs or long runs of spaces, and can't be empty. */
export function cleanParam(value) {
  const v = String(value ?? "").replace(/[\n\r\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 300);
  return v || "-";
}

const greeting = (guardianName) => (guardianName ? `Dear ${guardianName},` : "Dear Parent,");

// ---------------------------------------------------------------------------
// Builders: data -> { text, params }
// ---------------------------------------------------------------------------

export function feeReceipt({ school, guardianName, studentName, amount, receiptNo, date, balance, allocations }) {
  const towards = allocations.map((a) => `• ${a.label} · ${a.planName}: ${formatMoney(a.amount)}`).join("\n");
  return {
    text: [
      greeting(guardianName),
      "",
      `We have received *${formatMoney(amount)}* towards the fees of *${studentName}*.`,
      "",
      `🧾 Receipt no: *${receiptNo}*`,
      `📅 Date: ${formatDay(date)}`,
      towards,
      "",
      balance > 0 ? `Balance due: *${formatMoney(balance)}*` : "All fees are now paid. ✅",
      "",
      `Thank you,`,
      school,
    ].join("\n"),
    params: [guardianName || "Parent", formatMoney(amount), studentName, receiptNo, formatDay(date), formatMoney(balance), school],
  };
}

export function feeReminder({ school, guardianName, studentName, balance, overdue, oldestOverdue, nextDue }) {
  const detail =
    overdue > 0 && oldestOverdue
      ? `${formatMoney(overdue)} is overdue since ${formatDay(oldestOverdue)}.`
      : nextDue
        ? `Next due date: ${formatDay(nextDue)}.`
        : "";
  const lines = [greeting(guardianName), "", `This is a gentle reminder from *${school}* that fees of *${formatMoney(balance)}* for *${studentName}* are pending.`];
  if (detail) lines.push("", `${overdue > 0 ? "⚠️" : "📅"} ${detail}`);
  lines.push("", "Please ignore this message if you have already paid. Thank you.");
  return {
    text: lines.join("\n"),
    params: [guardianName || "Parent", school, formatMoney(balance), studentName, detail || "Kindly pay at the earliest."],
  };
}

export function absence({ school, guardianName, studentName, status, date, note }) {
  const word = status === "late" ? "late" : "absent";
  const lines = [greeting(guardianName), "", `*${studentName}* was marked *${word}* at ${school} on ${formatDay(date)}.`];
  if (note) lines.push(`Remark: ${note}`);
  lines.push("", "Please contact the school if you have any questions.");
  return {
    text: lines.join("\n"),
    params: [guardianName || "Parent", studentName, word, school, formatDay(date), note ? `Remark: ${note}.` : "No remarks."],
  };
}

export function attendanceSummary({ school, guardianName, studentName, month, counts }) {
  const counted = counts.present + counts.late + counts.absent;
  const days = counted + counts.leave;
  const attended = counts.present + counts.late;
  const rate = counted ? `${Math.round((attended / counted) * 1000) / 10}%` : "-";
  return {
    text: [
      greeting(guardianName),
      "",
      `📋 Attendance report of *${studentName}* for *${formatMonth(month)}*`,
      "",
      `✅ Present: ${counts.present}`,
      `⏰ Late: ${counts.late}`,
      `❌ Absent: ${counts.absent}`,
      `📝 Leave: ${counts.leave}`,
      `Attendance: *${rate}* (${attended} of ${days} school days)`,
      "",
      "Regards,",
      school,
    ].join("\n"),
    params: [guardianName || "Parent", studentName, formatMonth(month), attended, days, rate, counts.absent, counts.late, school],
  };
}

const pct = (p) => (p === null || p === undefined ? "-" : `${p % 1 === 0 ? p : p.toFixed(1)}%`);
const mark = (m) => (m % 1 === 0 ? String(m) : String(Math.round(m * 100) / 100));

/** exam: { name, date, subjects:[{id,name,maxMarks}], maxTotal }, result: computed result, rank of `ranked` students. */
export function examResult({ school, guardianName, studentName, className, exam, result, ranked, remarks }) {
  const subjectLines = exam.subjects.map((sub, i) => {
    const r = result.subjects[i];
    if (r.absent) return { text: `• ${sub.name}: Absent`, short: `${sub.name} AB` };
    return { text: `• ${sub.name}: ${mark(r.marks)}/${sub.maxMarks} (${r.grade})`, short: `${sub.name} ${mark(r.marks)}/${sub.maxMarks}` };
  });
  const failed = exam.subjects.filter((_, i) => result.subjects[i].passed === false && !result.subjects[i].absent).map((s) => s.name);
  const outcome =
    result.status === "absent"
      ? "Absent for this test."
      : result.status === "pass"
        ? "Result: Pass."
        : `Needs improvement${failed.length ? ` in ${failed.join(", ")}` : ""}.`;
  const rankText = result.rank ? `Rank ${result.rank} of ${ranked}. ` : "";

  const lines = [
    greeting(guardianName),
    "",
    `📝 *${exam.name}* results of *${studentName}*${className ? ` (Class ${className})` : ""}, ${formatDay(exam.date)}:`,
    "",
    ...subjectLines.map((l) => l.text),
    "",
  ];
  if (result.status === "absent") lines.push("❗ Absent for this test.");
  else {
    lines.push(`Total: *${mark(result.total)}/${result.max}* · *${pct(result.percent)}* · Grade *${result.grade}*${result.rank ? ` · Rank ${result.rank} of ${ranked}` : ""}`);
    lines.push(result.status === "pass" ? "Result: ✅ Pass" : `Result: ⚠️ ${outcome}`);
  }
  if (remarks) lines.push(`Remarks: ${remarks}`);
  lines.push("", "Regards,", school);

  return {
    text: lines.join("\n"),
    params: [
      guardianName || "Parent",
      studentName,
      exam.name,
      formatDay(exam.date),
      subjectLines.map((l) => l.short).join(", "),
      result.status === "absent" ? "Absent" : `${mark(result.total)}/${result.max} (${pct(result.percent)})`,
      result.grade ?? "-",
      `${rankText}${outcome}${remarks ? ` Remarks: ${remarks}.` : ""}`,
      school,
    ],
  };
}

/** report: studentMonthlyReport() output */
export function progressReport({ school, guardianName, report }) {
  const { student, tests, summary, attendance, month } = report;
  const done = tests.filter((t) => t.result.status !== "pending");
  const testLines = done.map((t) =>
    t.result.status === "absent"
      ? { text: `• ${t.exam.name} (${formatDay(t.exam.date).replace(/ \d{4}$/, "")}): Absent`, short: `${t.exam.name} AB` }
      : { text: `• ${t.exam.name} (${formatDay(t.exam.date).replace(/ \d{4}$/, "")}): ${pct(t.result.percent)} · ${t.result.grade}`, short: `${t.exam.name} ${pct(t.result.percent)}` }
  );
  const att = attendance.days
    ? `${pct(attendance.rate)} (${attendance.present + attendance.late} of ${attendance.days} days)`
    : "not recorded";

  const lines = [greeting(guardianName), "", `📊 Progress report of *${student.fullName}* for *${formatMonth(month)}*`, ""];
  if (testLines.length) {
    lines.push("*Tests*", ...testLines.map((l) => l.text));
    if (summary.average !== null) lines.push(`Average: *${pct(summary.average)}* · Grade *${summary.grade}*`);
  } else lines.push("No tests this month.");
  lines.push("", `*Attendance:* ${att}${attendance.absent ? ` · Absent ${attendance.absent}` : ""}${attendance.late ? ` · Late ${attendance.late}` : ""}`);
  lines.push("", "Regards,", school);

  return {
    text: lines.join("\n"),
    params: [
      guardianName || "Parent",
      student.fullName,
      formatMonth(month),
      testLines.length ? testLines.map((l) => l.short).join(", ") : "none this month",
      pct(summary.average),
      summary.grade ?? "-",
      att,
      school,
    ],
  };
}
