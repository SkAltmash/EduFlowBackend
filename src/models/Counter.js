import mongoose from "mongoose";

// Per-tenant sequences (e.g. receipt numbers), incremented atomically.
const counterSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

/** Next number in a sequence; pass a session to make it part of a transaction. */
counterSchema.statics.next = async function next(tenantId, key, session) {
  const doc = await this.findOneAndUpdate(
    { tenantId, key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after", session }
  );
  return doc.seq;
};

/** Reserves `count` numbers at once and returns the first. */
counterSchema.statics.reserve = async function reserve(tenantId, key, count, session) {
  const doc = await this.findOneAndUpdate({ tenantId, key }, { $inc: { seq: count } }, { upsert: true, returnDocument: "after", session });
  return doc.seq - count + 1;
};

export default mongoose.model("Counter", counterSchema);
