import mongoose from "mongoose";

// One AI request (a chat question or a "write for me" draft): for usage limits, billing and trust.
// Kept 180 days.
const aiQuerySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // "summary": the dashboard's daily summary (doesn't count toward the monthly limit)
    kind: { type: String, enum: ["chat", "write", "summary"], required: true },
    // "YYYY-MM" (UTC) for the monthly quota
    month: { type: String, required: true },
    question: { type: String, maxlength: 500, default: "" },
    tools: [{ type: String }],
    model: { type: String, default: "" },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    ok: { type: Boolean, default: true },
  },
  { timestamps: true }
);

aiQuerySchema.index({ tenantId: 1, month: 1 });
aiQuerySchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export default mongoose.model("AiQuery", aiQuerySchema);
