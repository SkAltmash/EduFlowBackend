import mongoose from "mongoose";

// Per-school preferences that aren't tied to one module's data.
const schoolSettingsSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
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
