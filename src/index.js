import env from "./config/env.js";
import app from "./app.js";
import { connectDB, disconnectDB } from "./config/database.js";

try {
  await connectDB();
} catch (err) {
  console.error("Failed to connect to MongoDB:", err.message);
  process.exit(1);
}

const server = app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    await disconnectDB();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
