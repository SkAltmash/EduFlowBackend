import mongoose from "mongoose";

// A change the AI assistant prepared (record a fee payment, mark attendance, add a note).
// Nothing is written until the member who asked picks the student and confirms; the
// change then goes through the same service as the app's own screens. Kept 180 days.
export const AI_ACTION_KINDS = Object.freeze(["fee_payment", "attendance", "class_attendance", "student_note"]);
export const AI_ACTION_STATUSES = Object.freeze(["pending", "running", "done", "cancelled", "failed"]);

const candidateSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    name: String,
    class: String,
    admissionNo: String,
    guardianName: String,
    // What helps tell them apart for this action: fee balance (paise) or that day's attendance
    balance: Number,
    // Fee payments: whether any fee plan (dues) is assigned to them
    hasFeePlan: Boolean,
    attendance: String,
  },
  { _id: false }
);

const aiActionSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: AI_ACTION_KINDS, required: true },
    status: { type: String, enum: AI_ACTION_STATUSES, default: "pending" },
    // The name or admission number the AI searched for
    query: { type: String, maxlength: 100, default: "" },
    // fee_payment: { amount (paise), mode, date, note } · attendance: { status, date } · student_note: { kind, text }
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    candidates: { type: [candidateSchema], default: [] },
    // Filled in on confirm
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student" },
    result: { type: mongoose.Schema.Types.Mixed },
    error: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
    doneAt: Date,
  },
  { timestamps: true }
);

aiActionSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
aiActionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export default mongoose.model("AiAction", aiActionSchema);
