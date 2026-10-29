// Advance: money a student paid that isn't on any due yet (paid before a fee plan was
// assigned, paid more than they owed, or freed up when a due shrank or was removed).
// It lives on the payment itself as the part not covered by its allocations, and is
// applied to the student's oldest unpaid dues whenever dues appear.
import mongoose from "mongoose";
import Invoice from "../../models/Invoice.js";
import Payment from "../../models/Payment.js";

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const allocated = (p) => p.allocations.reduce((t, a) => t + a.amount, 0);
const balanceOf = (inv) => inv.amount - inv.discount - inv.paid;

/** The part of a payment not applied to any due. */
export const unallocated = (p) => (p.voided?.at ? 0 : Math.max(0, p.amount - allocated(p)));

/** Advance per student (only students that have some), for one or many students. */
export async function advances(tenantId, studentIds) {
  const rows = await Payment.aggregate([
    { $match: { tenantId: oid(tenantId), "voided.at": { $exists: false }, ...(studentIds ? { studentId: { $in: studentIds.map(oid) } } : {}) } },
    { $project: { studentId: 1, left: { $subtract: ["$amount", { $sum: "$allocations.amount" }] } } },
    { $match: { left: { $gt: 0 } } },
    { $group: { _id: "$studentId", amount: { $sum: "$left" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.amount]));
}

export async function advanceOf(tenantId, studentId) {
  return (await advances(tenantId, [studentId])).get(String(studentId)) ?? 0;
}

/**
 * Takes money off dues that are now paid more than they cost (a concession or discount
 * after payment), newest payment first, so it becomes advance again.
 */
async function releaseOverpaid(tenantId, studentId, session) {
  const over = (await Invoice.find({ tenantId, studentId }).session(session).lean()).filter((i) => balanceOf(i) < 0);
  let released = 0;
  for (const inv of over) {
    let excess = -balanceOf(inv);
    const payments = await Payment.find({ tenantId, studentId, "voided.at": { $exists: false }, "allocations.invoiceId": inv._id })
      .sort({ date: -1, createdAt: -1 })
      .session(session);
    for (const p of payments) {
      if (excess === 0) break;
      const a = p.allocations.find((x) => String(x.invoiceId) === String(inv._id));
      const take = Math.min(excess, a.amount);
      a.amount -= take;
      if (a.amount === 0) p.allocations = p.allocations.filter((x) => x !== a);
      await p.save({ session });
      excess -= take;
      released += take;
    }
    await Invoice.updateOne({ _id: inv._id }, { $inc: { paid: -(-balanceOf(inv) - excess) } }, { session });
  }
  return released;
}

/** Applies the student's advance to their unpaid dues, oldest due and oldest payment first. */
async function applyAdvance(tenantId, studentId, session) {
  const payments = (await Payment.find({ tenantId, studentId, "voided.at": { $exists: false } }).sort({ date: 1, createdAt: 1 }).session(session)).filter(
    (p) => unallocated(p) > 0
  );
  if (!payments.length) return 0;
  const open = (await Invoice.find({ tenantId, studentId }).sort({ dueDate: 1, createdAt: 1 }).session(session).lean()).filter((i) => balanceOf(i) > 0);
  let applied = 0;
  for (const inv of open) {
    let need = balanceOf(inv);
    for (const p of payments) {
      if (need === 0) break;
      const left = unallocated(p);
      if (left === 0) continue;
      const take = Math.min(left, need);
      const existing = p.allocations.find((a) => String(a.invoiceId) === String(inv._id));
      if (existing) existing.amount += take;
      else p.allocations.push({ invoiceId: inv._id, label: inv.label, planName: inv.planName, amount: take });
      need -= take;
      applied += take;
      await Invoice.updateOne({ _id: inv._id }, { $inc: { paid: take } }, { session });
    }
  }
  for (const p of payments) if (p.isModified("allocations")) await p.save({ session });
  return applied;
}

/**
 * Brings a student's payments and dues in line: overpaid dues give money back to advance,
 * then advance pays unpaid dues. Pass a session to join a transaction.
 */
export async function settleStudent(tenantId, studentId, session) {
  const run = async (s) => {
    const released = await releaseOverpaid(tenantId, studentId, s);
    const applied = await applyAdvance(tenantId, studentId, s);
    return { released, applied };
  };
  if (session) return run(session);
  let result;
  await mongoose.connection.transaction(async (s) => {
    result = await run(s);
  });
  return result;
}

/** Settles each student that has an advance (e.g. after a plan was assigned to a class). */
export async function settleStudents(tenantId, studentIds) {
  const withAdvance = await advances(tenantId, studentIds);
  let applied = 0;
  for (const id of withAdvance.keys()) applied += (await settleStudent(tenantId, id)).applied;
  return { students: withAdvance.size, applied };
}

/** Takes every payment off the given dues (before deleting them); the money becomes advance. */
export async function detachFromDues(tenantId, invoiceIds, session) {
  const ids = invoiceIds.map(oid);
  const payments = await Payment.find({ tenantId, "allocations.invoiceId": { $in: ids } }).session(session);
  const set = new Set(ids.map(String));
  for (const p of payments) {
    p.allocations = p.allocations.filter((a) => !set.has(String(a.invoiceId)));
    await p.save({ session });
  }
  return payments.length;
}
