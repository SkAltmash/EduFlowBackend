// Manage super admin accounts. This is the ONLY way to create one.
//
//   npm run superadmin -- create  --email admin@eduflow.com --name "Platform Admin"
//   npm run superadmin -- promote --email someone@example.com
//   npm run superadmin -- revoke  --email someone@example.com
//   npm run superadmin -- list
//
// "create" prompts for the password (hidden). For CI you can pass it via the
// SUPERADMIN_PASSWORD environment variable instead.
import readline from "node:readline";
import { parseArgs } from "node:util";
import { connectDB, disconnectDB } from "../src/config/database.js";
import User from "../src/models/User.js";
import Session from "../src/models/Session.js";
import { hashPassword } from "../src/utils/password.js";
import { email as emailSchema, strongPassword } from "../src/modules/auth/auth.validation.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: "string" }, name: { type: "string" } },
});
const command = positionals[0];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

async function readPassword() {
  if (process.env.SUPERADMIN_PASSWORD) return process.env.SUPERADMIN_PASSWORD;
  const password = await promptHidden("Password: ");
  const confirm = await promptHidden("Confirm password: ");
  if (password !== confirm) throw new Error("Passwords do not match");
  return password;
}

function parseEmail() {
  const result = emailSchema.safeParse(values.email ?? "");
  if (!result.success) throw new Error("A valid --email is required");
  return result.data;
}

async function create() {
  const email = parseEmail();
  const name = values.name?.trim();
  if (!name || name.length < 2) throw new Error('--name is required, e.g. --name "Platform Admin"');
  if (await User.exists({ email })) throw new Error(`User ${email} already exists (use "promote")`);

  const pw = strongPassword.safeParse(await readPassword());
  if (!pw.success) throw new Error(pw.error.issues.map((i) => i.message).join("; "));

  await User.create({ name, email, passwordHash: await hashPassword(pw.data), isSuperAdmin: true });
  console.log(`Super admin created: ${email}`);
}

async function setFlag(isSuperAdmin) {
  const email = parseEmail();
  const user = await User.findOneAndUpdate({ email }, { $set: { isSuperAdmin } }, { returnDocument: "after" });
  if (!user) throw new Error(`No user with email ${email}`);
  // End existing sessions so the change applies on the next login
  await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  console.log(`${email} is ${isSuperAdmin ? "now" : "no longer"} a super admin (sessions revoked)`);
}

async function list() {
  const admins = await User.find({ isSuperAdmin: true }).select("+isSuperAdmin").lean();
  if (admins.length === 0) return console.log("No super admins.");
  for (const a of admins) console.log(`${a.email}\t${a.name}\t${a.isActive ? "active" : "inactive"}`);
}

const commands = { create, promote: () => setFlag(true), revoke: () => setFlag(false), list };

if (!commands[command]) {
  fail("Usage: npm run superadmin -- <create|promote|revoke|list> [--email ...] [--name ...]");
} else {
  await connectDB();
  try {
    await commands[command]();
  } catch (err) {
    fail(err.message);
  } finally {
    await disconnectDB();
  }
}
