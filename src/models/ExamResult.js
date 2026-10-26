import mongoose from "mongoose";

// One student's marks in one exam. Totals, grades and ranks are computed when read,
// so changing the grading scale or a subject's maximum never leaves stale numbers.
const examResultSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    examId: { type: mongoose.Schema.Types.ObjectId, ref: "Exam", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    marks: [
      {
        _id: false,
        subjectId: { type: mongoose.Schema.Types.ObjectId, required: true },
        marks: { type: Number, min: 0, default: null },
        absent: { type: Boolean, default: false },
      },
    ],
    remarks: { type: String, trim: true, maxlength: 300, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

examResultSchema.index({ tenantId: 1, examId: 1, studentId: 1 }, { unique: true });
// A student's results across exams (monthly report)
examResultSchema.index({ tenantId: 1, studentId: 1 });

export default mongoose.model("ExamResult", examResultSchema);
