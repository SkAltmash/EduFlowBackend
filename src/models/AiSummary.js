import mongoose from "mongoose";

// The dashboard's daily AI summary, cached per school, per view (what the role can see)
// and per language for the day. Kept 7 days.
const aiSummarySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    // "all" (owners/admins), "fees" (accountants), "teach" or "t:<userId>" (teachers with assigned classes)
    view: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD, India
    language: { type: String, required: true },
    headline: { type: String, default: "" },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // false: written from the numbers without the AI (it was unavailable)
    ai: { type: Boolean, default: true },
  },
  { timestamps: true }
);

aiSummarySchema.index({ tenantId: 1, view: 1, date: 1, language: 1 }, { unique: true });
aiSummarySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export default mongoose.model("AiSummary", aiSummarySchema);
