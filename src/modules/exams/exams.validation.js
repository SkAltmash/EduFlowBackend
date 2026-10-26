import { z } from "zod";
import { objectId } from "../auth/auth.validation.js";
import { day } from "../attendance/attendance.validation.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM");
// Marks may be half or quarter marks (e.g. 42.5), never more precise than 2 decimals
const markValue = z
  .number({ error: "Marks must be a number" })
  .min(0, "Marks can't be negative")
  .max(1000)
  .refine((v) => Math.round(v * 100) === v * 100, "Use at most 2 decimals");

const subject = z
  .object({
    // Present when editing an existing subject, so its marks stay linked
    _id: objectId.optional(),
    name: z.string().trim().min(1, "Subject name is required").max(60),
    maxMarks: z.number({ error: "Maximum marks must be a number" }).int("Maximum marks must be a whole number").min(1).max(1000),
    passMarks: z.number().min(0).max(1000).nullable().optional(),
  })
  .refine((s) => s.passMarks == null || s.passMarks <= s.maxMarks, { message: "Pass marks can't exceed maximum marks", path: ["passMarks"] });

const examFields = {
  name: z.string().trim().min(2, "Test name must be at least 2 characters").max(100),
  grade: z.string().trim().min(1, "Class is required").max(50),
  // "" = the whole class (every section)
  section: z.string().trim().max(20),
  date: day,
  subjects: z
    .array(subject)
    .min(1, "Add at least one subject")
    .max(20, "At most 20 subjects")
    .refine((list) => new Set(list.map((s) => s.name.toLowerCase())).size === list.length, "Subject names must be different"),
  description: z.string().trim().max(500),
};

// Defaults only when creating: on a partial update a default would overwrite saved values
export const createExamSchema = z.object({
  ...examFields,
  section: examFields.section.default(""),
  description: examFields.description.default(""),
});

export const updateExamSchema = z
  .object(examFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const saveMarksSchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: objectId,
        marks: z
          .array(z.object({ subjectId: objectId, marks: markValue.nullable(), absent: z.boolean().default(false) }))
          .max(20),
        remarks: z.string().trim().max(300).optional(),
      })
    )
    .min(1, "Nothing to save")
    .max(500)
    .refine((e) => new Set(e.map((x) => x.studentId)).size === e.length, "Each student can appear only once"),
});

export const listExamsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  grade: z.string().trim().max(50).optional(),
  section: z.string().trim().max(20).optional(),
  month: month.optional(),
  search: z.string().trim().max(100).optional(),
});

export const studentReportQuery = z.object({ month });

export const classReportQuery = z.object({
  grade: z.string().trim().min(1).max(50),
  section: z.string().trim().max(20).default(""),
  month,
});

export const gradingSchema = z
  .object({
    scale: z.enum(["cbse", "simple"]),
    passPercent: z.number().min(0).max(100),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one setting");

export const idParamSchema = objectId;
