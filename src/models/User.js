import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: true, select: false },
    isActive: { type: Boolean, default: true },
    // Platform-level administrator (manages every tenant). Set only through
    // the CLI (`npm run superadmin`) or by another super admin in the console. Hidden from queries by default.
    isSuperAdmin: { type: Boolean, default: false, select: false },
    // Two-step login (authenticator app) for super admins; secrets encrypted at rest
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, select: false },
      pendingEnc: { type: String, select: false },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash;
        delete ret.isSuperAdmin;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export default mongoose.model("User", userSchema);
