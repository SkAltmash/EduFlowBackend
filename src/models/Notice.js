import mongoose from "mongoose";

// Announcements. "staff": for the team, shown in the app. "parents": for families of the
// chosen classes (grades empty = whole school), sent through WhatsApp.
const noticeSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    audience: { type: String, enum: ["staff", "parents"], required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, required: true, trim: true, maxlength: 3000 },
    classes: [{ _id: false, grade: String, section: { type: String, default: "" } }],
    pinned: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

noticeSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model("Notice", noticeSchema);
