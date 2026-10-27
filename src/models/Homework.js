import mongoose from "mongoose";

// Homework / class diary entry for a class (section "" = every section) and subject.
const homeworkSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    grade: { type: String, required: true, trim: true, maxlength: 50 },
    section: { type: String, trim: true, maxlength: 20, default: "" },
    subject: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    details: { type: String, trim: true, maxlength: 2000, default: "" },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    dueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

homeworkSchema.index({ tenantId: 1, date: -1 });
homeworkSchema.index({ tenantId: 1, grade: 1, section: 1, date: -1 });

export default mongoose.model("Homework", homeworkSchema);
