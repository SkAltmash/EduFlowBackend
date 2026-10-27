import mongoose from "mongoose";

// One period in a class's weekly timetable. day: 1 = Monday … 7 = Sunday; times "HH:MM".
const timetableSlotSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    grade: { type: String, required: true, trim: true, maxlength: 50 },
    section: { type: String, trim: true, maxlength: 20, default: "" },
    day: { type: Number, required: true, min: 1, max: 7 },
    start: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    end: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    subject: { type: String, required: true, trim: true, maxlength: 60 },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

timetableSlotSchema.index({ tenantId: 1, grade: 1, section: 1, day: 1, start: 1 });
timetableSlotSchema.index({ tenantId: 1, teacherId: 1, day: 1 });

export default mongoose.model("TimetableSlot", timetableSlotSchema);
