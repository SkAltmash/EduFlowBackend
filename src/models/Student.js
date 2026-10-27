import mongoose from "mongoose";

export const STUDENT_STATUSES = Object.freeze(["active", "inactive", "graduated", "left"]);
export const GENDERS = Object.freeze(["male", "female", "other"]);

// A student always belongs to exactly one tenant. Every query must filter by
// tenantId (taken from the verified token), never by a value from the client.
const studentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    // School-assigned identifier, unique within a tenant
    admissionNo: { type: String, required: true, trim: true, maxlength: 50 },
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, trim: true, maxlength: 100, default: "" },
    gender: { type: String, enum: GENDERS },
    dateOfBirth: { type: Date },
    // The class's name from Settings → Classes (a free-text value only if the school has no class list yet)
    grade: { type: String, trim: true, maxlength: 50, default: "" },
    section: { type: String, trim: true, maxlength: 20, default: "" },
    rollNo: { type: String, trim: true, maxlength: 20, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 30 },
    guardianName: { type: String, trim: true, maxlength: 100 },
    guardianPhone: { type: String, trim: true, maxlength: 30 },
    guardianEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
    address: { type: String, trim: true, maxlength: 500 },
    admissionDate: { type: Date },
    status: { type: String, enum: STUDENT_STATUSES, default: "active" },
    notes: { type: String, trim: true, maxlength: 2000 },
    // Standing fee concession: applied to unpaid dues now and to plans assigned later.
    // type: percent (value 0-100), amount (paise off each installment),
    // fixed (pays `value` paise per installment), free (nothing to pay).
    feeConcession: {
      type: { type: String, enum: ["percent", "amount", "fixed", "free"] },
      value: { type: Number, min: 0 },
      reason: { type: String, trim: true, maxlength: 100 },
      presetId: { type: mongoose.Schema.Types.ObjectId },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      updatedByName: String,
      updatedAt: Date,
    },
    // One entry per finished academic year, written by year-end promotion
    classHistory: [
      {
        _id: false,
        year: String,
        grade: String,
        section: String,
        rollNo: String,
        outcome: { type: String, enum: ["promoted", "retained", "graduated", "left"] },
        promotionId: { type: mongoose.Schema.Types.ObjectId, ref: "Promotion" },
      },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
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

// One admission number per tenant (also the lookup used by CSV import)
studentSchema.index({ tenantId: 1, admissionNo: 1 }, { unique: true });
// Default list order and grade/section filters
studentSchema.index({ tenantId: 1, createdAt: -1 });
studentSchema.index({ tenantId: 1, grade: 1, section: 1 });
studentSchema.index({ tenantId: 1, status: 1 });

export default mongoose.model("Student", studentSchema);
