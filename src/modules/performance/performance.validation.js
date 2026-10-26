import { z } from "zod";
import { day } from "../attendance/attendance.validation.js";

export const MAX_PERIOD_DAYS = 400;

export const performanceQuery = z
  .object({
    from: day,
    to: day,
    grade: z.string().trim().max(50).optional(),
    section: z.string().trim().max(20).optional(),
  })
  .refine((q) => q.from <= q.to, { message: "`from` must be on or before `to`", path: ["from"] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_PERIOD_DAYS, { message: `At most ${MAX_PERIOD_DAYS} days`, path: ["to"] });
