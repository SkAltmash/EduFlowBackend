import mongoose from "mongoose";

export const PAYMENT_MODES = Object.freeze(["cash", "upi", "card", "bank", "cheque", "other"]);

// Money received from a student, split across one or more dues (allocations).
// Student details are copied so receipts and searches never need a join and survive edits.
const paymentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    receiptNo: { type: String, required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    student: {
      fullName: String,
      admissionNo: String,
      grade: String,
      section: String,
      guardianName: String,
    },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    amount: { type: Number, required: true, min: 1 },
    mode: { type: String, enum: PAYMENT_MODES, required: true },
    // UTR / transaction id / cheque number
    reference: { type: String, trim: true, maxlength: 100, default: "" },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    allocations: [
      {
        _id: false,
        invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
        label: String,
        planName: String,
        amount: { type: Number, required: true, min: 1 },
      },
    ],
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    receivedByName: String,
    // A voided payment stays on record but no longer counts
    voided: {
      at: Date,
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      byName: String,
      reason: String,
    },
  },
  { timestamps: true }
);

paymentSchema.index({ tenantId: 1, receiptNo: 1 }, { unique: true });
paymentSchema.index({ tenantId: 1, date: -1 });
paymentSchema.index({ tenantId: 1, studentId: 1, date: -1 });

export default mongoose.model("Payment", paymentSchema);
