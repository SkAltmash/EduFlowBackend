import mongoose from "mongoose";

// Append-only record of every super admin action.
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true }, // e.g. "tenant.update", "user.reset_password"
    targetType: { type: String, enum: ["tenant", "user", "membership", "platform"], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant" },
    metadata: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 500 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ targetId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export default mongoose.model("AuditLog", auditLogSchema);
