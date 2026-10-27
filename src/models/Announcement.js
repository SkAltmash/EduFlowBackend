import mongoose from "mongoose";

// A platform-wide message shown as a banner inside every school's app.
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, trim: true, maxlength: 500, default: "" },
    tone: { type: String, enum: ["info", "warning", "success"], default: "info" },
    // Optional link, e.g. to a changelog or WhatsApp
    linkUrl: { type: String, trim: true, maxlength: 300, default: "" },
    linkLabel: { type: String, trim: true, maxlength: 40, default: "" },
    startsAt: { type: Date, default: () => new Date() },
    endsAt: Date,
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

announcementSchema.index({ active: 1, startsAt: -1 });

export default mongoose.model("Announcement", announcementSchema);
