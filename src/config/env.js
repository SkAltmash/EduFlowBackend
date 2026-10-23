import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("eduflow-api"),
  JWT_AUDIENCE: z.string().default("eduflow-app"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Comma-separated list of allowed frontend origins
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  // "strict" | "lax" | "none" — use "none" only when the frontend is on a different site (requires HTTPS)
  COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
  COOKIE_DOMAIN: z.string().optional(),
  // Number of reverse proxies in front of the app (needed for correct client IPs in rate limiting)
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Optional comma-separated IPs allowed to reach /api/admin (empty = any IP)
  ADMIN_IP_ALLOWLIST: z.string().default(""),

  // Encrypts secrets stored in the database (e.g. each school's WhatsApp token).
  // Required only to switch on automatic WhatsApp sending.
  DATA_ENCRYPTION_KEY: z.string().min(32, "DATA_ENCRYPTION_KEY must be at least 32 characters").optional(),
  // WhatsApp Business (Cloud API) — shared by every school on this platform
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v22.0"),
  WHATSAPP_GRAPH_URL: z.string().url().default("https://graph.facebook.com"),
  // Webhook (delivery / read receipts): the verify token you enter in the Meta app, and the app secret
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
  console.error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different");
  process.exit(1);
}

export default {
  ...env,
  isProduction: env.NODE_ENV === "production",
  corsOrigins: env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
  adminIpAllowlist: env.ADMIN_IP_ALLOWLIST.split(",").map((ip) => ip.trim()).filter(Boolean),
};
