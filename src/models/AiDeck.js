import mongoose from "mongoose";

// A presentation made with AI: from a topic, or from the school's records (a test's results,
// a month's review). Slides are plain JSON shared by the in-app viewer and the PowerPoint/PDF
// export. Private to the member who made it.
export const DECK_KINDS = Object.freeze(["topic", "class_results", "monthly_review"]);
export const DECK_THEMES = Object.freeze(["classic", "midnight", "sunrise", "chalk"]);
export const SLIDE_LAYOUTS = Object.freeze(["title", "section", "bullets", "two_column", "stats", "chart", "table", "quote", "image", "closing"]);
export const MAX_SLIDES = 20;

const aiDeckSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: DECK_KINDS, required: true },
    title: { type: String, trim: true, maxlength: 150, required: true },
    language: { type: String, enum: ["en", "hi", "mr"], default: "en" },
    theme: { type: String, enum: DECK_THEMES, default: "classic" },
    // What it was made from: { topic, audience } or { examId } or { month }
    source: { type: mongoose.Schema.Types.Mixed, default: {} },
    // [{ layout, title, subtitle, bullets, left, right, stats, chart, table, quote, notes }]
    slides: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

aiDeckSchema.index({ tenantId: 1, userId: 1, updatedAt: -1 });

export default mongoose.model("AiDeck", aiDeckSchema);
