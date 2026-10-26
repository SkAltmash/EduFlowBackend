import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import env, { normalizeOrigin } from "./config/env.js";
import healthRouter from "./routes/health.js";
import authRouter from "./modules/auth/auth.routes.js";
import tenantRouter from "./modules/tenant/tenant.routes.js";
import adminRouter from "./modules/admin/admin.routes.js";
import studentsRouter from "./modules/students/students.routes.js";
import attendanceRouter from "./modules/attendance/attendance.routes.js";
import feesRouter from "./modules/fees/fees.routes.js";
import whatsappRouter from "./modules/whatsapp/whatsapp.routes.js";
import examsRouter from "./modules/exams/exams.routes.js";
import dashboardRouter from "./modules/dashboard/dashboard.routes.js";
import schoolRouter from "./modules/school/school.routes.js";
import academicsRouter from "./modules/academics/academics.routes.js";
import performanceRouter from "./modules/performance/performance.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

const app = express();

// Log each blocked origin once, so a missing CORS_ORIGINS entry is easy to spot in the server logs
const warnedOrigins = new Set();
function warnBlockedOrigin(origin) {
  if (warnedOrigins.has(origin) || warnedOrigins.size > 100) return;
  warnedOrigins.add(origin);
  console.warn(`CORS: blocked requests from ${origin}. Add it to CORS_ORIGINS to allow it. Allowed now: ${env.corsOrigins.join(", ") || "(none)"}`);
}

app.set("trust proxy", env.TRUST_PROXY);
app.disable("x-powered-by");

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients (curl, server-to-server) which send no Origin
      if (!origin || env.corsOrigins.includes(normalizeOrigin(origin))) return callback(null, true);
      warnBlockedOrigin(origin);
      callback(null, false);
    },
    credentials: true, // needed for the refresh-token cookie
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  })
);
// Student CSV import sends up to 1000 rows as JSON; parsed first so the 100kb default skips it
app.use("/api/students/import", express.json({ limit: "2mb" }));
// Meta's webhook signature is computed over the exact bytes, so keep this body raw
app.use("/api/whatsapp/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/", (req, res) => {
  res.json({ message: "EduFlow API" });
});

app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/tenant", tenantRouter);
app.use("/api/admin", adminRouter);
app.use("/api/students", studentsRouter);
app.use("/api/attendance", attendanceRouter);
app.use("/api/fees", feesRouter);
app.use("/api/whatsapp", whatsappRouter);
app.use("/api/exams", examsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/school", schoolRouter);
app.use("/api/academics", academicsRouter);
app.use("/api/performance", performanceRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
