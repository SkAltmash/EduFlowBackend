import mongoose from "mongoose";

// Who teaches what: a teacher is class teacher of a class/section (subject "") or
// teaches one subject there. section "" = every section of the class.
const teachingAssignmentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    grade: { type: String, required: true, trim: true, maxlength: 50 },
    section: { type: String, trim: true, maxlength: 20, default: "" },
    subject: { type: String, trim: true, maxlength: 60, default: "" },
  },
  { timestamps: true }
);

teachingAssignmentSchema.index({ tenantId: 1, userId: 1, grade: 1, section: 1, subject: 1 }, { unique: true });
teachingAssignmentSchema.index({ tenantId: 1, grade: 1, section: 1 });

export default mongoose.model("TeachingAssignment", teachingAssignmentSchema);
