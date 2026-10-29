import mongoose from "mongoose";

// Per-school preferences that aren't tied to one module's data.
const schoolSettingsSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    // Shown on receipts, report cards and the letterhead of everything printed
    profile: {
      type: { type: String, enum: ["school", "tuition", "coaching", "other"], default: "school" },
      board: { type: String, trim: true, maxlength: 60, default: "" },
      phone: { type: String, trim: true, maxlength: 30, default: "" },
      email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
      website: { type: String, trim: true, maxlength: 200, default: "" },
      address: { type: String, trim: true, maxlength: 300, default: "" },
      city: { type: String, trim: true, maxlength: 80, default: "" },
      state: { type: String, trim: true, maxlength: 80, default: "" },
      pincode: { type: String, trim: true, maxlength: 12, default: "" },
      // Month (1-12) the academic year starts; April in most Indian schools
      academicYearStart: { type: Number, min: 1, max: 12, default: 4 },
      receiptNote: { type: String, trim: true, maxlength: 300, default: "" },
      // Logo on Cloudinary (set through /api/school/logo)
      logoUrl: { type: String, trim: true, maxlength: 500, default: "" },
      logoPublicId: { type: String, trim: true, maxlength: 300, default: "" },
    },
    // How fee receipts look (Settings → Receipts)
    receipt: {
      title: { type: String, trim: true, maxlength: 60, default: "Fee receipt" },
      accent: { type: String, enum: ["indigo", "emerald", "teal", "maroon", "orange", "slate"], default: "indigo" },
      // New receipts: <prefix><number>, e.g. ALN-00012 (existing receipts keep their number)
      prefix: { type: String, trim: true, maxlength: 10, default: "R" },
      signatureLabel: { type: String, trim: true, maxlength: 60, default: "Authorised signature" },
      paper: { type: String, enum: ["a5", "a4"], default: "a5" },
      // Print an office copy and a parent copy on one page
      twoCopies: { type: Boolean, default: false },
      show: {
        logo: { type: Boolean, default: true },
        // Off for logos that already contain the name (the logo is then shown larger)
        schoolName: { type: Boolean, default: true },
        title: { type: Boolean, default: true },
        contact: { type: Boolean, default: true },
        guardian: { type: Boolean, default: true },
        amountInWords: { type: Boolean, default: true },
        summary: { type: Boolean, default: true },
        concessions: { type: Boolean, default: true },
        receivedBy: { type: Boolean, default: true },
        signature: { type: Boolean, default: true },
        footer: { type: Boolean, default: true },
      },
    },
    // How report cards and monthly progress reports look (Settings → Report cards)
    reportCard: {
      title: { type: String, trim: true, maxlength: 60, default: "Report card" },
      monthlyTitle: { type: String, trim: true, maxlength: 60, default: "Monthly progress report" },
      accent: { type: String, enum: ["indigo", "emerald", "teal", "maroon", "orange", "slate"], default: "indigo" },
      // Up to three signature lines; empty labels are left out
      signatures: { type: [{ type: String, trim: true, maxlength: 40 }], default: ["Class teacher", "Principal", "Parent"] },
      note: { type: String, trim: true, maxlength: 300, default: "" },
      paper: { type: String, enum: ["a5", "a4"], default: "a4" },
      show: {
        logo: { type: Boolean, default: true },
        schoolName: { type: Boolean, default: true },
        title: { type: Boolean, default: true },
        contact: { type: Boolean, default: true },
        admissionNo: { type: Boolean, default: true },
        rollNo: { type: Boolean, default: true },
        gradeColumn: { type: Boolean, default: true },
        resultColumn: { type: Boolean, default: true },
        percentage: { type: Boolean, default: true },
        rank: { type: Boolean, default: true },
        resultBox: { type: Boolean, default: true },
        remarks: { type: Boolean, default: true },
        attendance: { type: Boolean, default: true },
      },
    },
    // One-tap concessions for fee staff, e.g. "Sibling 10%", "RTE free"
    concessionPresets: [
      {
        name: { type: String, required: true, trim: true, maxlength: 60 },
        type: { type: String, enum: ["percent", "amount", "fixed", "free"], required: true },
        value: { type: Number, min: 0, default: 0 },
      },
    ],
    grading: {
      scale: { type: String, enum: ["cbse", "simple"], default: "cbse" },
      passPercent: { type: Number, min: 0, max: 100, default: 33 },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

schoolSettingsSchema.index({ tenantId: 1 }, { unique: true });

export default mongoose.model("SchoolSettings", schoolSettingsSchema);
