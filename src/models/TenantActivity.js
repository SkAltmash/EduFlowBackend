import mongoose from "mongoose";

// One row per school per day it was used (for "active schools" and health).
const tenantActivitySchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  requests: { type: Number, default: 0 },
});

tenantActivitySchema.index({ tenantId: 1, day: 1 }, { unique: true });
tenantActivitySchema.index({ day: 1 });

export default mongoose.model("TenantActivity", tenantActivitySchema);
