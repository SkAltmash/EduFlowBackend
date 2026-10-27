import mongoose from "mongoose";

// Platform-wide settings edited in the super admin console (one document, key "platform").
const platformSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "platform" },
    // Shown to schools on renew / upgrade links (digits with country code, e.g. 919876543210)
    supportWhatsapp: { type: String, trim: true, maxlength: 20, default: "" },
    supportEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("PlatformSettings", platformSettingsSchema);
