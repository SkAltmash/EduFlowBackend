import mongoose from "mongoose";

// A teacher reporting wrong student details (phone, roll no…) for an admin to fix.
const correctionRequestSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resolvedByName: String,
    resolvedAt: Date,
  },
  { timestamps: true }
);

correctionRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export default mongoose.model("CorrectionRequest", correctionRequestSchema);
