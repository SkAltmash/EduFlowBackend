import { z } from "zod";
import { ATTENDANCE_STATUSES } from "../../models/Attendance.js";
import { objectId } from "../auth/auth.validation.js";

export const MAX_REPORT_DAYS = 92;

/** "YYYY-MM-DD" that is a real calendar day (rejects 2026-02-30). */
export const day = z
  .string({ error: "Date is required" })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Invalid date");

const classFields = {
  grade: z.string({ error: "Class is required" }).trim().min(1, "Class is required").max(50),
  // "" = a class without sections
  section: z.string().trim().max(20).default(""),
};

export const classesQuery = z.object({ date: day });

export const registerQuery = z.object({ date: day, ...classFields });

export const saveRegisterSchema = z.object({
  date: day,
  ...classFields,
  entries: z
    .array(
      z.object({
        studentId: objectId,
        status: z.enum(ATTENDANCE_STATUSES, { error: `Status must be one of: ${ATTENDANCE_STATUSES.join(", ")}` }),
        note: z.string().trim().max(200, "Note must be at most 200 characters").optional(),
      })
    )
    .min(1, "Mark at least one student")
    .max(500, "At most 500 students per class")
    .refine((entries) => new Set(entries.map((e) => e.studentId)).size === entries.length, "Each student can appear only once"),
});

/** Adds the from <= to and maximum-length rules to a schema with `from` / `to`. */
const withRange = (schema) =>
  schema
    .refine((v) => v.from <= v.to, { message: "`from` must be on or before `to`", path: ["from"] })
    .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < MAX_REPORT_DAYS, {
      message: `Choose a range of at most ${MAX_REPORT_DAYS} days`,
      path: ["to"],
    });

export const reportQuery = withRange(z.object({ ...classFields, from: day, to: day }));

export const studentHistoryQuery = withRange(z.object({ from: day, to: day }));

export const idParamSchema = objectId;
