import crypto from "node:crypto";
import env from "../config/env.js";

// AES-256-GCM for secrets at rest. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url parts).

function key() {
  if (!env.DATA_ENCRYPTION_KEY) return null;
  // Derive a fixed 32-byte key from whatever string was configured
  return crypto.createHash("sha256").update(env.DATA_ENCRYPTION_KEY).digest();
}

export function canEncrypt() {
  return Boolean(env.DATA_ENCRYPTION_KEY);
}

export function encrypt(plain) {
  const k = key();
  if (!k) throw new Error("DATA_ENCRYPTION_KEY is not set");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** Returns null if the value can't be decrypted (missing or changed key, tampered data). */
export function decrypt(payload) {
  const k = key();
  if (!k || !payload) return null;
  try {
    const [version, iv, tag, data] = payload.split(".");
    if (version !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
