import mongoose from "mongoose";

// Money a school paid for EduFlow (recorded by a super admin, or later by a gateway).
const subscriptionPaymentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformPlan" },
    planName: String,
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ["upi", "bank", "cash", "cheque", "card", "other"], default: "upi" },
    reference: { type: String, trim: true, maxlength: 100, default: "" },
    cycle: { type: String, enum: ["monthly", "yearly"], default: "monthly" },
    periods: { type: Number, min: 1, max: 36, default: 1 },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    recordedByName: String,
  },
  { timestamps: true }
);

subscriptionPaymentSchema.index({ tenantId: 1, createdAt: -1 });
subscriptionPaymentSchema.index({ createdAt: -1 });

export default mongoose.model("SubscriptionPayment", subscriptionPaymentSchema);
