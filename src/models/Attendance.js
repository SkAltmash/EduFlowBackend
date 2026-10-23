import mongoose from "mongoose";

export const ATTENDANCE_STATUSES = Object.freeze(["present", "absent", "late", "leave"]);

// One mark per student per school day. `date` is the calendar day as "YYYY-MM-DD"
// (no time zone involved, sorts correctly as text). `grade` / `section` are a
// snapshot of the student's class when marked, so history survives class changes.
const attendanceSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    grade: { type: String, required: true, trim: true, maxlength: 50 },
    section: { type: String, trim: true, maxlength: 20, default: "" },
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    note: { type: String, trim: true, maxlength: 200, default: "" },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// One record per student per day; also serves a student's history (date range)
attendanceSchema.index({ tenantId: 1, studentId: 1, date: 1 }, { unique: true });
// A class register for one day, and the per-day overview of all classes
attendanceSchema.index({ tenantId: 1, date: 1, grade: 1, section: 1 });
// Class reports over a date range
attendanceSchema.index({ tenantId: 1, grade: 1, section: 1, date: 1 });

export default mongoose.model("Attendance", attendanceSchema);
