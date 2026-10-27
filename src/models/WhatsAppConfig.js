import mongoose from "mongoose";

export const MESSAGE_TYPES = Object.freeze(["fee_receipt", "fee_reminder", "absence", "attendance_summary", "exam_result", "progress_report", "performance_report", "homework", "notice"]);

// One per school. "link" mode opens WhatsApp with the message ready (no setup);
// "api" mode sends automatically through the school's WhatsApp Business number.
const templateSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 512, default: "" },
    language: { type: String, trim: true, maxlength: 15, default: "en" },
  },
  { _id: false }
);

const whatsAppConfigSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    mode: { type: String, enum: ["link", "api"], default: "link" },
    // Country calling code added to 10-digit local numbers
    defaultCountryCode: { type: String, match: /^\d{1,4}$/, default: "91" },
    phoneNumberId: { type: String, trim: true, maxlength: 50, default: "" },
    displayPhone: { type: String, trim: true, maxlength: 30, default: "" },
    // Encrypted with DATA_ENCRYPTION_KEY; never sent to the browser
    accessTokenEnc: { type: String, default: "", select: false },
    templates: {
      fee_receipt: { type: templateSchema, default: () => ({}) },
      fee_reminder: { type: templateSchema, default: () => ({}) },
      absence: { type: templateSchema, default: () => ({}) },
      attendance_summary: { type: templateSchema, default: () => ({}) },
      exam_result: { type: templateSchema, default: () => ({}) },
      progress_report: { type: templateSchema, default: () => ({}) },
      performance_report: { type: templateSchema, default: () => ({}) },
      homework: { type: templateSchema, default: () => ({}) },
      notice: { type: templateSchema, default: () => ({}) },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

whatsAppConfigSchema.index({ tenantId: 1 }, { unique: true });

export default mongoose.model("WhatsAppConfig", whatsAppConfigSchema);
