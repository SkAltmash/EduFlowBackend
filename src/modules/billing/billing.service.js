// Schools paying for their EduFlow plan online (Razorpay): the plans on offer, checkout, and
// applying a paid order to the school's subscription. A paid order is applied exactly once,
// whether the browser's confirmation or Razorpay's webhook arrives first.
import AuditLog from "../../models/AuditLog.js";
import BillingOrder from "../../models/BillingOrder.js";
import PlatformPlan from "../../models/PlatformPlan.js";
import SubscriptionPayment from "../../models/SubscriptionPayment.js";
import Tenant from "../../models/Tenant.js";
import User from "../../models/User.js";
import AppError from "../../utils/AppError.js";
import { applyPayment, listPlans } from "../platform/platform.service.js";
import { getAccess } from "../platform/subscription.js";
import { checkoutSignatureOk, createOrder, razorpayConfig, webhookSignatureOk } from "./razorpay.js";

/** Plans on offer (for the pricing pages; no per-plan school counts). */
export async function offeredPlans() {
  const { plans } = await listPlans();
  return plans.filter((p) => !p.archived).map(({ schools: _s, isDefault: _d, archived: _a, ...p }) => p);
}

/** Plan & billing in the app: the subscription, plans, whether online payment is on, and past payments. */
export async function overview(user) {
  const [subscription, plans, cfg, payments] = await Promise.all([
    getAccess(user.tenantId),
    offeredPlans(),
    razorpayConfig(),
    SubscriptionPayment.find({ tenantId: user.tenantId }).sort({ createdAt: -1 }).limit(24).lean(),
  ]);
  return {
    subscription,
    plans,
    onlinePayments: cfg.enabled,
    payments: payments.map((p) => ({ id: String(p._id), planName: p.planName, amount: p.amount, method: p.method, reference: p.reference, cycle: p.cycle, periods: p.periods, periodStart: p.periodStart, periodEnd: p.periodEnd, paidAt: p.createdAt })),
  };
}

/** Starts a payment: a Razorpay order for the plan's monthly or yearly price. */
export async function checkout(user, { planId, cycle }) {
  const cfg = await razorpayConfig();
  if (!cfg.enabled) throw AppError.badRequest("Online payment isn't set up yet. Contact EduFlow support to pay.", "PAYMENTS_OFF");
  const plan = await PlatformPlan.findOne({ _id: planId, archived: false }).lean();
  if (!plan) throw AppError.badRequest("Choose a plan", "INVALID_PLAN");
  const amount = cycle === "yearly" ? plan.priceYearly : plan.priceMonthly;
  if (!amount) throw AppError.badRequest(`The ${plan.name} plan has no ${cycle} price yet. Contact EduFlow support.`, "PLAN_NO_PRICE");
  const [tenant, member] = await Promise.all([Tenant.findById(user.tenantId, { name: 1 }).lean(), User.findById(user.id, { name: 1, email: 1, phone: 1 }).lean()]);
  const order = await createOrder(cfg, {
    amount,
    receipt: `ef_${String(user.tenantId).slice(-12)}_${Date.now().toString(36)}`,
    notes: { tenantId: String(user.tenantId), planId: String(plan._id), cycle, school: tenant?.name?.slice(0, 100) ?? "" },
  });
  await BillingOrder.create({ tenantId: user.tenantId, userId: user.id, planId: plan._id, planName: plan.name, cycle, amount, razorpayOrderId: order.id });
  return {
    keyId: cfg.keyId,
    orderId: order.id,
    amount,
    currency: "INR",
    planName: plan.name,
    cycle,
    school: tenant?.name ?? "",
    prefill: { name: member?.name ?? "", email: member?.email ?? "", contact: member?.phone ?? "" },
  };
}

/** Applies a paid order once: the first caller marks it paid and extends the plan; later calls do nothing. */
async function markPaid(order, paymentId, via) {
  const claimed = await BillingOrder.findOneAndUpdate({ _id: order._id, status: "created" }, { $set: { status: "paid", razorpayPaymentId: paymentId, paidAt: new Date() } }, { returnDocument: "after" });
  if (!claimed) return false;
  const [tenant, plan] = await Promise.all([Tenant.findById(order.tenantId), PlatformPlan.findById(order.planId).lean()]);
  if (!tenant || !plan) return false;
  const { payment, periodEnd } = await applyPayment(tenant, plan, {
    amount: order.amount,
    method: "razorpay",
    reference: paymentId,
    cycle: order.cycle,
    note: `Paid online (${via})`,
    recordedByName: "Razorpay",
  });
  await BillingOrder.updateOne({ _id: order._id }, { $set: { paymentId: payment._id } });
  await AuditLog.create({ actorId: order.userId, tenantId: order.tenantId, action: "subscription.paid_online", targetType: "tenant", targetId: order.tenantId, metadata: { amount: order.amount, plan: plan.name, cycle: order.cycle, until: periodEnd, payment: paymentId, via } });
  return true;
}

/** After Razorpay Checkout succeeds in the browser: checks its signature, then applies the payment. */
export async function confirm(user, { orderId, paymentId, signature }) {
  const cfg = await razorpayConfig();
  const order = await BillingOrder.findOne({ razorpayOrderId: orderId, tenantId: user.tenantId }).lean();
  if (!order) throw AppError.notFound("Payment not found", "PAYMENT_NOT_FOUND");
  if (!cfg.keySecret || !checkoutSignatureOk(cfg, orderId, paymentId, signature)) throw AppError.badRequest("We couldn't verify this payment. If money was taken, contact EduFlow support with the payment ID.", "PAYMENT_UNVERIFIED");
  await markPaid(order, paymentId, "checkout");
  return overview(user);
}

/** Razorpay's webhook (payment.captured / order.paid): the backup when the browser closes before confirming. */
export async function webhook(rawBody, signature) {
  const cfg = await razorpayConfig();
  if (!webhookSignatureOk(cfg, rawBody, signature)) throw AppError.unauthorized("Bad signature", "WEBHOOK_SIGNATURE");
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw AppError.badRequest("Bad payload", "WEBHOOK_PAYLOAD");
  }
  if (!["payment.captured", "order.paid"].includes(event?.event)) return { ok: true, ignored: true };
  const payment = event.payload?.payment?.entity;
  const orderId = payment?.order_id ?? event.payload?.order?.entity?.id;
  if (!orderId || !payment?.id) return { ok: true, ignored: true };
  const order = await BillingOrder.findOne({ razorpayOrderId: orderId }).lean();
  // Payments for something other than an EduFlow plan (or an order we don't know) are ignored
  if (!order || payment.amount !== order.amount) return { ok: true, ignored: true };
  const applied = await markPaid(order, payment.id, "webhook");
  return { ok: true, applied };
}
