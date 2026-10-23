import mongoose from "mongoose";

// Amounts everywhere in the fees module are integers in the smallest currency
// unit (paise for INR), so sums never suffer from floating-point rounding.

const feeItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// One due date in the plan, e.g. "April 2026" or "Term 1". Its _id links the dues created from it.
const installmentSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true, maxlength: 100 },
  dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  items: { type: [feeItemSchema], validate: (v) => v.length > 0 },
});

const feePlanSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    academicYear: { type: String, trim: true, maxlength: 20, default: "" },
    // The class this plan is meant for (informational; assigning picks the students)
    grade: { type: String, trim: true, maxlength: 50, default: "" },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    installments: { type: [installmentSchema], validate: (v) => v.length > 0 },
    archived: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

feePlanSchema.index({ tenantId: 1, archived: 1, createdAt: -1 });

export default mongoose.model("FeePlan", feePlanSchema);
