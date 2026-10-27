import mongoose from "mongoose";

/** Features a plan can include; anything not listed is part of every plan. */
export const PLAN_FEATURES = Object.freeze(["whatsappApi", "homework", "timetable", "performance"]);

// What a school subscribes to. Prices in paise; studentLimit 0 = unlimited.
const platformPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    priceMonthly: { type: Number, min: 0, default: 0 },
    priceYearly: { type: Number, min: 0, default: 0 },
    studentLimit: { type: Number, min: 0, default: 0 },
    features: { type: Map, of: Boolean, default: {} },
    // The plan new schools start their trial on
    isDefault: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("PlatformPlan", platformPlanSchema);
