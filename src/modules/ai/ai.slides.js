// AI presentations. Three kinds:
//   topic           – any subject (a lesson, an orientation…): outline first, then slides.
//   class_results   – a test's results for a PTM: the numbers come from the records.
//   monthly_review  – a month for the management: attendance, fees, tests.
// For the data decks the server builds every number slide (stats, charts, tables) itself, so
// the AI never invents a figure; Gemini writes the titles, one-line insights, speaker notes
// and the narrative slides. Results decks never name students who failed (they're shown to
// parents); only toppers, and that can be turned off.
import mongoose from "mongoose";
import AiDeck, { DECK_KINDS, DECK_THEMES, MAX_SLIDES, SLIDE_LAYOUTS } from "../../models/AiDeck.js";
import Attendance from "../../models/Attendance.js";
import { ROLES } from "../../models/Membership.js";
import Student from "../../models/Student.js";
import Tenant from "../../models/Tenant.js";
import AppError from "../../utils/AppError.js";
import { classReport } from "../attendance/attendance.service.js";
import { getExam, listExams } from "../exams/exams.service.js";
import { summary as feeSummary } from "../fees/fees.service.js";
import { canTeachClass, teacherScope } from "../teaching/teaching.scope.js";
import { cloudinaryConfig, sign, uploadDataUri } from "../platform/cloudinary.js";
import { addUsage, assertReady, log } from "./ai.service.js";
import { indiaToday } from "./ai.tools.js";
import { aiConfig, generate, geminiError, imagesReady, makeImage } from "./gemini.js";

// How many of the school's monthly AI questions each step counts as
export const UNITS = { outline: 1, deck: 4, slide: 1, insert: 1, translate: 2, image: 2 };

const TEACHING = [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER];
const MANAGERS = [ROLES.OWNER, ROLES.ADMIN];
const LANGUAGES = { en: "English", hi: "Hindi (Devanagari script)", mr: "Marathi (Devanagari script)" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const rupees = (paise) => Math.round((paise ?? 0) / 100);
const inr = (paise) => `₹${rupees(paise).toLocaleString("en-IN")}`;
const pct = (n) => (n === null || n === undefined ? "—" : `${Math.round(n * 10) / 10}%`);
const cls = (g, s) => (s ? `${g}-${s}` : g);
const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const prettyDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const round1 = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Slide JSON: what the model may return, and a sanitiser for everything stored
// ---------------------------------------------------------------------------

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strings = (v, n, max) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
const nums = (v, n) => (Array.isArray(v) ? v.slice(0, n).map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0)) : []);

/** Keeps only known fields with sane sizes (model output and the editor's saves alike). */
export function cleanSlide(s) {
  if (!s || typeof s !== "object") return null;
  const layout = SLIDE_LAYOUTS.includes(s.layout) ? s.layout : "bullets";
  const out = { layout, title: str(s.title, 140) };
  // Number slides built from the school's records (their numbers are locked in the editor)
  if (typeof s.fromRecords === "boolean") out.fromRecords = s.fromRecords;
  const subtitle = str(s.subtitle, 200);
  if (subtitle) out.subtitle = subtitle;
  const caption = str(s.caption, 260);
  if (caption) out.caption = caption;
  const notes = str(s.notes, 2000);
  if (notes) out.notes = notes;
  const bullets = strings(s.bullets, 8, 220);
  if (bullets.length) out.bullets = bullets;
  for (const side of ["left", "right"]) {
    if (s[side] && typeof s[side] === "object") out[side] = { heading: str(s[side].heading, 80), bullets: strings(s[side].bullets, 6, 200) };
  }
  if (s.quote) {
    out.quote = str(s.quote, 320);
    const by = str(s.attribution, 80);
    if (by) out.attribution = by;
  }
  if (Array.isArray(s.stats)) out.stats = s.stats.slice(0, 6).map((x) => ({ label: str(x?.label, 60), value: str(String(x?.value ?? ""), 30), hint: str(x?.hint, 80) })).filter((x) => x.label || x.value);
  if (s.table && Array.isArray(s.table.head)) {
    const head = strings(s.table.head, 8, 60);
    out.table = { head, rows: (Array.isArray(s.table.rows) ? s.table.rows : []).slice(0, 15).map((r) => (Array.isArray(r) ? r.slice(0, head.length).map((c) => str(String(c ?? ""), 80)) : [])) };
  }
  // Pictures live on our Cloudinary account (uploaded by the member, or made by the AI)
  if (s.image && typeof s.image === "object" && /^https:\/\/res\.cloudinary\.com\/[\w-]+\/image\/upload\//.test(String(s.image.url))) {
    out.image = { url: String(s.image.url).slice(0, 500), alt: str(s.image.alt, 160), source: s.image.source === "ai" ? "ai" : "upload" };
  }
  if (s.chart && typeof s.chart === "object") {
    const labels = strings(s.chart.labels, 31, 40);
    out.chart = {
      type: ["bar", "line", "pie"].includes(s.chart.type) ? s.chart.type : "bar",
      labels,
      series: (Array.isArray(s.chart.series) ? s.chart.series : []).slice(0, 3).map((x) => ({ name: str(x?.name, 40), values: nums(x?.values, labels.length) })),
      unit: ["%", "₹", ""].includes(s.chart.unit) ? s.chart.unit : "",
    };
  }
  return out;
}

const SLIDE_JSON = {
  type: "object",
  properties: {
    layout: { type: "string", enum: ["title", "section", "bullets", "two_column", "quote", "table", "stats", "closing"] },
    title: { type: "string" },
    subtitle: { type: "string" },
    bullets: { type: "array", items: { type: "string" } },
    left: { type: "object", properties: { heading: { type: "string" }, bullets: { type: "array", items: { type: "string" } } } },
    right: { type: "object", properties: { heading: { type: "string" }, bullets: { type: "array", items: { type: "string" } } } },
    quote: { type: "string" },
    attribution: { type: "string" },
    table: { type: "object", properties: { head: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: { type: "string" } } } } },
    stats: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } } } },
    notes: { type: "string" },
  },
  required: ["layout", "title"],
};

// Topic decks may also ask for picture slides: "imagePrompt" describes the picture to draw
const TOPIC_SLIDE_JSON = {
  ...SLIDE_JSON,
  properties: { ...SLIDE_JSON.properties, layout: { type: "string", enum: [...SLIDE_JSON.properties.layout.enum, "image"] }, imagePrompt: { type: "string" } },
};

const STYLE = (language) => `Write in ${LANGUAGES[language] ?? "English"} (digits 0-9; amounts like ₹12,500).
Slides are for projecting: short phrases, not paragraphs. A bullets slide has 3 to 5 bullets of at most 12 words each. Put the detail a speaker would say in "notes" (2 to 4 sentences, conversational).`;

// ---------------------------------------------------------------------------
// Records → facts and number slides
// ---------------------------------------------------------------------------

async function resultsData(user, { examId, showNames = true }) {
  if (!TEACHING.includes(user.role)) throw AppError.forbidden("Your role can't see test results.", "AI_DECK_NOT_ALLOWED");
  if (!mongoose.isValidObjectId(examId)) throw AppError.badRequest("Choose a test", "INVALID_ID");
  const view = await getExam(user.tenantId, examId, user);
  const e = view.exam;
  if (!canTeachClass(await teacherScope(user), e.grade, e.section)) throw AppError.forbidden("You aren't assigned to this class.", "NOT_YOUR_CLASS");
  const st = view.stats;
  if (!st.completed) throw AppError.badRequest("No marks have been entered for this test yet.", "AI_DECK_NO_DATA");
  const klass = cls(e.grade, e.section);
  // From the raw marks (the class stats round averages in marks first)
  const subjects = e.subjects.map((sub) => {
    const marks = view.students.map((r) => r.result.subjects?.find((x) => x.subjectId === sub.id)?.marks).filter((m) => typeof m === "number");
    return {
      name: sub.name,
      averagePercent: marks.length ? round1((marks.reduce((t, m) => t + m, 0) / marks.length / sub.maxMarks) * 100) : null,
      highestPercent: marks.length ? round1((Math.max(...marks) / sub.maxMarks) * 100) : null,
    };
  });
  const toppers = view.students
    .filter((r) => r.result.rank && r.result.rank <= 5)
    .sort((a, b) => a.result.rank - b.result.rank)
    .map((r) => ({ rank: r.result.rank, name: r.student.fullName, percent: r.result.percent, grade: r.result.grade }));
  const distribution = Object.entries(st.distribution ?? {}).filter(([, n]) => n > 0);
  // Class attendance in the test's month
  const month = e.date.slice(0, 7);
  const att = await classReport(user.tenantId, { grade: e.grade, section: e.section || "", from: `${month}-01`, to: `${month}-31` }).catch(() => null);

  const slides = [
    { id: "stats", layout: "stats", title: "Results at a glance", stats: [
      { label: "Class average", value: pct(st.average) },
      { label: "Pass rate", value: pct(st.passRate), hint: `${st.passed} of ${st.completed} passed` },
      { label: "Highest", value: pct(st.highest) },
      { label: "Appeared", value: `${st.completed - st.absent}/${st.students}` },
      ...(att?.summary.rate !== null && att?.summary.rate !== undefined ? [{ label: `Attendance, ${MONTHS[Number(month.slice(5)) - 1]}`, value: pct(att.summary.rate) }] : []),
    ] },
    { id: "subjects", layout: "chart", title: "Subject-wise average", chart: { type: "bar", labels: subjects.map((s) => s.name), series: [{ name: "Average %", values: subjects.map((s) => s.averagePercent ?? 0) }], unit: "%" } },
    ...(distribution.length > 1 ? [{ id: "grades", layout: "chart", title: "Grade distribution", chart: { type: "pie", labels: distribution.map(([g]) => g), series: [{ name: "Students", values: distribution.map(([, n]) => n) }], unit: "" } }] : []),
    ...(showNames && toppers.length ? [{ id: "toppers", layout: "table", title: "Our toppers", table: { head: ["Rank", "Student", "Score", "Grade"], rows: toppers.map((t) => [String(t.rank), t.name, pct(t.percent), t.grade ?? ""]) } }] : []),
  ];
  const facts = {
    test: e.name, class: klass, date: e.date, subjects,
    classAveragePercent: st.average, passRatePercent: st.passRate, highestPercent: st.highest, lowestPercent: st.lowest,
    students: st.students, marked: st.completed, absent: st.absent, passed: st.passed, failed: st.failed,
    gradeDistribution: Object.fromEntries(distribution),
    ...(showNames ? { toppers: toppers.map((t) => `${t.rank}. ${t.name} ${t.percent}%`) } : {}),
    attendanceRatePercentInTestMonth: att?.summary.rate ?? null,
  };
  return {
    title: `${e.name} — Class ${klass}`,
    subtitle: prettyDate(e.date),
    source: { examId: e.id, showNames },
    facts,
    slides,
    brief: `a parent-teacher meeting presentation about class ${klass}'s results in "${e.name}". Never name students who failed or did badly; talk about subjects and the class as a whole.`,
    extras: `After the data slides add: "What went well" (bullets), "Where we'll focus next" (bullets, by subject, no names), "How parents can help at home" (bullets, practical), and a closing slide.`,
  };
}

async function reviewData(user, { month }) {
  if (!MANAGERS.includes(user.role)) throw AppError.forbidden("Only owners and admins can make the monthly review.", "AI_DECK_NOT_ALLOWED");
  const today = indiaToday();
  const m = /^\d{4}-\d{2}$/.test(month ?? "") && month <= today.slice(0, 7) ? month : today.slice(0, 7);
  const from = `${m}-01`;
  const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10);
  const to = last < today ? last : today;
  const oid = new mongoose.Types.ObjectId(String(user.tenantId));

  const [fees, byDay, byClass, active, joined, tests] = await Promise.all([
    feeSummary(user.tenantId, { from, to, today: to }),
    Attendance.aggregate([
      { $match: { tenantId: oid, date: { $gte: from, $lte: to } } },
      { $group: { _id: "$date", ok: { $sum: { $cond: [{ $in: ["$status", ["present", "late"]] }, 1, 0] } }, counted: { $sum: { $cond: [{ $in: ["$status", ["present", "late", "absent"]] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]),
    Attendance.aggregate([
      { $match: { tenantId: oid, date: { $gte: from, $lte: to } } },
      { $group: { _id: { g: "$grade", s: "$section" }, ok: { $sum: { $cond: [{ $in: ["$status", ["present", "late"]] }, 1, 0] } }, counted: { $sum: { $cond: [{ $in: ["$status", ["present", "late", "absent"]] }, 1, 0] } } } },
    ]),
    Student.countDocuments({ tenantId: user.tenantId, status: "active" }),
    Student.countDocuments({ tenantId: user.tenantId, createdAt: { $gte: new Date(`${from}T00:00:00+05:30`), $lte: new Date(`${to}T23:59:59+05:30`) } }),
    listExams(user.tenantId, { page: 1, limit: 12, month: m }, user),
  ]);
  const rateOf = (x) => (x.counted ? round1((x.ok / x.counted) * 100) : null);
  const days = byDay.filter((d) => d.counted);
  const overall = days.length ? round1((days.reduce((t, d) => t + d.ok, 0) / days.reduce((t, d) => t + d.counted, 0)) * 100) : null;
  const classes = byClass
    .filter((c) => c.counted && c._id.g)
    .map((c) => ({ class: cls(c._id.g, c._id.s), rate: rateOf(c) }))
    .sort((a, b) => a.class.localeCompare(b.class, "en", { numeric: true }));
  const weeks = [0, 0, 0, 0, 0];
  for (const d of fees.byDay) weeks[Math.min(4, Math.floor((Number(d.date.slice(8)) - 1) / 7))] += d.amount;
  const testRows = tests.exams.filter((t) => t.stats.average !== null).slice(0, 8);
  const duesByClass = fees.byClass.filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 10);

  const slides = [
    { id: "kpis", layout: "stats", title: "The month in numbers", stats: [
      { label: "Active students", value: active.toLocaleString("en-IN"), hint: joined ? `+${joined} joined` : "" },
      { label: "Attendance", value: pct(overall) },
      { label: "Fees collected", value: inr(fees.collected.amount), hint: plural(fees.collected.count, "receipt") },
      { label: "Overdue", value: inr(fees.dues.overdue), hint: plural(fees.dues.overdueStudents, "student") },
      ...(fees.dues.collectionRate !== null ? [{ label: "Collection rate", value: pct(fees.dues.collectionRate) }] : []),
    ] },
    ...(days.length > 1 ? [{ id: "attendance_trend", layout: "chart", title: "Daily attendance", chart: { type: "line", labels: days.map((d) => String(Number(d._id.slice(8)))), series: [{ name: "Attendance %", values: days.map(rateOf) }], unit: "%" } }] : []),
    ...(classes.length ? [{ id: "attendance_classes", layout: "chart", title: "Attendance by class", chart: { type: "bar", labels: classes.map((c) => c.class), series: [{ name: "Attendance %", values: classes.map((c) => c.rate ?? 0) }], unit: "%" } }] : []),
    ...(fees.collected.amount ? [{ id: "collections_weeks", layout: "chart", title: "Fee collections by week", chart: { type: "bar", labels: weeks.map((_, i) => `Week ${i + 1}`).slice(0, Math.ceil(Number(to.slice(8)) / 7)), series: [{ name: "Collected ₹", values: weeks.map(rupees).slice(0, Math.ceil(Number(to.slice(8)) / 7)) }], unit: "₹" } }] : []),
    ...(fees.byMode.length > 1 ? [{ id: "collections_modes", layout: "chart", title: "How fees were paid", chart: { type: "pie", labels: fees.byMode.map((x) => x.mode.toUpperCase()), series: [{ name: "₹", values: fees.byMode.map((x) => rupees(x.amount)) }], unit: "₹" } }] : []),
    ...(duesByClass.length ? [{ id: "dues_classes", layout: "table", title: "Pending fees by class", table: { head: ["Class", "Billed", "Paid", "Balance", "Overdue"], rows: duesByClass.map((c) => [cls(c.grade, c.section), inr(c.billed), inr(c.paid), inr(c.balance), inr(c.overdue)]) } }] : []),
    ...(testRows.length ? [{ id: "tests", layout: "chart", title: "Test averages this month", chart: { type: "bar", labels: testRows.map((t) => `${t.name} (${cls(t.grade, t.section)})`), series: [{ name: "Average %", values: testRows.map((t) => t.stats.average) }], unit: "%" } }] : []),
  ];
  const facts = {
    month: monthName(m), from, to, activeStudents: active, joinedThisMonth: joined,
    attendancePercent: overall, attendanceByClass: classes, schoolDaysMarked: days.length,
    feesCollected: inr(fees.collected.amount), receipts: fees.collected.count, byMode: fees.byMode.map((x) => `${x.mode} ${inr(x.amount)}`),
    outstanding: inr(fees.dues.balance), overdue: inr(fees.dues.overdue), overdueStudents: fees.dues.overdueStudents, collectionRatePercent: fees.dues.collectionRate,
    dueInNext30Days: inr(fees.upcoming.amount),
    pendingByClass: duesByClass.map((c) => `${cls(c.grade, c.section)}: ${inr(c.balance)} (${inr(c.overdue)} overdue)`),
    tests: testRows.map((t) => `${t.name} (${cls(t.grade, t.section)}): average ${t.stats.average}%, ${t.stats.passed} passed of ${t.stats.completed}`),
  };
  return {
    title: `Monthly review — ${monthName(m)}`,
    subtitle: `${prettyDate(from)} to ${prettyDate(to)}`,
    source: { month: m },
    facts,
    slides,
    brief: `a monthly review presentation for the school's management (owner, principal) covering ${monthName(m)}.`,
    extras: `After the data slides add: "Highlights" (bullets), "Concerns" (bullets, specific, with the numbers), "Plan for next month" (bullets, practical actions), and a closing slide.`,
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function askJson(cfg, user, { system, contents, schema, kind, question, units, level }) {
  const usage = { input: 0, output: 0 };
  try {
    const r = await generate(
      cfg,
      { contents, config: { systemInstruction: system, temperature: 0.6, maxOutputTokens: 8192, responseMimeType: "application/json", responseJsonSchema: schema, abortSignal: AbortSignal.timeout(120_000) } },
      level
    );
    addUsage(usage, r.usageMetadata);
    const out = JSON.parse(r.text ?? "null");
    await log(user, cfg, { kind, question, usage, ok: true, units });
    return out;
  } catch (err) {
    await log(user, cfg, { kind, question, usage, ok: false, units });
    if (err instanceof SyntaxError) throw new AppError(502, "The AI's reply couldn't be read. Try again.", "AI_BAD_REPLY");
    if (err instanceof AppError) throw err;
    throw geminiError(err);
  }
}

const schoolOf = async (user) => (await Tenant.findById(user.tenantId, { name: 1 }).lean())?.name ?? "Our school";

/** Topic decks, step 1: an outline the member can edit before the slides are written. */
export async function outline(user, { topic, audience, slides: count = 10, language = "en" }) {
  const cfg = await assertReady(user, UNITS.outline);
  const n = Math.min(Math.max(Number(count) || 10, 5), 15);
  const out = await askJson(cfg, user, {
    kind: "slides",
    question: `[outline] ${topic}`.slice(0, 500),
    units: UNITS.outline,
    level: "minimal",
    system: `You plan presentations for a school in India (${await schoolOf(user)}). Plan exactly ${n} slides for: ${topic}.${audience ? ` Audience: ${audience}.` : ""}
Slide 1 is the title slide; the last is a closing slide. For each slide give a short title and up to 3 key points (a few words each). ${STYLE(language)}
Return {"title", "slides": [{"title", "points": [..]}]}.`,
    contents: `DECK_OUTLINE: ${JSON.stringify({ topic, audience, slides: n, language })}`,
    schema: { type: "object", properties: { title: { type: "string" }, slides: { type: "array", items: { type: "object", properties: { title: { type: "string" }, points: { type: "array", items: { type: "string" } } }, required: ["title"] } } }, required: ["title", "slides"] },
  });
  return {
    outline: {
      title: str(out?.title, 140) || str(topic, 140),
      slides: (Array.isArray(out?.slides) ? out.slides : []).slice(0, 15).map((s) => ({ title: str(s?.title, 140), points: strings(s?.points, 4, 120) })).filter((s) => s.title),
    },
  };
}

/** Writes the whole presentation and saves it. */
export async function createDeck(user, input) {
  const { kind, language = "en" } = input;
  const theme = DECK_THEMES.includes(input.theme) ? input.theme : "classic";
  const cfg = await assertReady(user, UNITS.deck);
  const school = await schoolOf(user);
  // Pictures drawn while the deck is written (topic decks, when AI pictures are on): 2 for a short deck, 3 otherwise
  const pictures = kind === "topic" && input.pictures !== false && imagesReady(cfg) ? ((input.outline?.slides?.length ?? 0) <= 6 ? 2 : 3) : 0;
  let title, slides, source;

  if (kind === "topic") {
    const plan = input.outline;
    if (!plan?.slides?.length) throw AppError.badRequest("Make the outline first", "AI_DECK_NO_OUTLINE");
    const out = await askJson(cfg, user, {
      kind: "slides",
      question: `[deck] ${input.topic ?? plan.title}`.slice(0, 500),
      units: UNITS.deck,
      system: `You write presentation slides for ${school}, a school in India. Follow the outline exactly: one slide per outline item, in order, keeping its title (you may polish it).
Choose each slide's layout: "title" for the first; "closing" for the last (a thank-you or key takeaway); otherwise "bullets", "image" (2 to 4 bullets beside a picture), "two_column" (comparisons, before/after, do/don't, pros/cons), "quote" (a short memorable line), "table" (small, factual: steps, examples, terms and meanings), "section" (a divider) or "stats" (2 to 4 big numbers, only well-known facts).
Make the deck varied and visual, like a professional designer: never two "bullets" slides in a row; use ${pictures ? `"image" for ${pictures} slides spread through the deck (each with "imagePrompt": one sentence describing a simple illustration for it, with no words or letters in it), ` : ""}at least one "two_column", and a "table", "quote" or "stats" where it fits.
Be accurate for school students; no made-up statistics.${input.audience ? ` Audience: ${input.audience}.` : ""} ${STYLE(language)}
Every slide has "notes". Return {"slides": [..]}.`,
      contents: `DECK_TOPIC: ${JSON.stringify({ topic: input.topic, outline: plan })}`,
      schema: { type: "object", properties: { slides: { type: "array", items: pictures ? TOPIC_SLIDE_JSON : SLIDE_JSON } }, required: ["slides"] },
    });
    title = str(plan.title, 140) || str(input.topic, 140) || "Presentation";
    const raw = (Array.isArray(out?.slides) ? out.slides : []).filter((x) => x && typeof x === "object");
    slides = raw.map(cleanSlide);
    if (slides[0]) slides[0] = { ...slides[0], layout: "title", subtitle: slides[0].subtitle || school };
    if (pictures) await addPictures(user, cfg, slides, raw, pictures, str(input.topic, 200));
    else slides = slides.map((x) => (x.layout === "image" ? { ...x, layout: "bullets" } : x));
    slides = slides.filter(Boolean);
    source = { topic: str(input.topic, 300), audience: str(input.audience, 120) };
  } else if (kind === "class_results" || kind === "monthly_review") {
    const data = kind === "class_results" ? await resultsData(user, input) : await reviewData(user, input);
    const out = await askJson(cfg, user, {
      kind: "slides",
      question: `[deck:${kind}] ${data.title}`.slice(0, 500),
      units: UNITS.deck,
      system: `You write ${data.brief}
The number slides are already made from the school's records (DATA_SLIDES). For each, return its id with a better "title" if needed, a one-sentence "caption" that says what the numbers mean, and speaker "notes". Use only the numbers in FACTS; never invent figures or names.
${data.extras} Each extra slide uses layout "bullets", "two_column" or "quote" (and "closing" for the last) and has "notes". ${STYLE(language)}
Also return "title" and "subtitle" for the title slide. Return {"title", "subtitle", "dataSlides": [{"id", "title", "caption", "notes"}], "extraSlides": [..]}.`,
      contents: `DECK_DATA: ${JSON.stringify({ facts: data.facts, dataSlides: data.slides.map(({ id, layout, title }) => ({ id, layout, title })) })}`,
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          dataSlides: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, caption: { type: "string" }, notes: { type: "string" } }, required: ["id"] } },
          extraSlides: { type: "array", items: SLIDE_JSON },
        },
        required: ["dataSlides", "extraSlides"],
      },
    });
    const words = new Map((Array.isArray(out?.dataSlides) ? out.dataSlides : []).map((d) => [String(d?.id), d]));
    const extras = (Array.isArray(out?.extraSlides) ? out.extraSlides : []).map(cleanSlide).filter(Boolean);
    const closing = extras.filter((s) => s.layout === "closing");
    title = str(out?.title, 140) || data.title;
    slides = [
      { layout: "title", title, subtitle: str(out?.subtitle, 200) || data.subtitle, notes: "" },
      ...data.slides.map(({ id, ...s }) => {
        const w = words.get(id) ?? {};
        return cleanSlide({ ...s, fromRecords: true, title: str(w.title, 140) || s.title, caption: w.caption, notes: w.notes });
      }),
      ...extras.filter((s) => s.layout !== "closing"),
      ...(closing.length ? closing.slice(0, 1) : [{ layout: "closing", title: "Thank you" }]),
    ];
    source = data.source;
  } else {
    throw AppError.badRequest("Unknown presentation type", "AI_DECK_KIND");
  }

  if (!slides.length) throw new AppError(502, "The AI didn't write any slides. Try again.", "AI_EMPTY");
  const deck = await AiDeck.create({ tenantId: user.tenantId, userId: user.id, kind, title, language, theme, source, slides: slides.slice(0, MAX_SLIDES) });
  return { deck: serialize(deck.toObject()) };
}

/** Whether a slide's numbers come from the records (older decks have no flag: their number slides do). */
const fromRecords = (slide, deck) => slide.fromRecords ?? (deck.kind !== "topic" && Boolean(slide.chart || slide.table || slide.stats));

/** Rewrites one slide; number slides keep their numbers (only the words change). */
export async function regenerateSlide(user, id, index, { instruction = "" }) {
  const deck = await AiDeck.findOne({ _id: id, tenantId: user.tenantId, userId: user.id }).lean();
  if (!deck) throw AppError.notFound("Presentation not found", "AI_DECK_NOT_FOUND");
  const current = deck.slides[index];
  if (!current) throw AppError.notFound("Slide not found", "AI_DECK_NO_SLIDE");
  const cfg = await assertReady(user, UNITS.slide);
  // Charts always keep their data; slides from the records keep every number
  const dataSlide = fromRecords(current, deck) || Boolean(current.chart);
  const out = await askJson(cfg, user, {
    kind: "slides",
    question: `[slide] ${deck.title}: ${instruction || "rewrite"}`.slice(0, 500),
    units: UNITS.slide,
    level: "minimal",
    system: `You improve one slide of the presentation "${deck.title}" (slides: ${deck.slides.map((s) => s.title).join(" | ")}).
${dataSlide ? 'This slide shows numbers from the school\'s records: keep its layout and don\'t change any number; only improve "title", "caption" and "notes".' : "Keep its place in the presentation; you may change the layout if it helps."}
${instruction ? `What to change: ${instruction}` : "Make it clearer and more engaging."} ${STYLE(deck.language)} Return the slide.`,
    contents: `DECK_SLIDE: ${JSON.stringify(current)}`,
    schema: { ...SLIDE_JSON, properties: { ...SLIDE_JSON.properties, caption: { type: "string" } } },
  });
  const next = dataSlide ? cleanSlide({ ...current, title: str(out?.title, 140) || current.title, caption: out?.caption ?? current.caption, notes: out?.notes ?? current.notes }) : cleanSlide({ ...out, layout: index === 0 ? "title" : out?.layout });
  if (!next?.title) throw new AppError(502, "The AI couldn't rewrite that slide. Try again.", "AI_EMPTY");
  const updated = await AiDeck.findOneAndUpdate({ _id: id, tenantId: user.tenantId, userId: user.id }, { $set: { [`slides.${index}`]: next } }, { new: true }).lean();
  return { deck: serialize(updated) };
}

/** Adds one new slide written by the AI after slide `after`. */
export async function insertSlide(user, id, { after, instruction }) {
  const deck = await AiDeck.findOne({ _id: id, tenantId: user.tenantId, userId: user.id }).lean();
  if (!deck) throw AppError.notFound("Presentation not found", "AI_DECK_NOT_FOUND");
  if (deck.slides.length >= MAX_SLIDES) throw AppError.badRequest(`A presentation can have up to ${MAX_SLIDES} slides.`, "AI_DECK_FULL");
  const at = Math.min(Math.max(Number(after) || 0, 0), deck.slides.length - 1);
  const cfg = await assertReady(user, UNITS.insert);
  const out = await askJson(cfg, user, {
    kind: "slides",
    question: `[new slide] ${deck.title}: ${instruction}`.slice(0, 500),
    units: UNITS.insert,
    level: "minimal",
    system: `You add ONE new slide to the presentation "${deck.title}", after slide ${at + 1} ("${deck.slides[at]?.title ?? ""}"). All slides: ${deck.slides.map((x) => x.title).join(" | ")}.
The new slide should be: ${instruction}
Choose the layout that fits best: "bullets", "two_column", "quote", "table", "stats" or "section". In a table or stats, use only facts you're sure of or that the user gave; never invent figures about the school. ${STYLE(deck.language)} Include "notes". Return the slide.`,
    contents: `DECK_NEW: ${JSON.stringify({ instruction, after: at })}`,
    schema: { ...SLIDE_JSON, properties: { ...SLIDE_JSON.properties, caption: { type: "string" } } },
  });
  const slide = cleanSlide({ ...out, layout: ["title", "closing"].includes(out?.layout) ? "bullets" : out?.layout, fromRecords: false });
  if (!slide?.title) throw new AppError(502, "The AI couldn't write that slide. Try again.", "AI_EMPTY");
  const updated = await AiDeck.findOneAndUpdate({ _id: id, tenantId: user.tenantId, userId: user.id }, { $push: { slides: { $each: [slide], $position: at + 1 } } }, { new: true }).lean();
  return { deck: serialize(updated), index: at + 1 };
}

const TRANSLATABLE = { type: "array", items: { type: "string" } };
/** Translates every slide's words; numbers, names in tables and chart data stay as they are. */
export async function translateDeck(user, id, { language }) {
  const deck = await AiDeck.findOne({ _id: id, tenantId: user.tenantId, userId: user.id }).lean();
  if (!deck) throw AppError.notFound("Presentation not found", "AI_DECK_NOT_FOUND");
  const cfg = await assertReady(user, UNITS.translate);
  // Only the words: tables from the records hold names and amounts, so only their headings go
  const items = deck.slides.map((x, i) => ({
    i,
    title: x.title,
    subtitle: x.subtitle,
    caption: x.caption,
    notes: x.notes,
    bullets: x.bullets,
    leftHeading: x.left?.heading,
    leftBullets: x.left?.bullets,
    rightHeading: x.right?.heading,
    rightBullets: x.right?.bullets,
    quote: x.quote,
    attribution: x.attribution,
    tableHead: x.table?.head,
    tableRows: x.table && !fromRecords(x, deck) ? x.table.rows : undefined,
    statLabels: x.stats?.map((st) => st.label),
    statHints: x.stats?.map((st) => st.hint ?? ""),
    seriesNames: x.chart?.series.map((se) => se.name),
  }));
  const out = await askJson(cfg, user, {
    kind: "slides",
    question: `[translate:${language}] ${deck.title}`.slice(0, 500),
    units: UNITS.translate,
    system: `Translate this school presentation's slides into ${LANGUAGES[language]}. Keep the meaning, tone and length; keep people's and places' names, numbers and amounts exactly as they are (digits 0-9). Return the same list with the same "i" and the same fields, each translated; keep arrays the same length. Also return the translated deck "title".`,
    contents: `DECK_TRANSLATE: ${JSON.stringify({ title: deck.title, items })}`,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { i: { type: "integer" }, title: { type: "string" }, subtitle: { type: "string" }, caption: { type: "string" }, notes: { type: "string" }, bullets: TRANSLATABLE, leftHeading: { type: "string" }, leftBullets: TRANSLATABLE, rightHeading: { type: "string" }, rightBullets: TRANSLATABLE, quote: { type: "string" }, attribution: { type: "string" }, tableHead: TRANSLATABLE, tableRows: { type: "array", items: TRANSLATABLE }, statLabels: TRANSLATABLE, statHints: TRANSLATABLE, seriesNames: TRANSLATABLE },
            required: ["i"],
          },
        },
      },
      required: ["items"],
    },
  });
  const byIndex = new Map((Array.isArray(out?.items) ? out.items : []).map((t) => [Number(t?.i), t]));
  // A translated value replaces the original only when it has the same shape
  const same = (a, b) => (Array.isArray(a) && Array.isArray(b) && a.length === b.length ? a : b);
  const pick = (t, o) => (typeof t === "string" && t.trim() ? t : o);
  const slides = deck.slides.map((x, i) => {
    const t = byIndex.get(i);
    if (!t) return x;
    return cleanSlide({
      ...x,
      title: pick(t.title, x.title),
      subtitle: x.subtitle && pick(t.subtitle, x.subtitle),
      caption: x.caption && pick(t.caption, x.caption),
      notes: x.notes && pick(t.notes, x.notes),
      bullets: x.bullets && same(t.bullets, x.bullets),
      left: x.left && { heading: pick(t.leftHeading, x.left.heading), bullets: same(t.leftBullets, x.left.bullets) },
      right: x.right && { heading: pick(t.rightHeading, x.right.heading), bullets: same(t.rightBullets, x.right.bullets) },
      quote: x.quote && pick(t.quote, x.quote),
      attribution: x.attribution && pick(t.attribution, x.attribution),
      table: x.table && { head: same(t.tableHead, x.table.head), rows: x.table.rows.map((r, k) => (Array.isArray(t.tableRows?.[k]) ? same(t.tableRows[k], r) : r)) },
      stats: x.stats?.map((st, k) => ({ ...st, label: pick(t.statLabels?.[k], st.label), hint: st.hint && pick(t.statHints?.[k], st.hint) })),
      chart: x.chart && { ...x.chart, series: x.chart.series.map((se, k) => ({ ...se, name: pick(t.seriesNames?.[k], se.name) })) },
    });
  });
  const updated = await AiDeck.findOneAndUpdate(
    { _id: id, tenantId: user.tenantId, userId: user.id },
    { $set: { slides, language, title: str(out?.title, 140) || deck.title } },
    { new: true }
  ).lean();
  return { deck: serialize(updated) };
}

// ---------------------------------------------------------------------------
// Pictures on slides
// ---------------------------------------------------------------------------

/** A short-lived signature so the browser uploads a picture straight to Cloudinary. */
export async function imageUploadSignature(user) {
  const cfg = await cloudinaryConfig();
  if (!cfg) throw AppError.badRequest("Picture uploads aren't set up on EduFlow yet. Contact support.", "UPLOADS_NOT_CONFIGURED");
  const params = {
    allowed_formats: "png,jpg,jpeg,webp",
    folder: `${cfg.folder}/slides/${user.tenantId}`,
    timestamp: Math.floor(Date.now() / 1000),
    // Big enough for a projector, small enough for a quick PowerPoint
    transformation: "c_limit,w_1600,h_1600",
  };
  return { uploadUrl: `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`, fields: { ...params, api_key: cfg.apiKey, signature: sign(params, cfg.apiSecret) } };
}

// Test mode: a public sample picture instead of calling an image model and Cloudinary
const FAKE_IMAGE = "https://res.cloudinary.com/demo/image/upload/sample.jpg";

/** Draws one picture and stores it on Cloudinary; logs it as AI use either way. Returns the URL. */
async function drawPicture(user, cfg, describe) {
  const question = `[image] ${describe}`.slice(0, 500);
  try {
    let url;
    if (cfg.imageModel === "fake-image") url = FAKE_IMAGE;
    else {
      const img = await makeImage(cfg, `A clean, friendly illustration for a school presentation slide (India), no text or letters in the image: ${describe}`);
      if (!img) throw new AppError(422, "The AI couldn't make a picture for that (it may have been blocked). Try describing it differently.", "AI_IMAGE_EMPTY");
      url = await uploadDataUri(`data:${img.mimeType};base64,${img.data}`, `slides/${user.tenantId}`);
    }
    await log(user, cfg, { kind: "image", question, usage: { input: 0, output: 0 }, ok: true, units: UNITS.image });
    return url;
  } catch (err) {
    await log(user, cfg, { kind: "image", question, usage: { input: 0, output: 0 }, ok: false, units: UNITS.image });
    if (err instanceof AppError) throw err;
    throw geminiError(err);
  }
}

/**
 * Puts pictures on `want` slides of a new topic deck (in place). Uses the slides the AI chose as
 * "image" first, then turns evenly spread bullet slides into picture slides (they keep their
 * words). Pictures are drawn together; a slide whose picture fails goes back to bullets.
 */
async function addPictures(user, cfg, slides, raw, want, topic) {
  const last = slides.length - 1;
  const inner = (i) => i > 0 && i < last;
  const chosen = slides.map((x, i) => i).filter((i) => inner(i) && slides[i].layout === "image");
  if (chosen.length < want) {
    const spare = slides.map((x, i) => i).filter((i) => inner(i) && slides[i].layout === "bullets" && slides[i].bullets?.length);
    // Evenly through the deck: the middle of each equal share of the spare slides
    const need = Math.min(want - chosen.length, spare.length);
    for (let k = 0; k < need; k++) chosen.push(spare[Math.floor(((k + 0.5) * spare.length) / need)]);
  }
  const picks = [...new Set(chosen)].sort((a, b) => a - b).slice(0, want);
  const others = slides.map((x, i) => i).filter((i) => slides[i].layout === "image" && !picks.includes(i));
  for (const i of others) slides[i] = { ...slides[i], layout: "bullets" };
  await Promise.all(
    picks.map(async (i) => {
      const s = slides[i];
      const describe = str(raw[i]?.imagePrompt, 300) || `${s.title} (${topic})${s.bullets?.length ? `: ${s.bullets.slice(0, 3).join(", ")}` : ""}`;
      const bullets = s.bullets?.length ? s.bullets.slice(0, 4) : [...(s.left?.bullets ?? []), ...(s.right?.bullets ?? [])].slice(0, 4);
      try {
        const url = await drawPicture(user, cfg, describe);
        slides[i] = cleanSlide({ ...s, layout: "image", bullets, image: { url, alt: describe.slice(0, 160), source: "ai" } });
      } catch {
        slides[i] = { ...s, layout: s.layout === "image" ? "bullets" : s.layout, ...(s.layout === "image" ? { bullets } : {}) };
      }
    })
  );
}

/** Makes a picture for a slide with the AI image model and puts it on the slide. */
export async function generateSlideImage(user, id, index, { prompt }) {
  const deck = await AiDeck.findOne({ _id: id, tenantId: user.tenantId, userId: user.id }).lean();
  if (!deck) throw AppError.notFound("Presentation not found", "AI_DECK_NOT_FOUND");
  const slide = deck.slides[index];
  if (!slide) throw AppError.notFound("Slide not found", "AI_DECK_NO_SLIDE");
  const settings = await aiConfig();
  if (!imagesReady(settings)) throw AppError.badRequest("AI pictures aren't turned on yet. Upload a picture instead, or ask EduFlow support.", "AI_IMAGES_OFF");
  const cfg = await assertReady(user, UNITS.image);
  const describe = prompt?.trim() || `${slide.title}${slide.bullets?.length ? `: ${slide.bullets.slice(0, 3).join(", ")}` : ""}`;
  const url = await drawPicture(user, cfg, describe);
  // A text slide becomes a picture slide (keeping its words)
  const layout = ["bullets", "two_column", "section", "quote"].includes(slide.layout) ? "image" : slide.layout;
  const next = cleanSlide({ ...slide, layout, image: { url, alt: describe.slice(0, 160), source: "ai" } });
  const updated = await AiDeck.findOneAndUpdate({ _id: id, tenantId: user.tenantId, userId: user.id }, { $set: { [`slides.${index}`]: next } }, { new: true }).lean();
  return { deck: serialize(updated) };
}

// ---------------------------------------------------------------------------
// Saved presentations (each member sees only their own)
// ---------------------------------------------------------------------------

function serialize(d) {
  return { id: String(d._id), kind: d.kind, title: d.title, language: d.language, theme: d.theme, source: d.source ?? {}, slides: d.slides ?? [], createdAt: d.createdAt, updatedAt: d.updatedAt };
}

export async function listDecks(user) {
  const decks = await AiDeck.aggregate([
    { $match: { tenantId: new mongoose.Types.ObjectId(String(user.tenantId)), userId: new mongoose.Types.ObjectId(String(user.id)) } },
    { $sort: { updatedAt: -1 } },
    { $limit: 100 },
    // The first slide, for the card's thumbnail
    { $project: { title: 1, kind: 1, theme: 1, language: 1, updatedAt: 1, createdAt: 1, slides: { $size: "$slides" }, cover: { $arrayElemAt: ["$slides", 0] } } },
  ]);
  return { decks: decks.map((d) => ({ id: String(d._id), title: d.title, kind: d.kind, theme: d.theme, language: d.language, slides: d.slides, cover: d.cover ?? null, updatedAt: d.updatedAt, createdAt: d.createdAt })) };
}

export async function getDeck(user, id) {
  const d = await AiDeck.findOne({ _id: id, tenantId: user.tenantId, userId: user.id }).lean();
  if (!d) throw AppError.notFound("Presentation not found", "AI_DECK_NOT_FOUND");
  return { deck: serialize(d) };
}

/** Saves edits from the editor (title, theme, slides). */
export async function updateDeck(user, id, { title, theme, slides }) {
  const set = {};
  if (title !== undefined) set.title = str(title, 140) || "Presentation";
  if (theme !== undefined) {
    if (!DECK_THEMES.includes(theme)) throw AppError.badRequest("Unknown theme", "VALIDATION_ERROR");
    set.theme = theme;
  }
  if (slides !== undefined) {
    const clean = (Array.isArray(slides) ? slides : []).slice(0, MAX_SLIDES).map(cleanSlide).filter(Boolean);
    if (!clean.length) throw AppError.badRequest("A presentation needs at least one slide", "VALIDATION_ERROR");
    set.slides = clean;
  }
  const d = await AiDeck.findOneAndUpdate({ _id: id, tenantId: user.tenantId, userId: user.id }, { $set: set }, { new: true }).lean();
  if (!d) throw AppError.notFound("Presentation not found", "AI_DECK_NOT_FOUND");
  return { deck: serialize(d) };
}

export async function deleteDeck(user, id) {
  const { deletedCount } = await AiDeck.deleteOne({ _id: id, tenantId: user.tenantId, userId: user.id });
  if (!deletedCount) throw AppError.notFound("Presentation not found", "AI_DECK_NOT_FOUND");
  return { ok: true };
}

/** Tests this member can make a results presentation for (latest first, with marks entered). */
export async function deckSources(user) {
  const scope = await teacherScope(user);
  const out = { kinds: ["topic", ...(TEACHING.includes(user.role) ? ["class_results"] : []), ...(MANAGERS.includes(user.role) ? ["monthly_review"] : [])], tests: [] };
  if (TEACHING.includes(user.role)) {
    const list = await listExams(user.tenantId, { page: 1, limit: 30 }, user);
    out.tests = list.exams
      .filter((e) => e.stats.completed > 0 && canTeachClass(scope, e.grade, e.section))
      .map((e) => ({ id: e.id, name: e.name, class: cls(e.grade, e.section), date: e.date, average: e.stats.average }));
  }
  return out;
}

export { DECK_KINDS, DECK_THEMES };
