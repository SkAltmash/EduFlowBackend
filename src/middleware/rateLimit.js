import { rateLimit } from "express-rate-limit";

function limiter({ windowMinutes, limit, message }) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error: { code: "TOO_MANY_REQUESTS", message } });
    },
  });
}

// Failed and successful attempts both count, per IP
export const loginLimiter = limiter({
  windowMinutes: 15,
  limit: 10,
  message: "Too many login attempts. Please try again later.",
});

export const registerLimiter = limiter({
  windowMinutes: 60,
  limit: 5,
  message: "Too many accounts created from this IP. Please try again later.",
});

export const refreshLimiter = limiter({
  windowMinutes: 15,
  limit: 60,
  message: "Too many requests. Please try again later.",
});

export const adminLimiter = limiter({
  windowMinutes: 15,
  limit: 300,
  message: "Too many admin requests. Please slow down.",
});
