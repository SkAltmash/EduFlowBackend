import mongoose from "mongoose";

// One year-end promotion run: what changed for each student, so it can be undone.
const snapshot = { _id: false, grade: String, section: String, rollNo: String, status: String };

const promotionSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    fromYear: { type: String, required: true },
    toYear: { type: String, required: true },
    entries: [
      {
        _id: false,
        studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
        outcome: { type: String, enum: ["promoted", "retained", "graduated", "left"], required: true },
        before: snapshot,
        after: snapshot,
      },
    ],
    counts: { promoted: Number, retained: Number, graduated: Number, left: Number },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: String,
    undone: { at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, byName: String, restored: Number, skipped: Number },
  },
  { timestamps: true }
);

promotionSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model("Promotion", promotionSchema);
