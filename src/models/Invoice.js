import mongoose from "mongoose";

// A due: one installment of a fee plan charged to one student.
// Items and amounts are copied from the plan, so later plan edits don't change existing dues.
// Balance = amount - discount - paid.
const invoiceSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "FeePlan", required: true },
    installmentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    planName: { type: String, required: true },
    label: { type: String, required: true },
    dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    items: [{ _id: false, name: String, amount: Number }],
    amount: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    discountReason: { type: String, trim: true, maxlength: 200, default: "" },
    // Where the discount came from: the student's concession (kept in sync with it) or a
    // one-off edit on this due (never overwritten by concession changes)
    discountSource: { type: String, enum: ["", "concession", "manual"], default: "" },
    paid: { type: Number, default: 0, min: 0 },
    // Class when the due was created, for class-wise reports
    grade: { type: String, default: "" },
    section: { type: String, default: "" },
  },
  { timestamps: true }
);

// A plan installment is charged to a student at most once
invoiceSchema.index({ tenantId: 1, studentId: 1, planId: 1, installmentId: 1 }, { unique: true });
// A student's ledger, oldest due first (also used to allocate payments)
invoiceSchema.index({ tenantId: 1, studentId: 1, dueDate: 1 });
// Overdue / upcoming lists and totals
invoiceSchema.index({ tenantId: 1, dueDate: 1 });
invoiceSchema.index({ tenantId: 1, planId: 1 });

export default mongoose.model("Invoice", invoiceSchema);
