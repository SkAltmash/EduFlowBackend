import crypto from "node:crypto";
import mongoose from "mongoose";
import env from "../../config/env.js";
import WhatsAppConfig from "../../models/WhatsAppConfig.js";
import WhatsAppMessage from "../../models/WhatsAppMessage.js";
import Student from "../../models/Student.js";
import Tenant from "../../models/Tenant.js";
import User from "../../models/User.js";
import Payment from "../../models/Payment.js";
import Invoice from "../../models/Invoice.js";
import Attendance from "../../models/Attendance.js";
import AppError from "../../utils/AppError.js";
import { canEncrypt, decrypt, encrypt } from "../../utils/crypto.js";
import * as messages from "./whatsapp.messages.js";
import * as exams from "../exams/exams.service.js";
import * as performance from "../performance/performance.service.js";

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
const utcToday = () => new Date().toISOString().slice(0, 10);

/** Digits only, with the school's country code added to local numbers; null if it can't be a phone number. */
export function normalizePhone(raw, countryCode = "91") {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (String(raw).trim().startsWith("00")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = countryCode + digits.slice(1);
  else if (digits.length === 10) digits = countryCode + digits;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

async function loadConfig(tenantId, withToken = false) {
  const query = WhatsAppConfig.findOne({ tenantId });
  if (withToken) query.select("+accessTokenEnc");
  return (await query.lean()) ?? { mode: "link", defaultCountryCode: "91", phoneNumberId: "", displayPhone: "", templates: {} };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function serializeSettings(cfg) {
  const templates = Object.fromEntries(
    Object.entries(messages.TEMPLATES).map(([type, t]) => [
      type,
      {
        ...t,
        name: cfg.templates?.[type]?.name ?? "",
        language: cfg.templates?.[type]?.language || "en",
        params: t.example.length,
      },
    ])
  );
  return {
    mode: cfg.mode ?? "link",
    defaultCountryCode: cfg.defaultCountryCode ?? "91",
    phoneNumberId: cfg.phoneNumberId ?? "",
    displayPhone: cfg.displayPhone ?? "",
    // Only whether a token exists, never the token itself
    tokenSet: Boolean(cfg.accessTokenEnc),
    tokenReadable: Boolean(cfg.accessTokenEnc) && decrypt(cfg.accessTokenEnc) !== null,
    encryptionAvailable: canEncrypt(),
    templates,
    webhookUrl: "/api/whatsapp/webhook",
    webhookConfigured: Boolean(env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_APP_SECRET),
  };
}

export async function getSettings(tenantId) {
  return { settings: serializeSettings(await loadConfig(tenantId, true)) };
}

export async function updateSettings(tenantId, userId, data) {
  const cfg = await loadConfig(tenantId, true);
  const update = { updatedBy: userId };
  for (const key of ["mode", "defaultCountryCode", "phoneNumberId", "displayPhone"]) if (data[key] !== undefined) update[key] = data[key];
  if (data.templates) {
    for (const [type, t] of Object.entries(data.templates)) {
      if (t.name !== undefined) update[`templates.${type}.name`] = t.name;
      if (t.language !== undefined) update[`templates.${type}.language`] = t.language;
    }
  }
  if (data.accessToken !== undefined) {
    if (data.accessToken && !canEncrypt()) {
      throw AppError.badRequest("The server has no DATA_ENCRYPTION_KEY, so tokens can't be stored safely. Ask your platform admin to set it.", "ENCRYPTION_UNAVAILABLE");
    }
    update.accessTokenEnc = data.accessToken ? encrypt(data.accessToken) : "";
  }

  // Automatic sending needs a number id and a usable token
  const next = { ...cfg, ...update, accessTokenEnc: update.accessTokenEnc ?? cfg.accessTokenEnc };
  if (next.mode === "api" && (!next.phoneNumberId || !decrypt(next.accessTokenEnc))) {
    throw AppError.badRequest("Add the Phone number ID and access token before switching on automatic sending.", "API_NOT_CONFIGURED");
  }

  await WhatsAppConfig.updateOne({ tenantId }, { $set: update, $setOnInsert: { tenantId } }, { upsert: true });
  return getSettings(tenantId);
}

// ---------------------------------------------------------------------------
// Meta Cloud API
// ---------------------------------------------------------------------------

/** Sends one template message. Returns { id } or throws an Error with Meta's message. */
async function graphSend({ phoneNumberId, token, to, template, language, params }) {
  const res = await fetch(`${env.WHATSAPP_GRAPH_URL}/${env.WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: template,
        language: { code: language },
        ...(params.length ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: messages.cleanParam(p) })) }] } : {}),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.messages?.[0]?.id) {
    const e = body.error;
    throw new Error(e ? `${e.message}${e.error_data?.details ? ` — ${e.error_data.details}` : ""} (code ${e.code})` : `WhatsApp API error ${res.status}`);
  }
  return { id: body.messages[0].id };
}

async function apiCredentials(tenantId) {
  const cfg = await loadConfig(tenantId, true);
  const token = decrypt(cfg.accessTokenEnc);
  if (!cfg.phoneNumberId || !token) {
    throw AppError.badRequest("Automatic sending isn't set up. Add the WhatsApp Business details in Settings.", "API_NOT_CONFIGURED");
  }
  return { cfg, token };
}

/** Sends Meta's built-in "hello_world" template to check the number and token work. */
export async function testSend(tenantId, { to }) {
  const { cfg, token } = await apiCredentials(tenantId);
  const phone = normalizePhone(to, cfg.defaultCountryCode);
  if (!phone) throw AppError.badRequest("Enter a valid phone number", "INVALID_PHONE");
  try {
    const { id } = await graphSend({ phoneNumberId: cfg.phoneNumberId, token, to: phone, template: "hello_world", language: "en_US", params: [] });
    return { ok: true, messageId: id, to: phone };
  } catch (err) {
    throw AppError.badRequest(err.message, "WHATSAPP_API_ERROR");
  }
}

// ---------------------------------------------------------------------------
// Recipients: who gets what, built only from data in the database
// ---------------------------------------------------------------------------

/**
 * refs per type:
 *   fee_receipt        { paymentId }
 *   fee_reminder       { studentId }
 *   absence            { studentId, date }
 *   attendance_summary { studentId, month }
 *   exam_result        { examId, studentId }
 *   progress_report    { studentId, month }
 *   performance_report { studentId, from, to, grade?, section? }
 * Returns one entry per ref: { refKey, studentId, studentName, guardianName, to, text, params, skip? }.
 */
async function buildRecipients(tenantId, type, refs, { countryCode, today = utcToday() }) {
  const tenant = await Tenant.findById(tenantId).lean();
  const school = tenant?.name ?? "the school";

  if (type === "fee_receipt") {
    const payments = await Payment.find({ tenantId, _id: { $in: refs.map((r) => r.paymentId) } }).lean();
    const byId = new Map(payments.map((p) => [String(p._id), p]));
    const students = await Student.find({ tenantId, _id: { $in: payments.map((p) => p.studentId) } }).lean();
    const studentById = new Map(students.map((s) => [String(s._id), s]));
    const balances = await Invoice.aggregate([
      { $match: { tenantId: oid(tenantId), studentId: { $in: payments.map((p) => p.studentId) } } },
      { $group: { _id: "$studentId", balance: { $sum: { $max: [{ $subtract: [{ $subtract: ["$amount", "$discount"] }, "$paid"] }, 0] } } } },
    ]);
    const balanceBy = new Map(balances.map((b) => [String(b._id), b.balance]));

    return refs.map(({ paymentId }) => {
      const p = byId.get(paymentId);
      if (!p) return { refKey: paymentId, skip: "Payment not found" };
      const s = studentById.get(String(p.studentId));
      const base = { refKey: paymentId, studentId: String(p.studentId), studentName: p.student.fullName, guardianName: s?.guardianName || p.student.guardianName || "" };
      if (p.voided?.at) return { ...base, skip: "This receipt is void" };
      const to = normalizePhone(s?.guardianPhone, countryCode);
      if (!to) return { ...base, skip: "No guardian phone number" };
      const msg = messages.feeReceipt({
        school,
        guardianName: base.guardianName,
        studentName: p.student.fullName,
        amount: p.amount,
        receiptNo: p.receiptNo,
        date: p.date,
        balance: balanceBy.get(String(p.studentId)) ?? 0,
        allocations: p.allocations,
      });
      return { ...base, to, ...msg };
    });
  }

  const studentIds = [...new Set(refs.map((r) => r.studentId))];
  const students = await Student.find({ tenantId, _id: { $in: studentIds } }).lean();
  const studentById = new Map(students.map((s) => [String(s._id), s]));

  const withStudent = (ref, refKey, build) => {
    const s = studentById.get(ref.studentId);
    if (!s) return { refKey, skip: "Student not found" };
    const base = { refKey, studentId: ref.studentId, studentName: fullName(s), guardianName: s.guardianName || "" };
    const to = normalizePhone(s.guardianPhone, countryCode);
    if (!to) return { ...base, skip: "No guardian phone number" };
    const built = build(s, base);
    return built.skip ? { ...base, ...built } : { ...base, to, ...built };
  };

  if (type === "fee_reminder") {
    const dues = await Invoice.find({ tenantId, studentId: { $in: studentIds } }).sort({ dueDate: 1 }).lean();
    const byStudent = new Map();
    for (const d of dues) {
      const balance = d.amount - d.discount - d.paid;
      if (balance <= 0) continue;
      const t = byStudent.get(String(d.studentId)) ?? { balance: 0, overdue: 0, oldestOverdue: null, nextDue: null };
      t.balance += balance;
      if (d.dueDate < today) {
        t.overdue += balance;
        t.oldestOverdue ??= d.dueDate;
      } else t.nextDue ??= d.dueDate;
      byStudent.set(String(d.studentId), t);
    }
    return refs.map((ref) =>
      withStudent(ref, ref.studentId, (s, base) => {
        const t = byStudent.get(ref.studentId);
        if (!t) return { skip: "Nothing due" };
        return messages.feeReminder({ school, guardianName: base.guardianName, studentName: base.studentName, ...t });
      })
    );
  }

  if (type === "absence") {
    const records = await Attendance.find({ tenantId, $or: refs.map((r) => ({ studentId: r.studentId, date: r.date })) }).lean();
    const byKey = new Map(records.map((r) => [`${r.studentId}:${r.date}`, r]));
    return refs.map((ref) =>
      withStudent(ref, `${ref.studentId}:${ref.date}`, (s, base) => {
        const r = byKey.get(`${ref.studentId}:${ref.date}`);
        if (!r) return { skip: "Attendance not marked" };
        if (r.status !== "absent" && r.status !== "late") return { skip: `Marked ${r.status}` };
        return messages.absence({ school, guardianName: base.guardianName, studentName: base.studentName, status: r.status, date: r.date, note: r.note });
      })
    );
  }

  if (type === "attendance_summary") {
    const months = [...new Set(refs.map((r) => r.month))];
    const records = await Attendance.find(
      { tenantId, studentId: { $in: studentIds }, $or: months.map((m) => ({ date: { $gte: `${m}-01`, $lte: `${m}-31` } })) },
      { studentId: 1, date: 1, status: 1 }
    ).lean();
    const counts = new Map();
    for (const r of records) {
      const key = `${r.studentId}:${r.date.slice(0, 7)}`;
      const c = counts.get(key) ?? { present: 0, absent: 0, late: 0, leave: 0 };
      c[r.status] += 1;
      counts.set(key, c);
    }
    return refs.map((ref) =>
      withStudent(ref, `${ref.studentId}:${ref.month}`, (s, base) => {
        const c = counts.get(`${ref.studentId}:${ref.month}`);
        if (!c) return { skip: "No attendance this month" };
        return messages.attendanceSummary({ school, guardianName: base.guardianName, studentName: base.studentName, month: ref.month, counts: c });
      })
    );
  }

  if (type === "exam_result") {
    // One computed exam view per exam (ranks need the whole class)
    const views = new Map();
    for (const examId of [...new Set(refs.map((r) => r.examId))]) {
      try {
        views.set(examId, await exams.getExam(tenantId, examId));
      } catch {
        views.set(examId, null);
      }
    }
    return refs.map((ref) =>
      withStudent(ref, `${ref.examId}:${ref.studentId}`, (s, base) => {
        const view = views.get(ref.examId);
        if (!view) return { skip: "Test not found" };
        const row = view.students.find((r) => r.student.id === ref.studentId);
        if (!row) return { skip: "Not in this test's class" };
        if (row.result.status === "pending") return { skip: "Marks not complete" };
        const cls = row.student.grade ? (row.student.section ? `${row.student.grade} - ${row.student.section}` : row.student.grade) : "";
        return messages.examResult({
          school,
          guardianName: base.guardianName,
          studentName: base.studentName,
          className: cls,
          exam: view.exam,
          result: row.result,
          ranked: view.stats.completed,
          remarks: row.remarks,
        });
      })
    );
  }

  if (type === "progress_report") {
    const reports = new Map();
    for (const ref of refs) {
      const key = `${ref.studentId}:${ref.month}`;
      if (!reports.has(key) && studentById.has(ref.studentId)) {
        reports.set(key, await exams.studentMonthlyReport(tenantId, ref.studentId, { month: ref.month }));
      }
    }
    return refs.map((ref) =>
      withStudent(ref, `progress:${ref.studentId}:${ref.month}`, (s, base) => {
        const report = reports.get(`${ref.studentId}:${ref.month}`);
        const anyTest = report?.tests.some((t) => t.result.status !== "pending");
        if (!report || (!anyTest && report.attendance.days === 0)) return { skip: "Nothing to report this month" };
        return messages.progressReport({ school, guardianName: base.guardianName, report });
      })
    );
  }

  if (type === "performance_report") {
    // One leaderboard per period/class scope; ranks need everyone in it
    const boards = new Map();
    const scopeKey = (r) => `${r.from}|${r.to}|${r.grade ?? ""}|${r.section ?? ""}`;
    for (const ref of refs) {
      if (!boards.has(scopeKey(ref))) boards.set(scopeKey(ref), await performance.leaderboard(tenantId, { from: ref.from, to: ref.to, grade: ref.grade, section: ref.section }));
    }
    const short = (d) => messages.formatDay(d).replace(/ \d{4}$/, "");
    return refs.map((ref) =>
      withStudent(ref, `perf:${ref.studentId}:${ref.from}:${ref.to}`, (s, base) => {
        const board = boards.get(scopeKey(ref));
        const row = board.students.find((r) => r.id === ref.studentId);
        if (!row) return { skip: "Not in this leaderboard" };
        if (row.marks.average === null && row.attendance.rate === null) return { skip: "No marks or attendance in this period" };
        const classSize = board.students.filter((r) => r.grade === row.grade && r.section === row.section && r.rank.inClass !== null).length;
        return messages.performanceReport({
          school,
          guardianName: base.guardianName,
          row,
          period: `${short(ref.from)} to ${messages.formatDay(ref.to)}`,
          classSize,
          ranked: board.summary.ranked,
          scoped: Boolean(ref.grade),
        });
      })
    );
  }

  throw AppError.badRequest("Unknown message type", "INVALID_TYPE");
}

/** Latest log entry per refKey, for "sent 2 hours ago" and duplicate warnings. */
async function lastSent(tenantId, type, refKeys) {
  if (!refKeys.length) return new Map();
  const rows = await WhatsAppMessage.aggregate([
    { $match: { tenantId: oid(tenantId), type, refKey: { $in: refKeys } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$refKey", status: { $first: "$status" }, mode: { $first: "$mode" }, at: { $first: "$createdAt" }, by: { $first: "$sentByName" }, error: { $first: "$error" } } },
  ]);
  return new Map(rows.map((r) => [r._id, { status: r.status, mode: r.mode, at: r.at, by: r.by, error: r.error ?? null }]));
}

const waLink = (to, text) => `https://wa.me/${to}?text=${encodeURIComponent(text)}`;

/** Recipients with ready-to-open wa.me links and their last send (works in both modes). */
export async function prepare(tenantId, { type, refs, today }) {
  const cfg = await loadConfig(tenantId);
  const list = await buildRecipients(tenantId, type, refs, { countryCode: cfg.defaultCountryCode, today });
  const last = await lastSent(tenantId, type, list.map((r) => r.refKey));
  const templateReady = Boolean(cfg.templates?.[type]?.name);
  return {
    mode: cfg.mode,
    // API mode needs an approved template name for this message type
    canSendAutomatically: cfg.mode === "api" && templateReady,
    recipients: list.map(({ params, ...r }) => ({
      ...r,
      ...(r.to && r.text ? { link: waLink(r.to, r.text) } : {}),
      last: last.get(r.refKey) ?? null,
    })),
  };
}

/** Records that staff opened these messages in WhatsApp (click-to-send). */
export async function logOpened(tenantId, user, { type, entries }) {
  const name = (await User.findById(user.id, { name: 1 }).lean())?.name ?? "";
  await WhatsAppMessage.insertMany(
    entries.map((e) => ({ tenantId, type, mode: "link", refKey: e.refKey, studentId: e.studentId, to: e.to ?? "", status: "opened", sentBy: user.id, sentByName: name }))
  );
  return { logged: entries.length };
}

/** Sends through the Cloud API. Recipients without a phone etc. are skipped, never fail the batch. */
export async function send(tenantId, user, { type, refs, today }) {
  const { cfg, token } = await apiCredentials(tenantId);
  if (cfg.mode !== "api") throw AppError.badRequest("Automatic sending is turned off. Turn it on in WhatsApp settings.", "API_DISABLED");
  const template = cfg.templates?.[type];
  if (!template?.name) {
    throw AppError.badRequest(`Add the approved template name for “${messages.TEMPLATES[type].title}” in WhatsApp settings.`, "TEMPLATE_MISSING");
  }

  const name = (await User.findById(user.id, { name: 1 }).lean())?.name ?? "";
  const list = await buildRecipients(tenantId, type, refs, { countryCode: cfg.defaultCountryCode, today });
  const results = new Array(list.length);

  // A few at a time: fast for a class, gentle on Meta's rate limits
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const r = list[i];
      if (r.skip) {
        results[i] = { refKey: r.refKey, studentName: r.studentName, status: "skipped", reason: r.skip };
        continue;
      }
      try {
        const { id } = await graphSend({ phoneNumberId: cfg.phoneNumberId, token, to: r.to, template: template.name, language: template.language || "en", params: r.params });
        await WhatsAppMessage.create({ tenantId, type, mode: "api", refKey: r.refKey, studentId: r.studentId, to: r.to, status: "sent", waMessageId: id, sentBy: user.id, sentByName: name });
        results[i] = { refKey: r.refKey, studentName: r.studentName, status: "sent" };
      } catch (err) {
        await WhatsAppMessage.create({ tenantId, type, mode: "api", refKey: r.refKey, studentId: r.studentId, to: r.to, status: "failed", error: err.message.slice(0, 500), sentBy: user.id, sentByName: name });
        results[i] = { refKey: r.refKey, studentName: r.studentName, status: "failed", reason: err.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, list.length) }, worker));

  return {
    results,
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };
}

export async function history(tenantId, { page, limit, type }) {
  const filter = { tenantId, ...(type && type !== "all" ? { type } : {}) };
  const [rows, total] = await Promise.all([
    WhatsAppMessage.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("studentId", "firstName lastName admissionNo").lean(),
    WhatsAppMessage.countDocuments(filter),
  ]);
  return {
    messages: rows.map((m) => ({
      id: String(m._id),
      type: m.type,
      mode: m.mode,
      status: m.status,
      to: m.to,
      student: m.studentId ? { id: String(m.studentId._id), fullName: fullName(m.studentId), admissionNo: m.studentId.admissionNo } : null,
      error: m.error ?? null,
      sentByName: m.sentByName ?? "",
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ---------------------------------------------------------------------------
// Webhook: delivery and read receipts from Meta
// ---------------------------------------------------------------------------

export function verifyWebhook(query) {
  if (!env.WHATSAPP_VERIFY_TOKEN) throw AppError.forbidden("Webhook not configured", "WEBHOOK_DISABLED");
  if (query["hub.mode"] !== "subscribe" || query["hub.verify_token"] !== env.WHATSAPP_VERIFY_TOKEN) {
    throw AppError.forbidden("Verification failed", "WEBHOOK_VERIFY_FAILED");
  }
  return String(query["hub.challenge"] ?? "");
}

/** Checks Meta's X-Hub-Signature-256 over the raw body. */
export function verifySignature(rawBody, header) {
  if (!env.WHATSAPP_APP_SECRET || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", env.WHATSAPP_APP_SECRET).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };

export async function handleWebhook(payload) {
  const statuses = (payload?.entry ?? []).flatMap((e) => (e.changes ?? []).flatMap((c) => c.value?.statuses ?? []));
  let updated = 0;
  for (const st of statuses) {
    if (!st.id || !st.status) continue;
    if (st.status === "failed") {
      const reason = st.errors?.map((e) => e.error_data?.details || e.message || e.title).filter(Boolean).join("; ") || "Delivery failed";
      updated += (await WhatsAppMessage.updateOne({ waMessageId: st.id }, { $set: { status: "failed", error: reason.slice(0, 500) } })).modifiedCount;
      continue;
    }
    const rank = STATUS_RANK[st.status];
    if (!rank) continue;
    // Statuses can arrive out of order: only move forward (sent → delivered → read)
    const lower = Object.entries(STATUS_RANK).filter(([, r]) => r < rank).map(([s]) => s);
    updated += (await WhatsAppMessage.updateOne({ waMessageId: st.id, status: { $in: lower } }, { $set: { status: st.status } })).modifiedCount;
  }
  return { updated };
}
