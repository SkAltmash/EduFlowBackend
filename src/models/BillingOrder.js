import mongoose from "mongoose";

// A school paying for a Zaref Campus plan online: one Razorpay order, from checkout until it's paid.
const billingOrderSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformPlan", required: true },
    planName: String,
    cycle: { type: String, enum: ["monthly", "yearly"], required: true },
    // In paise, as charged
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, default: "INR" },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, default: "" },
    status: { type: String, enum: ["created", "paid"], default: "created" },
    paidAt: Date,
    // The SubscriptionPayment made when it was paid
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionPayment" },
  },
  { timestamps: true }
);

billingOrderSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model("BillingOrder", billingOrderSchema);
