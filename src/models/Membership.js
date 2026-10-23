import mongoose from "mongoose";

export const ROLES = Object.freeze({
  OWNER: "owner",
  ADMIN: "admin",
  TEACHER: "teacher",
  ACCOUNTANT: "accountant",
});

const membershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    role: { type: String, enum: Object.values(ROLES), required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// One membership per user per tenant; also serves "find memberships for a user"
membershipSchema.index({ userId: 1, tenantId: 1 }, { unique: true });
// "List members of a tenant"
membershipSchema.index({ tenantId: 1, role: 1 });

export default mongoose.model("Membership", membershipSchema);
