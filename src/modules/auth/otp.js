// SMS one-time passwords through 2Factor.in. 2Factor generates and checks the code
// (AUTOGEN / VERIFY); we only keep its session id, with expiry, attempt and send limits.
// https://2factor.in/API/V1/{key}/SMS/{phone}/AUTOGEN[/{template}]  →  { Status, Details: sessionId }
// https://2factor.in/API/V1/{key}/SMS/VERIFY/{sessionId}/{code}     →  { Status, Details: "OTP Matched" }
import env from "../../config/env.js";
import OtpChallenge from "../../models/OtpChallenge.js";
import PlatformSettings from "../../models/PlatformSettings.js";
import AppError from "../../utils/AppError.js";
import { decrypt } from "../../utils/crypto.js";

const EXPIRES_MIN = 10;
const RESEND_SECONDS = 30;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

// Development only: OTP_FAKE=1 skips SMS and accepts 123456 (never in production)
const FAKE = !env.isProduction && process.env.OTP_FAKE === "1";
export const FAKE_CODE = "123456";

let cache = null;
let cachedAt = 0;

/** { enabled, apiKey, template, requireOnRegister } — apiKey is null when not set or unreadable. */
export async function otpConfig() {
  if (cache && Date.now() - cachedAt < 60_000) return cache;
  const o = (await PlatformSettings.findOne({ key: "platform" }, { otp: 1 }).lean())?.otp ?? {};
  const apiKey = decrypt(o.apiKeyEnc) || (FAKE ? "fake" : null);
  cache = { enabled: Boolean(o.enabled && apiKey), apiKey, template: o.template ?? "", requireOnRegister: o.requireOnRegister !== false };
  cachedAt = Date.now();
  return cache;
}
export const forgetOtpConfig = () => {
  cache = null;
};

/** "98765 43210", "+91 98765-43210", "919876543210" → "+919876543210" (Indian mobiles). */
export function normalizePhone(input) {
  let d = String(input ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw AppError.badRequest("Enter a valid 10-digit mobile number", "INVALID_PHONE", [{ field: "phone", message: "Enter a valid 10-digit mobile number" }]);
  return `+91${d}`;
}

export const maskPhone = (p) => `${p.slice(0, 3)} ••••• ${p.slice(-5)}`;

async function call2Factor(path) {
  const res = await fetch(`https://2factor.in/API/V1/${path}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) throw AppError.badRequest("Couldn't reach the SMS service. Try again in a moment.", "OTP_UNREACHABLE");
  const body = await res.json().catch(() => null);
  return { ok: res.ok && body?.Status === "Success", details: String(body?.Details ?? res.status) };
}

/** Sends an OTP; returns 2Factor's session id. */
export async function sendSms(phone, { apiKey, template }) {
  if (FAKE) return `fake-${Date.now()}`;
  const r = await call2Factor(`${encodeURIComponent(apiKey)}/SMS/${phone}/AUTOGEN${template ? `/${encodeURIComponent(template)}` : ""}`);
  if (!r.ok) throw AppError.badRequest(`The SMS couldn't be sent (${r.details}). Try again, or sign in with email.`, "OTP_SEND_FAILED");
  return r.details;
}

async function checkSms(sessionId, code, { apiKey }) {
  if (FAKE) return code === FAKE_CODE ? "ok" : "mismatch";
  const r = await call2Factor(`${encodeURIComponent(apiKey)}/SMS/VERIFY/${encodeURIComponent(sessionId)}/${encodeURIComponent(code)}`);
  if (r.ok) return "ok";
  return /expired/i.test(r.details) ? "expired" : "mismatch";
}

/** Sends a code for `purpose` to `phone`, with a resend cooldown and an hourly cap per number. */
export async function startChallenge({ purpose, phone, userId, ip, config }) {
  const cfg = config ?? (await otpConfig());
  if (!cfg.apiKey || (!cfg.enabled && purpose !== "test")) throw AppError.badRequest("Sign-in with mobile OTP isn't available right now. Use your email and password.", "OTP_DISABLED");
  const hourAgo = new Date(Date.now() - 3_600_000);
  const recent = await OtpChallenge.find({ phone, createdAt: { $gte: hourAgo } }, { createdAt: 1 }).sort({ createdAt: -1 }).lean();
  const wait = recent[0] ? Math.ceil((recent[0].createdAt.getTime() + RESEND_SECONDS * 1000 - Date.now()) / 1000) : 0;
  if (wait > 0) throw new AppError(429, `Wait ${wait} seconds before asking for another code.`, "OTP_TOO_SOON");
  if (recent.length >= MAX_SENDS_PER_HOUR) throw new AppError(429, "Too many codes sent to this number. Try again in an hour, or use your email.", "OTP_LIMIT");

  const sessionId = await sendSms(phone, cfg);
  const c = await OtpChallenge.create({ purpose, phone, sessionId, userId, ip: String(ip ?? "").slice(0, 64), expiresAt: new Date(Date.now() + EXPIRES_MIN * 60_000) });
  return { challengeId: String(c._id), phone: maskPhone(phone), resendIn: RESEND_SECONDS, expiresIn: EXPIRES_MIN * 60, ...(FAKE ? { devCode: FAKE_CODE } : {}) };
}

/** Checks a code; the challenge is used up on success. Returns { phone, userId }. */
export async function verifyChallenge({ challengeId, code, purpose, config }) {
  const cfg = config ?? (await otpConfig());
  const c = /^[a-f\d]{24}$/i.test(String(challengeId)) ? await OtpChallenge.findById(challengeId).select("+sessionId") : null;
  if (!c || c.purpose !== purpose || c.expiresAt < new Date()) throw AppError.badRequest("This code has expired. Ask for a new one.", "OTP_EXPIRED");
  if (c.attempts >= MAX_ATTEMPTS) throw AppError.badRequest("Too many wrong tries. Ask for a new code.", "OTP_LOCKED");
  c.attempts += 1;
  await c.save();
  const result = await checkSms(c.sessionId, code, cfg);
  if (result === "expired") throw AppError.badRequest("This code has expired. Ask for a new one.", "OTP_EXPIRED");
  if (result !== "ok") {
    const left = MAX_ATTEMPTS - c.attempts;
    throw AppError.badRequest(left > 0 ? `That code isn't right. ${left} tr${left === 1 ? "y" : "ies"} left.` : "Too many wrong tries. Ask for a new code.", left > 0 ? "OTP_INVALID" : "OTP_LOCKED");
  }
  await c.deleteOne();
  return { phone: c.phone, userId: c.userId ? String(c.userId) : null };
}
