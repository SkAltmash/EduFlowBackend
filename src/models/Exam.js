import mongoose from "mongoose";

// A test or exam for one class (grade + optional section), with one or more subjects.
const subjectSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  maxMarks: { type: Number, required: true, min: 1, max: 1000 },
  // Optional; otherwise the school's pass percentage of maxMarks
  passMarks: { type: Number, min: 0 },
});

const examSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    grade: { type: String, required: true, trim: true, maxlength: 50 },
    section: { type: String, trim: true, maxlength: 20, default: "" },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    subjects: { type: [subjectSchema], validate: (v) => v.length > 0 && v.length <= 20 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Tests of a class, newest first; and all tests in a month
examSchema.index({ tenantId: 1, grade: 1, section: 1, date: -1 });
examSchema.index({ tenantId: 1, date: -1 });

export default mongoose.model("Exam", examSchema);
