import mongoose from "mongoose";
import FeePlan from "../../models/FeePlan.js";
import Invoice from "../../models/Invoice.js";
import Payment, { PAYMENT_MODES } from "../../models/Payment.js";
import Counter from "../../models/Counter.js";
import Student from "../../models/Student.js";
import Tenant from "../../models/Tenant.js";
import User from "../../models/User.js";
import AppError from "../../utils/AppError.js";

// All amounts are integers in paise.

const COLLATION = { locale: "en", numericOrdering: true };
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const utcToday = () => new Date().toISOString().slice(0, 10);
const sum = (list, fn) => list.reduce((t, x) => t + fn(x), 0);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");

/** Name shown on receipts as "received by" / "voided by" (req.user only carries the id). */
async function userName(id) {
  const u = await User.findById(id, { name: 1 }).lean();
  return u?.name ?? "";
}

// Balance of a due, as a Mongo expression and in JS
const BALANCE_EXPR = { $subtract: [{ $subtract: ["$amount", "$discount"] }, "$paid"] };
const balanceOf = (inv) => inv.amount - inv.discount - inv.paid;

function invoiceStatus(inv, today) {
  const balance = balanceOf(inv);
  if (balance <= 0) return "paid";
  if (inv.dueDate < today) return "overdue";
  return inv.paid > 0 ? "partial" : "due";
}

function serializeInvoice(inv, today) {
  return {
    id: String(inv._id),
    planId: String(inv.planId),
    planName: inv.planName,
    label: inv.label,
    dueDate: inv.dueDate,
    items: inv.items,
    amount: inv.amount,
    discount: inv.discount,
    discountReason: inv.discountReason || "",
    paid: inv.paid,
    balance: balanceOf(inv),
    status: invoiceStatus(inv, today),
  };
}

function serializePayment(p) {
  return {
    id: String(p._id),
    receiptNo: p.receiptNo,
    studentId: String(p.studentId),
    student: p.student,
    date: p.date,
    amount: p.amount,
    mode: p.mode,
    reference: p.reference || "",
    note: p.note || "",
    allocations: p.allocations.map((a) => ({ invoiceId: String(a.invoiceId), label: a.label, planName: a.planName, amount: a.amount })),
    receivedByName: p.receivedByName || "",
    createdAt: p.createdAt,
    voided: p.voided?.at ? { at: p.voided.at, byName: p.voided.byName, reason: p.voided.reason } : null,
  };
}

function serializePlan(plan, stats) {
  const installments = plan.installments.map((i) => ({
    id: String(i._id),
    label: i.label,
    dueDate: i.dueDate,
    items: i.items.map((it) => ({ name: it.name, amount: it.amount })),
    total: sum(i.items, (it) => it.amount),
  }));
  return {
    id: String(plan._id),
    name: plan.name,
    academicYear: plan.academicYear || "",
    grade: plan.grade || "",
    description: plan.description || "",
    installments,
    total: sum(installments, (i) => i.total),
    archived: Boolean(plan.archived),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(stats ? { stats } : {}),
  };
}

async function findPlanOrThrow(tenantId, id) {
  const plan = await FeePlan.findOne({ _id: id, tenantId });
  if (!plan) throw AppError.notFound("Fee plan not found");
  return plan;
}

// ---------------------------------------------------------------------------
// Fee plans
// ---------------------------------------------------------------------------

export async function listPlans(tenantId, { archived }) {
  const filter = { tenantId };
  if (archived !== "all") filter.archived = archived === "true";
  const plans = await FeePlan.find(filter).sort({ createdAt: -1 }).lean();

  // Students assigned and money billed / collected per plan
  const stats = await Invoice.aggregate([
    { $match: { tenantId: oid(tenantId), planId: { $in: plans.map((p) => p._id) } } },
    {
      $group: {
        _id: "$planId",
        students: { $addToSet: "$studentId" },
        billed: { $sum: { $subtract: ["$amount", "$discount"] } },
        paid: { $sum: "$paid" },
      },
    },
  ]);
  const byPlan = new Map(stats.map((s) => [String(s._id), { students: s.students.length, billed: s.billed, paid: s.paid }]));

  return { plans: plans.map((p) => serializePlan(p, byPlan.get(String(p._id)) ?? { students: 0, billed: 0, paid: 0 })) };
}

export async function getPlan(tenantId, id) {
  const plan = await findPlanOrThrow(tenantId, id);
  const [stats] = await Invoice.aggregate([
    { $match: { tenantId: oid(tenantId), planId: plan._id } },
    { $group: { _id: null, students: { $addToSet: "$studentId" }, billed: { $sum: { $subtract: ["$amount", "$discount"] } }, paid: { $sum: "$paid" } } },
  ]);
  return {
    plan: serializePlan(plan, { students: stats?.students.length ?? 0, billed: stats?.billed ?? 0, paid: stats?.paid ?? 0 }),
  };
}

export async function createPlan(tenantId, userId, data) {
  const plan = await FeePlan.create({ ...data, tenantId, createdBy: userId });
  return getPlan(tenantId, plan._id);
}

/**
 * Edits apply to future assignments only: existing dues keep their amounts.
 * An installment that already has dues can't be removed.
 */
export async function updatePlan(tenantId, id, data) {
  const plan = await findPlanOrThrow(tenantId, id);

  if (data.installments) {
    const kept = new Set(data.installments.filter((i) => i._id).map((i) => i._id));
    const removed = plan.installments.filter((i) => !kept.has(String(i._id))).map((i) => i._id);
    if (removed.length && (await Invoice.exists({ tenantId, planId: plan._id, installmentId: { $in: removed } }))) {
      throw AppError.conflict(
        "An installment you removed already has dues for students. Keep it, or delete those dues first.",
        "INSTALLMENT_IN_USE"
      );
    }
  }

  Object.assign(plan, data);
  await plan.save();
  return getPlan(tenantId, plan._id);
}

export async function deletePlan(tenantId, id) {
  const plan = await findPlanOrThrow(tenantId, id);
  if (await Invoice.exists({ tenantId, planId: plan._id })) {
    throw AppError.conflict("This plan has been assigned to students. Archive it instead.", "PLAN_IN_USE");
  }
  await plan.deleteOne();
}

/** Creates the plan's dues for each chosen student. Students who already have them are skipped. */
export async function assignPlan(tenantId, id, { grade, section, studentIds, concession }) {
  const plan = await findPlanOrThrow(tenantId, id);
  if (plan.archived) throw AppError.badRequest("This plan is archived", "PLAN_ARCHIVED");

  const filter = { tenantId };
  if (studentIds?.length) filter._id = { $in: studentIds };
  else {
    filter.grade = grade;
    filter.status = "active";
    if (section !== undefined && section !== "") filter.section = section;
  }
  const students = await Student.find(filter, { grade: 1, section: 1 }).lean();
  if (students.length === 0) throw AppError.badRequest("No matching students", "NO_STUDENTS");

  const discountFor = (amount) => {
    if (!concession || concession.value === 0) return 0;
    const d = concession.type === "percent" ? Math.round((amount * concession.value) / 100) : concession.value;
    return Math.min(d, amount);
  };

  const docs = students.flatMap((s) =>
    plan.installments.map((inst) => {
      const amount = sum(inst.items, (it) => it.amount);
      const discount = discountFor(amount);
      return {
        tenantId: oid(tenantId),
        studentId: s._id,
        planId: plan._id,
        installmentId: inst._id,
        planName: plan.name,
        label: inst.label,
        dueDate: inst.dueDate,
        items: inst.items.map((it) => ({ name: it.name, amount: it.amount })),
        amount,
        discount,
        discountReason: discount ? concession.reason : "",
        paid: 0,
        grade: s.grade || "",
        section: s.section || "",
      };
    })
  );

  let created = 0;
  try {
    const result = await Invoice.insertMany(docs, { ordered: false });
    created = result.length;
  } catch (err) {
    // Duplicates (already assigned) are expected; anything else is a real error
    const writeErrors = err?.writeErrors ?? [];
    if (!writeErrors.length || writeErrors.some((e) => (e.code ?? e.err?.code) !== 11000)) throw err;
    created = err.insertedDocs?.length ?? docs.length - writeErrors.length;
  }

  return { students: students.length, created, skipped: docs.length - created };
}

// ---------------------------------------------------------------------------
// Dues
// ---------------------------------------------------------------------------

/** Every student with their fee totals: billed, paid, balance, overdue. */
export async function feeRegister(tenantId, { page, limit, search, grade, section, status, sort, today = utcToday() }) {
  const match = { tenantId: oid(tenantId) };
  if (grade) match.grade = grade;
  if (section) match.section = section;
  if (search) {
    match.$and = search
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5)
      .map((word) => {
        const re = new RegExp(escapeRegex(word), "i");
        return { $or: ["firstName", "lastName", "admissionNo", "guardianName", "guardianPhone"].map((f) => ({ [f]: re })) };
      });
  }

  const statusMatch = {
    all: {},
    overdue: { overdue: { $gt: 0 } },
    due: { balance: { $gt: 0 } },
    paid: { billed: { $gt: 0 }, balance: { $lte: 0 } },
    none: { dues: 0 },
  }[status];

  const sortStage = {
    name: { firstName: 1, lastName: 1 },
    balance: { balance: -1, firstName: 1 },
    overdue: { overdue: -1, balance: -1 },
    grade: { grade: 1, section: 1, rollNo: 1 },
  }[sort];

  const [result] = await Student.aggregate(
    [
      { $match: match },
      {
        $lookup: {
          from: Invoice.collection.name,
          let: { sid: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$tenantId", oid(tenantId)] }, { $eq: ["$studentId", "$$sid"] }] } } },
            { $project: { amount: 1, discount: 1, paid: 1, dueDate: 1, balance: BALANCE_EXPR } },
          ],
          as: "inv",
        },
      },
      {
        $project: {
          firstName: 1,
          lastName: 1,
          admissionNo: 1,
          grade: 1,
          section: 1,
          rollNo: 1,
          status: 1,
          guardianName: 1,
          guardianPhone: 1,
          dues: { $size: "$inv" },
          billed: { $sum: "$inv.amount" },
          discount: { $sum: "$inv.discount" },
          paid: { $sum: "$inv.paid" },
          balance: { $sum: "$inv.balance" },
          overdue: {
            $sum: { $map: { input: "$inv", as: "i", in: { $cond: [{ $and: [{ $lt: ["$$i.dueDate", today] }, { $gt: ["$$i.balance", 0] }] }, "$$i.balance", 0] } } },
          },
          nextDue: {
            $min: { $map: { input: "$inv", as: "i", in: { $cond: [{ $gt: ["$$i.balance", 0] }, "$$i.dueDate", null] } } },
          },
        },
      },
      // Students who left only matter while they still have fee records
      { $match: { $or: [{ status: "active" }, { dues: { $gt: 0 } }] } },
      { $match: statusMatch },
      {
        $facet: {
          rows: [{ $sort: { ...sortStage, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
          total: [{ $count: "n" }],
          totals: [{ $group: { _id: null, billed: { $sum: "$billed" }, discount: { $sum: "$discount" }, paid: { $sum: "$paid" }, balance: { $sum: "$balance" }, overdue: { $sum: "$overdue" } } }],
        },
      },
    ]
  ).collation(COLLATION);

  const total = result.total[0]?.n ?? 0;
  const totals = result.totals[0] ?? { billed: 0, discount: 0, paid: 0, balance: 0, overdue: 0 };
  delete totals._id;

  return {
    students: result.rows.map((r) => ({
      id: String(r._id),
      fullName: fullName(r),
      admissionNo: r.admissionNo,
      grade: r.grade || "",
      section: r.section || "",
      rollNo: r.rollNo || "",
      studentStatus: r.status,
      guardianName: r.guardianName || "",
      guardianPhone: r.guardianPhone || "",
      dues: r.dues,
      billed: r.billed,
      discount: r.discount,
      paid: r.paid,
      balance: r.balance,
      overdue: r.overdue,
      nextDue: r.nextDue ?? null,
    })),
    totals,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** One student's dues and payments. */
export async function studentLedger(tenantId, studentId, { today = utcToday() } = {}) {
  const student = await Student.findOne({ _id: studentId, tenantId }).lean();
  if (!student) throw AppError.notFound("Student not found");

  const [invoices, payments] = await Promise.all([
    Invoice.find({ tenantId, studentId }).sort({ dueDate: 1, createdAt: 1 }).lean(),
    Payment.find({ tenantId, studentId }).sort({ date: -1, createdAt: -1 }).lean(),
  ]);

  const dues = invoices.map((i) => serializeInvoice(i, today));
  return {
    student: {
      id: String(student._id),
      fullName: fullName(student),
      admissionNo: student.admissionNo,
      grade: student.grade || "",
      section: student.section || "",
      guardianName: student.guardianName || "",
      guardianPhone: student.guardianPhone || "",
      status: student.status,
    },
    dues,
    payments: payments.map(serializePayment),
    totals: {
      billed: sum(dues, (d) => d.amount),
      discount: sum(dues, (d) => d.discount),
      paid: sum(dues, (d) => d.paid),
      balance: sum(dues, (d) => Math.max(0, d.balance)),
      overdue: sum(dues.filter((d) => d.status === "overdue"), (d) => d.balance),
    },
  };
}

export async function updateInvoice(tenantId, id, { discount, discountReason, dueDate }) {
  const inv = await Invoice.findOne({ _id: id, tenantId });
  if (!inv) throw AppError.notFound("Due not found");
  if (discount !== undefined) {
    if (discount > inv.amount - inv.paid) {
      throw AppError.badRequest("Discount can't be more than the unpaid amount", "DISCOUNT_TOO_HIGH");
    }
    inv.discount = discount;
  }
  if (discountReason !== undefined) inv.discountReason = discountReason;
  if (dueDate !== undefined) inv.dueDate = dueDate;
  await inv.save();
  return { due: serializeInvoice(inv, utcToday()) };
}

export async function deleteInvoice(tenantId, id) {
  const inv = await Invoice.findOne({ _id: id, tenantId });
  if (!inv) throw AppError.notFound("Due not found");
  if (inv.paid > 0) throw AppError.conflict("This due has payments. Void them first.", "DUE_HAS_PAYMENTS");
  await inv.deleteOne();
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Records a payment and applies it to the student's dues (given allocations,
 * or oldest due first), all in one transaction with the receipt number.
 */
export async function createPayment(tenantId, user, data) {
  const { studentId, amount, date, mode, reference, note, allocations } = data;
  const [student, receivedByName] = await Promise.all([Student.findOne({ _id: studentId, tenantId }).lean(), userName(user.id)]);
  if (!student) throw AppError.notFound("Student not found");

  let paymentId;
  await mongoose.connection.transaction(async (session) => {
    const open = (await Invoice.find({ tenantId, studentId }).sort({ dueDate: 1, createdAt: 1 }).session(session).lean()).filter(
      (i) => balanceOf(i) > 0
    );
    const openById = new Map(open.map((i) => [String(i._id), i]));

    let plan; // [{ invoice, amount }]
    if (allocations) {
      if (sum(allocations, (a) => a.amount) !== amount) {
        throw AppError.badRequest("The amounts applied to dues must add up to the payment amount", "ALLOCATION_MISMATCH");
      }
      plan = allocations.map((a) => {
        const inv = openById.get(a.invoiceId);
        if (!inv) throw AppError.badRequest("A selected due is already paid or doesn't belong to this student", "INVALID_ALLOCATION");
        if (a.amount > balanceOf(inv)) {
          throw AppError.badRequest(`More than the balance of “${inv.label}” was applied`, "ALLOCATION_TOO_HIGH");
        }
        return { invoice: inv, amount: a.amount };
      });
    } else {
      const outstanding = sum(open, balanceOf);
      if (amount > outstanding) {
        throw AppError.badRequest(
          outstanding === 0 ? "This student has nothing to pay" : "The amount is more than the student's total balance",
          "AMOUNT_EXCEEDS_BALANCE"
        );
      }
      plan = [];
      let left = amount;
      for (const inv of open) {
        if (left === 0) break;
        const take = Math.min(left, balanceOf(inv));
        plan.push({ invoice: inv, amount: take });
        left -= take;
      }
    }

    // Guarded increments: fail instead of overpaying if someone else paid meanwhile
    for (const { invoice, amount: part } of plan) {
      const updated = await Invoice.updateOne(
        { _id: invoice._id, tenantId, $expr: { $lte: [{ $add: ["$paid", part] }, { $subtract: ["$amount", "$discount"] }] } },
        { $inc: { paid: part } },
        { session }
      );
      if (updated.modifiedCount !== 1) {
        throw AppError.conflict("These dues changed while you were recording the payment. Refresh and try again.", "DUES_CHANGED");
      }
    }

    const seq = await Counter.next(tenantId, "receipt", session);
    const [payment] = await Payment.create(
      [
        {
          tenantId,
          receiptNo: `R${String(seq).padStart(5, "0")}`,
          studentId,
          student: {
            fullName: fullName(student),
            admissionNo: student.admissionNo,
            grade: student.grade || "",
            section: student.section || "",
            guardianName: student.guardianName || "",
          },
          date,
          amount,
          mode,
          reference,
          note,
          allocations: plan.map(({ invoice, amount: part }) => ({
            invoiceId: invoice._id,
            label: invoice.label,
            planName: invoice.planName,
            amount: part,
          })),
          receivedBy: user.id,
          receivedByName,
        },
      ],
      { session }
    );
    paymentId = payment._id;
  });

  return getReceipt(tenantId, paymentId);
}

/** Cancels a payment: it stays on record as voided and its amounts go back onto the dues. */
export async function voidPayment(tenantId, user, id, { reason }) {
  const byName = await userName(user.id);
  await mongoose.connection.transaction(async (session) => {
    const payment = await Payment.findOneAndUpdate(
      { _id: id, tenantId, "voided.at": { $exists: false } },
      { $set: { voided: { at: new Date(), by: user.id, byName, reason } } },
      { session, returnDocument: "after" }
    );
    if (!payment) {
      const exists = await Payment.exists({ _id: id, tenantId }).session(session);
      throw exists ? AppError.conflict("This payment is already voided", "ALREADY_VOIDED") : AppError.notFound("Payment not found");
    }
    for (const a of payment.allocations) {
      await Invoice.updateOne({ _id: a.invoiceId, tenantId }, { $inc: { paid: -a.amount } }, { session });
    }
  });
  return getReceipt(tenantId, id);
}

function paymentFilter(tenantId, { from, to, mode, search, includeVoided }) {
  const filter = { tenantId };
  if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (mode && mode !== "all") filter.mode = mode;
  if (includeVoided === "false") filter["voided.at"] = { $exists: false };
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ receiptNo: re }, { "student.fullName": re }, { "student.admissionNo": re }, { reference: re }];
  }
  return filter;
}

export async function listPayments(tenantId, { page, limit, ...filters }) {
  const filter = paymentFilter(tenantId, filters);
  const [payments, total, totals] = await Promise.all([
    Payment.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Payment.countDocuments(filter),
    Payment.aggregate([
      { $match: { ...filter, tenantId: oid(tenantId), "voided.at": { $exists: false } } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);
  return {
    payments: payments.map(serializePayment),
    totals: { amount: totals[0]?.amount ?? 0, count: totals[0]?.count ?? 0 },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function exportPayments(tenantId, filters) {
  const payments = await Payment.find(paymentFilter(tenantId, filters)).sort({ date: 1, createdAt: 1 }).limit(20_000).lean();
  return { payments: payments.map(serializePayment) };
}

/** A payment with what's needed to print its receipt. */
export async function getReceipt(tenantId, id) {
  const payment = await Payment.findOne({ _id: id, tenantId }).lean();
  if (!payment) throw AppError.notFound("Payment not found");
  const [tenant, open] = await Promise.all([
    Tenant.findById(tenantId).lean(),
    Invoice.find({ tenantId, studentId: payment.studentId }, { amount: 1, discount: 1, paid: 1 }).lean(),
  ]);
  return {
    payment: serializePayment(payment),
    school: { name: tenant?.name ?? "" },
    // The student's balance right now (after this and any later payments)
    currentBalance: sum(open, (i) => Math.max(0, balanceOf(i))),
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function summary(tenantId, { from, to, today = utcToday() }) {
  const tid = oid(tenantId);
  const paid = { tenantId: tid, "voided.at": { $exists: false } };

  const [collected, byMode, byDay, dues, byClass, upcoming, recent] = await Promise.all([
    Payment.aggregate([{ $match: { ...paid, date: { $gte: from, $lte: to } } }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { ...paid, date: { $gte: from, $lte: to } } }, { $group: { _id: "$mode", amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
    Payment.aggregate([
      { $match: { ...paid, date: { $gte: from, $lte: to } } },
      { $group: { _id: "$date", amount: { $sum: "$amount" } } },
      { $sort: { _id: 1 } },
    ]),
    Invoice.aggregate([
      { $match: { tenantId: tid } },
      { $addFields: { balance: BALANCE_EXPR } },
      {
        $group: {
          _id: null,
          billed: { $sum: "$amount" },
          discount: { $sum: "$discount" },
          paid: { $sum: "$paid" },
          balance: { $sum: { $max: ["$balance", 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $lt: ["$dueDate", today] }, { $gt: ["$balance", 0] }] }, "$balance", 0] } },
          overdueStudents: { $addToSet: { $cond: [{ $and: [{ $lt: ["$dueDate", today] }, { $gt: ["$balance", 0] }] }, "$studentId", "$$REMOVE"] } },
        },
      },
    ]),
    Invoice.aggregate([
      { $match: { tenantId: tid } },
      { $addFields: { balance: BALANCE_EXPR } },
      {
        $group: {
          _id: { grade: "$grade", section: "$section" },
          billed: { $sum: { $subtract: ["$amount", "$discount"] } },
          paid: { $sum: "$paid" },
          balance: { $sum: { $max: ["$balance", 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $lt: ["$dueDate", today] }, { $gt: ["$balance", 0] }] }, "$balance", 0] } },
        },
      },
    ]),
    // Due in the next 30 days and still unpaid
    Invoice.aggregate([
      { $match: { tenantId: tid, dueDate: { $gte: today, $lte: new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10) } } },
      { $addFields: { balance: BALANCE_EXPR } },
      { $match: { balance: { $gt: 0 } } },
      { $group: { _id: null, amount: { $sum: "$balance" }, students: { $addToSet: "$studentId" } } },
    ]),
    Payment.find({ tenantId }).sort({ createdAt: -1 }).limit(6).lean(),
  ]);

  const d = dues[0] ?? { billed: 0, discount: 0, paid: 0, balance: 0, overdue: 0, overdueStudents: [] };
  const naturalCompare = (a, b) => (a ?? "").localeCompare(b ?? "", "en", { numeric: true });

  return {
    range: { from, to },
    collected: { amount: collected[0]?.amount ?? 0, count: collected[0]?.count ?? 0 },
    byMode: PAYMENT_MODES.map((m) => {
      const row = byMode.find((x) => x._id === m);
      return { mode: m, amount: row?.amount ?? 0, count: row?.count ?? 0 };
    }).filter((m) => m.count > 0),
    byDay: byDay.map((x) => ({ date: x._id, amount: x.amount })),
    dues: {
      billed: d.billed,
      discount: d.discount,
      paid: d.paid,
      balance: d.balance,
      overdue: d.overdue,
      overdueStudents: d.overdueStudents.length,
      // Share of what's due so far that has been collected
      collectionRate: d.billed - d.discount > 0 ? Math.round((d.paid / (d.billed - d.discount)) * 1000) / 10 : null,
    },
    upcoming: { amount: upcoming[0]?.amount ?? 0, students: upcoming[0]?.students.length ?? 0 },
    byClass: byClass
      .map((c) => ({ grade: c._id.grade, section: c._id.section, billed: c.billed, paid: c.paid, balance: c.balance, overdue: c.overdue }))
      .sort((a, b) => naturalCompare(a.grade, b.grade) || naturalCompare(a.section, b.section)),
    recent: recent.map(serializePayment),
  };
}
