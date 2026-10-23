// Creates/updates all MongoDB indexes defined in the Mongoose schemas.
// Run once per deploy in production (autoIndex is disabled there): npm run db:indexes
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/config/database.js";
import "../src/models/User.js";
import "../src/models/Tenant.js";
import "../src/models/Membership.js";
import "../src/models/Session.js";
import "../src/models/AuditLog.js";
import "../src/models/Student.js";
import "../src/models/Attendance.js";
import "../src/models/FeePlan.js";
import "../src/models/Invoice.js";
import "../src/models/Payment.js";
import "../src/models/Counter.js";
import "../src/models/WhatsAppConfig.js";
import "../src/models/WhatsAppMessage.js";

await connectDB();
for (const model of Object.values(mongoose.models)) {
  await model.syncIndexes();
  const indexes = await model.collection.indexes();
  console.log(`${model.modelName}: ${indexes.map((i) => i.name).join(", ")}`);
}
await disconnectDB();
