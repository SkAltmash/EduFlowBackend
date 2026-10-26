import mongoose from "mongoose";

// A class of the school ("Nursery", "5", "12 Science") with its sections and subjects.
// Students, attendance, fees and tests store the class *name* (a snapshot that keeps
// history readable); renaming a class here updates those names everywhere.
const schoolClassSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    name: { type: String, required: true, trim: true, maxlength: 50 },
    // Position in the school, lowest first; promotion moves students to the next one
    order: { type: Number, required: true },
    sections: { type: [{ type: String, trim: true, maxlength: 20 }], default: [] },
    subjects: [
      {
        name: { type: String, required: true, trim: true, maxlength: 60 },
        // Default maximum when a test is created for this class
        maxMarks: { type: Number, min: 1, max: 1000 },
      },
    ],
  },
  { timestamps: true }
);

schoolClassSchema.index({ tenantId: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
schoolClassSchema.index({ tenantId: 1, order: 1 });

export default mongoose.model("SchoolClass", schoolClassSchema);
