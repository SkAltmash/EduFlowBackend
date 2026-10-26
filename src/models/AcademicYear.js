import mongoose from "mongoose";

// A school year such as "2026-27". Exactly one per school is current.
const academicYearSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    name: { type: String, required: true, trim: true, maxlength: 20 },
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    isCurrent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

academicYearSchema.index({ tenantId: 1, name: 1 }, { unique: true });
academicYearSchema.index({ tenantId: 1, startDate: -1 });

export default mongoose.model("AcademicYear", academicYearSchema);
