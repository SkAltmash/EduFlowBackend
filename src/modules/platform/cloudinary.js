// Cloudinary uploads without the SDK: the browser uploads straight to Cloudinary with a
// short-lived signature from us, so the API secret never leaves the server.
// https://cloudinary.com/documentation/authentication_signatures
import crypto from "node:crypto";
import PlatformSettings from "../../models/PlatformSettings.js";
import AppError from "../../utils/AppError.js";
import { decrypt } from "../../utils/crypto.js";

let cache = null;
let cachedAt = 0;

/** { cloudName, apiKey, apiSecret, folder } when uploads are set up, else null. */
export async function cloudinaryConfig() {
  if (cache !== null && Date.now() - cachedAt < 60_000) return cache || null;
  const s = (await PlatformSettings.findOne({ key: "platform" }, { cloudinary: 1 }).lean())?.cloudinary;
  const apiSecret = decrypt(s?.apiSecretEnc);
  cache = s?.cloudName && s.apiKey && apiSecret ? { cloudName: s.cloudName, apiKey: s.apiKey, apiSecret, folder: s.folder || "eduflow" } : false;
  cachedAt = Date.now();
  return cache || null;
}

export const forgetCloudinaryConfig = () => {
  cache = null;
};

/** Cloudinary's signature: SHA-1 of the sorted params joined as a query string, plus the secret. */
export function sign(params, apiSecret) {
  const base = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(base + apiSecret).digest("hex");
}

/** Checks the keys with Cloudinary's ping endpoint. */
export async function pingCloudinary({ cloudName, apiKey, apiSecret }) {
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/ping`, {
    headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) throw AppError.badRequest("Couldn't reach Cloudinary. Check the server's internet connection.", "CLOUDINARY_UNREACHABLE");
  if (res.status === 401 || res.status === 403) {
    // Cloudinary says which part is wrong, e.g. "api_secret mismatch" or "disabled api_key"
    const reason = String((await res.json().catch(() => null))?.error?.message ?? "");
    const hint = /api_secret/i.test(reason)
      ? "The API secret doesn't match this API key. In Cloudinary → API Keys, copy the secret from the same row as the key (use the copy button, the column is cut short)."
      : /api_key|disabled/i.test(reason)
        ? "Cloudinary doesn't know this API key, or it's turned off. Check the key and the cloud name."
        : "Cloudinary rejected these keys. Check the cloud name, API key and secret.";
    throw AppError.badRequest(reason ? `${hint} (Cloudinary: ${reason})` : hint, "CLOUDINARY_AUTH");
  }
  if (res.status === 404) throw AppError.badRequest("No Cloudinary account with that cloud name.", "CLOUDINARY_CLOUD");
  if (!res.ok) throw AppError.badRequest(`Cloudinary answered ${res.status}`, "CLOUDINARY_ERROR");
  return true;
}

const PERMISSION_HINT =
  "This API key isn't allowed to upload or delete images. In Cloudinary → Settings → Role Management (or API Keys), give the key a role that can create and delete assets (e.g. Master admin), or use a key that already can.";

/** Uploads and deletes a 1×1 test image, so keys whose role can't upload are caught before schools try. */
export async function checkUploadPermission({ cloudName, apiKey, apiSecret, folder }) {
  const publicId = `${folder || "eduflow"}/_eduflow_check`;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { overwrite: "true", public_id: publicId, timestamp };
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const up = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, {
    method: "POST",
    body: new URLSearchParams({ ...params, file: pixel, api_key: apiKey, signature: sign(params, apiSecret) }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!up) throw AppError.badRequest("Couldn't reach Cloudinary. Check the server's internet connection.", "CLOUDINARY_UNREACHABLE");
  if (!up.ok) {
    const reason = String((await up.json().catch(() => null))?.error?.message ?? up.status);
    throw AppError.badRequest(/permission|forbidden/i.test(reason) ? `${PERMISSION_HINT} (Cloudinary: ${reason})` : `Test upload failed (Cloudinary: ${reason})`, "CLOUDINARY_UPLOAD");
  }
  const delParams = { invalidate: "true", public_id: publicId, timestamp };
  const del = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`, {
    method: "POST",
    body: new URLSearchParams({ ...delParams, api_key: apiKey, signature: sign(delParams, apiSecret) }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const result = del?.ok ? (await del.json().catch(() => null))?.result : null;
  if (result !== "ok") throw AppError.badRequest(`${PERMISSION_HINT} (Cloudinary: upload worked but delete didn't)`, "CLOUDINARY_DELETE");
  return true;
}

/** Deletes an uploaded image (best effort: a failure here never blocks the caller). */
export async function destroyImage(publicId) {
  const cfg = await cloudinaryConfig();
  if (!cfg || !publicId) return false;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { invalidate: "true", public_id: publicId, timestamp };
  const body = new URLSearchParams({ ...params, api_key: cfg.apiKey, signature: sign(params, cfg.apiSecret) });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/destroy`, { method: "POST", body, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return Boolean(res?.ok);
}
