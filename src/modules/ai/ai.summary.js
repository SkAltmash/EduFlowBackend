// The dashboard's daily AI summary: today's numbers for what the member's role can see
// (the same as their dashboard), turned by Gemini into a short, prioritised briefing with
// links and a follow-up question for each point. Cached per school, view and language for
// the day, so it's about one AI call a day per view; it doesn't count toward the monthly limit.
// When the AI can't answer, the same points are written from the numbers.
import mongoose from "mongoose";
import AiQuery from "../../models/AiQuery.js";
import AiSummary from "../../models/AiSummary.js";
import Attendance from "../../models/Attendance.js";
import { ROLES } from "../../models/Membership.js";
import Student from "../../models/Student.js";
import Tenant from "../../models/Tenant.js";
import User from "../../models/User.js";
import AppError from "../../utils/AppError.js";
import { overview } from "../dashboard/dashboard.service.js";
import { listExams } from "../exams/exams.service.js";
import { feeRegister } from "../fees/fees.service.js";
import { canTeachClass, classFilter, teacherScope } from "../teaching/teaching.scope.js";
import { indiaToday } from "./ai.tools.js";
import { status } from "./ai.service.js";
import { aiConfig, generate } from "./gemini.js";

const REFRESH_AFTER_MS = 20 * 60_000;
const LANGUAGES = { en: "English", hi: "Hindi (Devanagari script)", mr: "Marathi (Devanagari script)" };
const TONES = ["bad", "warn", "good", "info"];
const LINKS = ["/app/attendance", "/app/fees", "/app/fees?tab=students", "/app/exams", "/app/students", "/app/performance"];

const rupees = (paise) => Math.round((paise ?? 0) / 100);
const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
const cls = (g, s) => (s ? `${g}-${s}` : g);
const inr = (n) => `₹${Number(n).toLocaleString("en-IN")}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function viewOf(user, scope) {
  if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN) return "all";
  if (user.role === ROLES.ACCOUNTANT) return "fees";
  return scope.limited ? `t:${user.id}` : "teach";
}

/** Today's numbers for this member (only what their role can see). */
async function gatherFacts(user, scope, date) {
  const oid = new mongoose.Types.ObjectId(String(user.tenantId));
  const ov = await overview(user.tenantId, user, { date });
  const scoped = classFilter(scope) ?? {};
  const facts = { date, students: { active: ov.students.active, addedThisMonth: ov.students.newThisMonth } };

  if (ov.attendance) {
    const a = ov.attendance;
    const weekFrom = addDays(date, -6);
    const monthFrom = `${date.slice(0, 8)}01`;
    const [repeat, month] = await Promise.all([
      // Absent 3 or more days in the last 7
      Attendance.aggregate([
        { $match: { tenantId: oid, status: "absent", date: { $gte: weekFrom, $lte: date }, ...scoped } },
        { $group: { _id: "$studentId", days: { $sum: 1 } } },
        { $match: { days: { $gte: 3 } } },
        { $sort: { days: -1 } },
        { $limit: 8 },
      ]),
      // Below 75% this month (with at least 5 days marked)
      Attendance.aggregate([
        { $match: { tenantId: oid, date: { $gte: monthFrom, $lte: date }, ...scoped } },
        { $group: { _id: "$studentId", ok: { $sum: { $cond: [{ $in: ["$status", ["present", "late"]] }, 1, 0] } }, counted: { $sum: { $cond: [{ $in: ["$status", ["present", "late", "absent"]] }, 1, 0] } } } },
        { $match: { counted: { $gte: 5 } } },
        { $project: { rate: { $multiply: [{ $divide: ["$ok", "$counted"] }, 100] } } },
        { $match: { rate: { $lt: 75 } } },
        { $sort: { rate: 1 } },
      ]),
    ]);
    const ids = [...repeat.map((r) => r._id), ...month.slice(0, 5).map((r) => r._id)];
    const names = new Map((await Student.find({ tenantId: user.tenantId, _id: { $in: ids } }, { firstName: 1, lastName: 1, grade: 1, section: 1 }).lean()).map((s) => [String(s._id), s]));
    const who = (id) => {
      const s = names.get(String(id));
      return s ? `${fullName(s)} (${cls(s.grade, s.section)})` : null;
    };
    facts.attendance = {
      todayRatePercent: a.rate,
      today: a.counts,
      classesMarked: a.classesMarked,
      classesTotal: a.classesTotal,
      classesNotMarkedYet: a.classes.filter((c) => c.marked === 0).map((c) => cls(c.grade, c.section)).slice(0, 10),
      absentToday: a.absent.slice(0, 8).map((s) => `${s.fullName} (${cls(s.grade, s.section)})`),
      absentTodayTotal: a.absentTotal,
      last7DaysRate: a.trend.slice(-7).map((t) => t.rate),
      absent3PlusDaysThisWeek: repeat.map((r) => ({ student: who(r._id), days: r.days })).filter((r) => r.student),
      below75PercentThisMonth: { count: month.length, lowest: month.slice(0, 5).map((r) => ({ student: who(r._id), ratePercent: Math.round(r.rate) })).filter((r) => r.student) },
    };
    facts.today = { birthdays: ov.today.birthdays.filter((b) => b.today).map((b) => b.fullName), onLeave: ov.today.leaves.length };
  }

  if (ov.tests) {
    const list = await listExams(user.tenantId, { page: 1, limit: 6 }, user);
    facts.recentTests = list.exams
      .filter((e) => canTeachClass(scope, e.grade, e.section))
      .slice(0, 4)
      .map((e) => ({ name: e.name, class: cls(e.grade, e.section), date: e.date, averagePercent: e.stats.average, passed: e.stats.passed, marksEntered: e.stats.completed, students: e.stats.students }));
  }

  if (ov.fees) {
    const f = ov.fees;
    const top = await feeRegister(user.tenantId, { page: 1, limit: 3, status: "overdue", sort: "overdue", today: date });
    facts.fees = {
      collectedToday: inr(rupees(f.collectedToday)),
      collectedThisMonth: inr(rupees(f.collectedMonth.amount)),
      receiptsThisMonth: f.collectedMonth.count,
      outstanding: inr(rupees(f.outstanding)),
      overdue: inr(rupees(f.overdue)),
      overdueStudents: f.overdueStudents,
      collectionRatePercent: f.collectionRate,
      dueInNext30Days: inr(rupees(f.upcoming.amount)),
      biggestOverdue: top.students.map((s) => `${s.fullName} (${cls(s.grade, s.section)}) ${inr(rupees(s.overdue))}`),
    };
  }
  return facts;
}

/** The same points without the AI (English), from the numbers. */
function fallbackItems(f) {
  const items = [];
  const a = f.attendance;
  if (a?.classesNotMarkedYet.length) items.push({ tone: "warn", title: "Attendance not marked", detail: `${a.classesNotMarkedYet.length} of ${a.classesTotal} classes haven't marked attendance today: ${a.classesNotMarkedYet.slice(0, 5).join(", ")}.`, link: "/app/attendance", ask: "Which classes haven't marked attendance today?" });
  if (a?.absent3PlusDaysThisWeek.length) items.push({ tone: "bad", title: "Absent again and again", detail: `${plural(a.absent3PlusDaysThisWeek.length, "student")} ${a.absent3PlusDaysThisWeek.length === 1 ? "was" : "were"} absent 3 or more days this week${a.absent3PlusDaysThisWeek.length === 1 ? ":" : ", e.g."} ${a.absent3PlusDaysThisWeek[0].student}.`, link: "/app/attendance", ask: "Which students were absent 3 or more days this week?" });
  if (f.fees && f.fees.overdueStudents) items.push({ tone: "bad", title: "Overdue fees", detail: `${f.fees.overdue} is overdue from ${plural(f.fees.overdueStudents, "student")}.`, link: "/app/fees?tab=students", ask: "Who has overdue fees?" });
  if (f.fees) items.push({ tone: "good", title: "Collections", detail: `${f.fees.collectedToday} collected today, ${f.fees.collectedThisMonth} this month.`, link: "/app/fees", ask: "How much fee did we collect this month, by mode?" });
  if (a?.below75PercentThisMonth.count) items.push({ tone: "warn", title: "Low attendance this month", detail: `${plural(a.below75PercentThisMonth.count, "student")} ${a.below75PercentThisMonth.count === 1 ? "is" : "are"} below 75% attendance this month.`, link: "/app/attendance", ask: "Students below 75% attendance this month" });
  const t = f.recentTests?.find((x) => x.averagePercent !== null);
  if (t) items.push({ tone: "info", title: `Latest test: ${t.name}`, detail: `Class ${t.class} averaged ${t.averagePercent}%, ${t.passed} passed.`, link: "/app/exams", ask: `How did class ${t.class} do in ${t.name}?` });
  if (a && a.todayRatePercent !== null && !items.length) items.push({ tone: "good", title: "Attendance today", detail: `${a.todayRatePercent}% present so far today.`, link: "/app/attendance", ask: "Who is absent today?" });
  if (!items.length) items.push({ tone: "info", title: "Nothing urgent today", detail: "No alerts from attendance, fees or tests right now.", link: "/app/students", ask: "Give me a quick overview of the school" });
  return items.slice(0, 5);
}

const headlineOf = (items) => (items.some((i) => i.tone === "bad") ? "A few things need your attention today." : items.some((i) => i.tone === "warn") ? "Mostly on track, with a couple of things to check." : "All on track today.");

/** Keeps only well-formed items with links into the app. */
function clean(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && typeof i.title === "string" && typeof i.detail === "string")
    .slice(0, 5)
    .map((i) => ({
      tone: TONES.includes(i.tone) ? i.tone : "info",
      title: i.title.slice(0, 80),
      detail: i.detail.slice(0, 240),
      link: typeof i.link === "string" && LINKS.includes(i.link) ? i.link : null,
      ask: typeof i.ask === "string" ? i.ask.slice(0, 200) : null,
    }));
}

const serialize = (s) => ({ headline: s.headline, items: s.items, date: s.date, ai: s.ai, generatedAt: s.updatedAt, refreshAfter: new Date(new Date(s.updatedAt).getTime() + REFRESH_AFTER_MS) });

export async function dailySummary(user, { language = "en", refresh = false }) {
  const st = await status(user);
  if (st.state !== "ready" && st.state !== "quota") throw AppError.forbidden("The AI assistant isn't on for this school.", "AI_SUMMARY_UNAVAILABLE");
  const scope = await teacherScope(user);
  const view = viewOf(user, scope);
  const date = indiaToday();
  const lang = LANGUAGES[language] ? language : "en";
  const key = { tenantId: user.tenantId, view, date, language: lang };
  const cached = await AiSummary.findOne(key).lean();
  if (cached && (!refresh || Date.now() - new Date(cached.updatedAt).getTime() < REFRESH_AFTER_MS)) return { summary: serialize(cached) };

  const [facts, cfg, tenant, member] = await Promise.all([gatherFacts(user, scope, date), aiConfig(), Tenant.findById(user.tenantId, { name: 1 }).lean(), User.findById(user.id, { name: 1 }).lean()]);
  let headline = "";
  let items = [];
  let ai = false;
  const usage = { input: 0, output: 0 };
  try {
    const r = await generate(cfg, {
      contents: `SUMMARY_FACTS: ${JSON.stringify(facts)}`,
      config: {
        systemInstruction: `You write today's short briefing for ${member?.name?.split(" ")[0] ?? "a staff member"} (${user.role}) on the EduFlow dashboard of ${tenant?.name ?? "a school"} in India.
From the facts, choose the 3 to 5 most useful points for today, most urgent first: problems (attendance not marked, students absent again and again, overdue fees, weak test results) before good news. Skip anything that's zero or empty.
Each point: tone ("bad" needs action now, "warn" worth checking, "good" good news, "info" neutral); title of at most 6 words; detail of one sentence (at most 25 words) with the exact numbers and names from the facts; link: one of ${LINKS.join(", ")} that fits; ask: a short follow-up question the user could ask the assistant to see the details.
headline: one short, friendly sentence summing up today.
Write in ${LANGUAGES[lang]}, with digits 0-9 and amounts like ₹12,500. Use only the facts given; never invent. If there's almost no data yet, say what to set up first.`,
        temperature: 0.4,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            headline: { type: "string" },
            items: { type: "array", items: { type: "object", properties: { tone: { type: "string", enum: TONES }, title: { type: "string" }, detail: { type: "string" }, link: { type: "string" }, ask: { type: "string" } }, required: ["tone", "title", "detail"] } },
          },
          required: ["headline", "items"],
        },
        abortSignal: AbortSignal.timeout(45_000),
      },
    }, "minimal");
    usage.input = r.usageMetadata?.promptTokenCount ?? 0;
    usage.output = (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0);
    const out = JSON.parse(r.text ?? "{}");
    items = clean(out.items);
    headline = typeof out.headline === "string" ? out.headline.slice(0, 160) : "";
    ai = items.length > 0;
  } catch (err) {
    console.error("AI summary failed:", err?.message ?? err);
  }
  if (!items.length) {
    items = fallbackItems(facts);
    headline ||= headlineOf(items);
  }
  await AiQuery.create({ tenantId: user.tenantId, userId: user.id, kind: "summary", month: date.slice(0, 7), question: `[summary:${view}]`, model: cfg.model, inputTokens: usage.input, outputTokens: usage.output, ok: ai }).catch(() => {});
  const saved = await AiSummary.findOneAndUpdate(key, { $set: { headline, items, ai } }, { upsert: true, new: true }).lean();
  return { summary: serialize(saved) };
}
