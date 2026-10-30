import mongoose from "mongoose";

// Platform-wide settings edited in the super admin console (one document, key "platform").
const platformSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "platform" },
    // Shown to schools on renew / upgrade links (digits with country code, e.g. 919876543210)
    supportWhatsapp: { type: String, trim: true, maxlength: 20, default: "" },
    supportEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    // Image uploads (school logos). The API secret is stored encrypted (DATA_ENCRYPTION_KEY).
    cloudinary: {
      cloudName: { type: String, trim: true, maxlength: 100, default: "" },
      apiKey: { type: String, trim: true, maxlength: 100, default: "" },
      apiSecretEnc: { type: String, default: "" },
      folder: { type: String, trim: true, maxlength: 100, default: "eduflow" },
    },
    // SMS OTP through 2Factor.in (sign in with mobile, verify mobile at sign-up). API key encrypted.
    otp: {
      enabled: { type: Boolean, default: false },
      apiKeyEnc: { type: String, default: "" },
      // 2Factor OTP template name ("" = their default template)
      template: { type: String, trim: true, maxlength: 60, default: "" },
      // New accounts must verify a mobile number
      requireOnRegister: { type: Boolean, default: true },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("PlatformSettings", platformSettingsSchema);
