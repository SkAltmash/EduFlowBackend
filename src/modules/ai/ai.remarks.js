// "Write remarks with AI": one report-card remark per student of a test, from their marks by
// subject and their attendance that month. The class teacher (or an admin) reviews and edits
// them in the marks sheet before saving; nothing is saved here.
import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import { classReport } from "../attendance/attendance.service.js";
import { getExam } from "../exams/exams.service.js";
import { addUsage, assertReady, log } from "./ai.service.js";
import { generate, geminiError } from "./gemini.js";

const LANGUAGES = { en: "English", hi: "Hindi (Devanagari script)", mr: "Marathi (Devanagari script)" };
const TONES = { warm: "warm and encouraging", formal: "formal", brief: "short and to the point" };

/** About one question per 10 students. */
export const remarksUnits = (n) => Math.max(1, Math.ceil(n / 10));

export async function writeRemarks(user, { examId, language = "en", tone = "warm" }) {
  if (!mongoose.isValidObjectId(examId)) throw AppError.badRequest("Choose a test", "INVALID_ID");
  const view = await getExam(user.tenantId, examId, user);
  // Report-card remarks are for the class teacher and admins (as when saving them)
  if (!view.access.all) throw AppError.forbidden("Only the class teacher or an admin can write report-card remarks.", "NOT_CLASS_TEACHER");
  const e = view.exam;
  const done = view.students.filter((r) => r.student.current !== false && ["pass", "fail"].includes(r.result.status));
  if (!done.length) throw AppError.badRequest("Enter the marks first.", "AI_REMARKS_NO_MARKS");
  const month = e.date.slice(0, 7);
  const att = await classReport(user.tenantId, { grade: e.grade, section: e.section || "", from: `${month}-01`, to: `${month}-31` }).catch(() => null);
  const rateOf = new Map((att?.students ?? []).map((x) => [x.student.id, x.rate]));
  const subjectName = new Map(e.subjects.map((s) => [s.id, s.name]));
  const facts = done.map((r) => ({
    id: r.student.id,
    firstName: r.student.fullName.split(" ")[0],
    overallPercent: r.result.percent,
    grade: r.result.grade,
    passed: r.result.status === "pass",
    subjects: r.result.subjects.filter((s) => s.percent !== null).map((s) => ({ subject: subjectName.get(s.subjectId), percent: s.percent, passed: s.passed })),
    attendancePercentThatMonth: rateOf.get(r.student.id) ?? null,
  }));

  const units = remarksUnits(facts.length);
  const cfg = await assertReady(user, units);
  const usage = { input: 0, output: 0 };
  let out;
  try {
    const r = await generate(cfg, {
      contents: `REMARKS_JSON: ${JSON.stringify(facts)}`,
      config: {
        systemInstruction: `You write report-card remarks for "${e.name}" (class ${e.section ? `${e.grade}-${e.section}` : e.grade}) at a school in India, one per student.
Each remark: 1 or 2 sentences, at most 30 words, ${TONES[tone] ?? TONES.warm}. Name a real strength from their marks (a subject they did well in) and, if needed, one specific thing to work on; mention attendance only if it's below 75% or perfect. Use the child's first name. Don't quote marks or ranks, don't compare with other students, and never be harsh.
Write in ${LANGUAGES[language] ?? "English"}. Return [{"id", "remark"}] with every student's id.`,
        temperature: 0.7,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "array", items: { type: "object", properties: { id: { type: "string" }, remark: { type: "string" } }, required: ["id", "remark"] } },
        abortSignal: AbortSignal.timeout(90_000),
      },
    });
    addUsage(usage, r.usageMetadata);
    out = JSON.parse(r.text ?? "[]");
    await log(user, cfg, { kind: "remarks", question: `[remarks] ${e.name} (${facts.length} students)`, usage, ok: true, units });
  } catch (err) {
    await log(user, cfg, { kind: "remarks", question: `[remarks] ${e.name}`, usage, ok: false, units });
    if (err instanceof SyntaxError) throw new AppError(502, "The AI's reply couldn't be read. Try again.", "AI_BAD_REPLY");
    throw geminiError(err);
  }
  const byId = new Map((Array.isArray(out) ? out : []).filter((x) => x && typeof x.remark === "string").map((x) => [String(x.id), x.remark.trim().slice(0, 300)]));
  return { remarks: facts.filter((f) => byId.get(f.id)).map((f) => ({ studentId: f.id, remark: byId.get(f.id) })), units };
}
