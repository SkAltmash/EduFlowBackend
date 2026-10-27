import mongoose from "mongoose";

export const NOTE_KINDS = Object.freeze(["note", "praise", "concern", "meeting"]);

// Staff-only notes about a student: remarks, behaviour (praise / concern), parent meetings.
const studentNoteSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    kind: { type: String, enum: NOTE_KINDS, default: "note" },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

studentNoteSchema.index({ tenantId: 1, studentId: 1, createdAt: -1 });

export default mongoose.model("StudentNote", studentNoteSchema);
