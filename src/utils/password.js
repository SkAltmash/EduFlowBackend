import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

// Used when the email does not exist, so a failed login takes the same time
// whether or not the account exists (prevents user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), SALT_ROUNDS);

export function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash || DUMMY_HASH);
}
