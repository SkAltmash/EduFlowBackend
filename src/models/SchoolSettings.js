import mongoose from "mongoose";

// Per-school preferences that aren't tied to one module's data.
const schoolSettingsSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    // Shown on receipts, report cards and the letterhead of everything printed
    profile: {
      type: { type: String, enum: ["school", "tuition", "coaching", "other"], default: "school" },
      board: { type: String, trim: true, maxlength: 60, default: "" },
      phone: { type: String, trim: true, maxlength: 30, default: "" },
      email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
      website: { type: String, trim: true, maxlength: 200, default: "" },
      address: { type: String, trim: true, maxlength: 300, default: "" },
      city: { type: String, trim: true, maxlength: 80, default: "" },
      state: { type: String, trim: true, maxlength: 80, default: "" },
      pincode: { type: String, trim: true, maxlength: 12, default: "" },
      // Month (1-12) the academic year starts; April in most Indian schools
      academicYearStart: { type: Number, min: 1, max: 12, default: 4 },
      receiptNote: { type: String, trim: true, maxlength: 300, default: "" },
    },
    grading: {
      scale: { type: String, enum: ["cbse", "simple"], default: "cbse" },
      passPercent: { type: Number, min: 0, max: 100, default: 33 },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

schoolSettingsSchema.index({ tenantId: 1 }, { unique: true });

export default mongoose.model("SchoolSettings", schoolSettingsSchema);
