import mongoose from "mongoose";

// One "Ask Zia" conversation, private to the member who had it (owners see the questions
// in the AiQuery log, not the chats). Removed 180 days after it was last used.
const MAX_MESSAGES = 200;

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "model"], required: true },
    text: { type: String, maxlength: 20000, default: "" },
    // Tools the answer used (model messages)
    tools: [{ type: String }],
    // Changes the answer prepared for the member to confirm (AiAction ids)
    actions: [{ type: String }],
    // Suggested next questions shown under the answer
    followups: [{ type: String }],
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const aiChatSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, trim: true, maxlength: 100, required: true },
    pinned: { type: Boolean, default: false },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true }
);

aiChatSchema.index({ tenantId: 1, userId: 1, pinned: -1, updatedAt: -1 });
aiChatSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

aiChatSchema.statics.MAX_MESSAGES = MAX_MESSAGES;

export default mongoose.model("AiChat", aiChatSchema);
