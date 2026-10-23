import mongoose from "mongoose";
import env from "./env.js";

export async function connectDB() {
  mongoose.set("strictQuery", true);

  await mongoose.connect(env.MONGODB_URI, {
    autoIndex: !env.isProduction,
  });
  console.log(`MongoDB connected: ${mongoose.connection.host}`);

  mongoose.connection.on("error", (err) => {
    console.error("MongoDB error:", err);
  });
}

export async function disconnectDB() {
  await mongoose.connection.close();
}
