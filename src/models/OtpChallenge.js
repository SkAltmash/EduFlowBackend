import mongoose from "mongoose";

// One OTP sent by SMS: what it's for, to which number, and 2Factor's session to check it against.
const otpChallengeSchema = new mongoose.Schema(
  {
    purpose: { type: String, enum: ["login", "register", "phone_change", "test"], required: true },
    phone: { type: String, required: true },
    // 2Factor's OTP session id (the code itself is never stored)
    sessionId: { type: String, required: true, select: false },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    ip: { type: String, default: "" },
  },
  { timestamps: true }
);

// MongoDB deletes challenges once they expire
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Send limits per number
otpChallengeSchema.index({ phone: 1, createdAt: -1 });

export default mongoose.model("OtpChallenge", otpChallengeSchema);
