// Razorpay for Zaref Campus plan payments: keys come from Console → Settings → Payments (secrets
// stored encrypted). Orders are created here, paid in Razorpay Checkout in the browser, and
// confirmed by the checkout's signature and by Razorpay's webhook.
import crypto from "node:crypto";
import env from "../../config/env.js";
import PlatformSettings from "../../models/PlatformSettings.js";
import AppError from "../../utils/AppError.js";
import { decrypt } from "../../utils/crypto.js";

const API = "https://api.razorpay.com/v1";
// Development only: BILLING_FAKE=1 makes orders without calling Razorpay (never in production)
const FAKE = !env.isProduction && process.env.BILLING_FAKE === "1";

let cache = null;
let cachedAt = 0;

/** { enabled, keyId, keySecret, webhookSecret }; enabled only when the keys are set and readable. */
export async function razorpayConfig() {
  if (cache && Date.now() - cachedAt < 60_000) return cache;
  const r = (await PlatformSettings.findOne({ key: "platform" }, { razorpay: 1 }).lean())?.razorpay ?? {};
  const keySecret = decrypt(r.keySecretEnc) || null;
  cache = { enabled: Boolean(r.enabled && r.keyId && keySecret), keyId: r.keyId || "", keySecret, webhookSecret: decrypt(r.webhookSecretEnc) || null };
  cachedAt = Date.now();
  return cache;
}
export const forgetRazorpayConfig = () => {
  cache = null;
};

async function call(cfg, method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64")}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AppError(503, "Couldn't reach Razorpay. Try again in a minute.", "PAYMENT_UNREACHABLE");
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401) throw new AppError(502, "Razorpay refused the API keys. Check them in Console → Settings → Payments.", "PAYMENT_KEYS_INVALID");
  if (!res.ok) throw new AppError(502, `Razorpay couldn't start the payment (${data?.error?.description?.slice(0, 160) ?? res.status}).`, "PAYMENT_FAILED");
  return data;
}

/** Creates a Razorpay order for `amount` paise. */
export async function createOrder(cfg, { amount, receipt, notes }) {
  if (FAKE) return { id: `order_fake${crypto.randomBytes(7).toString("hex")}`, amount, currency: "INR" };
  return call(cfg, "POST", "/orders", { amount, currency: "INR", receipt, notes });
}

/** A tiny request to check a key id and secret (Console → Save). */
export async function pingRazorpay(cfg) {
  if (FAKE) return;
  await call(cfg, "GET", "/orders?count=1");
}

const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The signature Razorpay Checkout returns: HMAC-SHA256 of "order_id|payment_id" with the key secret. */
export const checkoutSignatureOk = (cfg, orderId, paymentId, signature) => same(hmac(cfg.keySecret, `${orderId}|${paymentId}`), signature);

/** The X-Razorpay-Signature of a webhook: HMAC-SHA256 of the raw body with the webhook secret. */
export const webhookSignatureOk = (cfg, rawBody, signature) => Boolean(cfg.webhookSecret) && same(hmac(cfg.webhookSecret, rawBody), signature);
