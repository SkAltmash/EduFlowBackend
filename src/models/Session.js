import mongoose from "mongoose";

// A refresh-token session. The refresh JWT carries the session id (sid) and a
// one-time token id (jti); only a hash of the current jti is stored here.
// Each refresh rotates the jti, so a replayed (old) refresh token is detected.
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // "tenant": a normal session scoped to one tenant.
    // "platform": a super admin session, not tied to any tenant.
    kind: { type: String, enum: ["tenant", "platform"], default: "tenant" },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required() {
        return this.kind !== "platform";
      },
    },
    tokenHash: { type: String, required: true },
    // The token replaced by the most recent rotation, accepted for a short grace
    // period so concurrent refreshes (e.g. two browser tabs) don't trip reuse detection
    previousTokenHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, maxlength: 500 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true }
);

sessionSchema.index({ userId: 1 });
// Revoke every session of a tenant when it is deactivated
sessionSchema.index({ tenantId: 1 });
// MongoDB removes sessions automatically once they expire
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("Session", sessionSchema);
