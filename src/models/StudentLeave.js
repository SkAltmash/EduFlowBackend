import mongoose from "mongoose";

// Leave for a student over a date range; the register pre-fills "Leave" on those days.
const studentLeaveSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    from: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    to: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    reason: { type: String, trim: true, maxlength: 200, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

studentLeaveSchema.index({ tenantId: 1, from: 1, to: 1 });
studentLeaveSchema.index({ tenantId: 1, studentId: 1, from: -1 });

export default mongoose.model("StudentLeave", studentLeaveSchema);
