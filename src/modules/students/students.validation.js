import { z } from "zod";
import { GENDERS, STUDENT_STATUSES } from "../../models/Student.js";
import { objectId } from "../auth/auth.validation.js";

export const MAX_IMPORT_ROWS = 1000;

// Optional text: "" and null clear the field, missing leaves it untouched
const optionalText = (max) =>
  z
    .union([z.string().trim().max(max, `Must be at most ${max} characters`), z.null()])
    .optional()
    .transform((v) => (v === null ? "" : v));

const optionalEmail = z
  .union([z.literal(""), z.null(), z.string().trim().toLowerCase().pipe(z.email("Invalid email address"))])
  .optional()
  .transform((v) => (v === null ? "" : v));

// Accepts "YYYY-MM-DD" or any ISO date; "" / null clear it
const optionalDate = z
  .union([z.literal(""), z.null(), z.coerce.date()], { error: "Invalid date, use YYYY-MM-DD" })
  .optional()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => !(v instanceof Date) || !Number.isNaN(v.getTime()), "Invalid date");

const optionalEnum = (values) =>
  z
    .union([z.literal(""), z.null(), z.enum(values)], { error: `Must be one of: ${values.join(", ")}` })
    .optional()
    .transform((v) => (v === "" ? null : v));

const fields = {
  admissionNo: z
    .string({ error: "Admission number is required" })
    .trim()
    .min(1, "Admission number is required")
    .max(50, "Admission number must be at most 50 characters"),
  firstName: z
    .string({ error: "First name is required" })
    .trim()
    .min(1, "First name is required")
    .max(100, "First name must be at most 100 characters"),
  lastName: optionalText(100),
  gender: optionalEnum(GENDERS),
  dateOfBirth: optionalDate,
  grade: optionalText(50),
  section: optionalText(20),
  rollNo: optionalText(20),
  email: optionalEmail,
  phone: optionalText(30),
  guardianName: optionalText(100),
  guardianPhone: optionalText(30),
  guardianEmail: optionalEmail,
  address: optionalText(500),
  admissionDate: optionalDate,
  status: z.enum(STUDENT_STATUSES).optional(),
  notes: optionalText(2000),
};

export const createStudentSchema = z.object(fields);

export const updateStudentSchema = z
  .object(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const importStudentsSchema = z.object({
  // Rows are validated one by one in the service so a bad row doesn't reject the whole file
  students: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, "The file has no rows")
    .max(MAX_IMPORT_ROWS, `Import at most ${MAX_IMPORT_ROWS} students at a time`),
  // "skip": keep existing students with the same admission number; "update": overwrite them
  onDuplicate: z.enum(["skip", "update"]).default("skip"),
});

const listFilters = {
  search: z.string().trim().max(100).optional(),
  grade: z.string().trim().max(50).optional(),
  section: z.string().trim().max(20).optional(),
  status: z.enum([...STUDENT_STATUSES, "all"]).default("all"),
  sort: z.enum(["newest", "oldest", "name", "admissionNo", "grade"]).default("newest"),
};

export const listStudentsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  ...listFilters,
});

export const exportStudentsQuery = z.object(listFilters);

export const idParamSchema = objectId;
