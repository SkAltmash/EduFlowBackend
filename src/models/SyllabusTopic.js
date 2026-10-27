import mongoose from "mongoose";

// A chapter/topic of a class's subject, ticked off per section as it's taught.
const syllabusTopicSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    grade: { type: String, required: true, trim: true, maxlength: 50 },
    subject: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    order: { type: Number, default: 0 },
    completed: [{ _id: false, section: { type: String, default: "" }, date: String, by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, byName: String }],
  },
  { timestamps: true }
);

syllabusTopicSchema.index({ tenantId: 1, grade: 1, subject: 1, order: 1 });

export default mongoose.model("SyllabusTopic", syllabusTopicSchema);
