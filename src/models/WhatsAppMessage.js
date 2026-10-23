import mongoose from "mongoose";
import { MESSAGE_TYPES } from "./WhatsAppConfig.js";

// Log of every WhatsApp message: sent through the API, or opened in WhatsApp by
// a staff member (mode "link", status "opened"). Lets the app show "sent 2h ago"
// and avoid messaging the same parent twice.
const whatsAppMessageSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    type: { type: String, enum: MESSAGE_TYPES, required: true },
    mode: { type: String, enum: ["link", "api"], required: true },
    // What the message is about: payment id, "studentId:date", "studentId:YYYY-MM"…
    refKey: { type: String, required: true, maxlength: 100 },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student" },
    to: { type: String, maxlength: 20, default: "" },
    status: { type: String, enum: ["opened", "sent", "delivered", "read", "failed"], required: true },
    waMessageId: { type: String },
    error: { type: String, maxlength: 500 },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    sentByName: String,
  },
  { timestamps: true }
);

whatsAppMessageSchema.index({ tenantId: 1, type: 1, refKey: 1, createdAt: -1 });
whatsAppMessageSchema.index({ tenantId: 1, createdAt: -1 });
// Webhook status updates look messages up by WhatsApp's id
whatsAppMessageSchema.index({ waMessageId: 1 }, { sparse: true });

export default mongoose.model("WhatsAppMessage", whatsAppMessageSchema);
