import mongoose from "mongoose";

const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      maxlength: 80,
    },
    isActive: { type: Boolean, default: true },
    // EduFlow subscription. Missing = an older school with no plan yet (full access).
    subscription: {
      status: { type: String, enum: ["trial", "active", "suspended"] },
      planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformPlan" },
      cycle: { type: String, enum: ["monthly", "yearly"], default: "monthly" },
      trialEndsAt: Date,
      currentPeriodEnd: Date,
      updatedAt: Date,
    },
    // Per-school overrides of the plan (null/undefined = use the plan)
    studentLimitOverride: { type: Number, min: 0 },
    featureOverrides: { type: Map, of: Boolean, default: undefined },
    lastActiveAt: Date,
    // Private notes by the EduFlow team
    notes: [
      {
        text: { type: String, required: true, trim: true, maxlength: 1000 },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        byName: String,
        at: { type: Date, default: () => new Date() },
      },
    ],
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

export default mongoose.model("Tenant", tenantSchema);
