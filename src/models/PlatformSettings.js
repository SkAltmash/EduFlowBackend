import mongoose from "mongoose";

// Platform-wide settings edited in the super admin console (one document, key "platform").
const platformSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "platform" },
    // Shown to schools on renew / upgrade links (digits with country code, e.g. 919876543210)
    supportWhatsapp: { type: String, trim: true, maxlength: 20, default: "" },
    supportEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    // Online payments for EduFlow plans through Razorpay. The key secret and webhook secret are stored encrypted.
    razorpay: {
      enabled: { type: Boolean, default: false },
      keyId: { type: String, trim: true, maxlength: 60, default: "" },
      keySecretEnc: { type: String, default: "" },
      webhookSecretEnc: { type: String, default: "" },
    },
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
    // AI assistant through Google's Gemini API. API key encrypted.
    ai: {
      enabled: { type: Boolean, default: false },
      apiKeyEnc: { type: String, default: "" },
      model: { type: String, trim: true, maxlength: 80, default: "gemini-3.8-flash" },
      // Questions + drafts per school per month (0 = no limit)
      monthlyQuota: { type: Number, min: 0, default: 300 },
      // How much the model thinks before answering: less is faster and cheaper
      thinking: { type: String, enum: ["minimal", "low", "default"], default: "low" },
      // For the console's cost estimates (Google's price per 1M tokens, in US$) and the rate to ₹
      priceInputUsd: { type: Number, min: 0, default: 0.75 },
      priceOutputUsd: { type: Number, min: 0, default: 3.75 },
      usdToInr: { type: Number, min: 1, default: 88 },
      // AI images on slides: who makes them, the model id (empty: off) and the price per image (US$).
      // Cloudflare Workers AI (FLUX, free daily allowance) needs the account id and an API token (encrypted).
      imageProvider: { type: String, enum: ["gemini", "cloudflare"], default: "cloudflare" },
      imageModel: { type: String, trim: true, maxlength: 80, default: "" },
      cfAccountId: { type: String, trim: true, maxlength: 64, default: "" },
      cfTokenEnc: { type: String, default: "" },
      imagePriceUsd: { type: Number, min: 0, default: 0.04 },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("PlatformSettings", platformSettingsSchema);
