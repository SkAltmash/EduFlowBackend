import { z } from "zod";
import { objectId } from "../auth/auth.validation.js";
import { day } from "../attendance/attendance.validation.js";

export const idParamSchema = objectId;

const className = z.string({ error: "Class name is required" }).trim().min(1, "Class name is required").max(50);
const sections = z
  .array(z.string().trim().min(1).max(20))
  .max(30, "At most 30 sections")
  .refine((l) => new Set(l.map((s) => s.toLowerCase())).size === l.length, "Each section can appear only once");
const subjects = z
  .array(z.object({ name: z.string().trim().min(1, "Subject name is required").max(60), maxMarks: z.number().int().min(1).max(1000).nullish() }))
  .max(30, "At most 30 subjects")
  .refine((l) => new Set(l.map((s) => s.name.toLowerCase())).size === l.length, "Each subject can appear only once");

export const createClassSchema = z.object({ name: className, sections: sections.default([]), subjects: subjects.default([]) });

export const updateClassSchema = z
  .object({ name: className, sections, subjects })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const bulkCreateSchema = z.object({
  names: z.array(className).min(1).max(40),
  sections: sections.default([]),
});

export const reorderSchema = z.object({ ids: z.array(objectId).min(1).max(200) });

export const mergeSchema = z.object({
  // A value as stored on students today (may not be in the class list)
  from: z.object({ grade: z.string().trim().min(1).max(50), section: z.string().trim().max(20).optional() }),
  to: z.object({ classId: objectId, section: z.string().trim().max(20).default("") }),
});

const yearName = z.string().trim().min(4, "Year name is required, e.g. 2026-27").max(20);

export const createYearSchema = z
  .object({ name: yearName, startDate: day, endDate: day })
  .refine((v) => v.startDate < v.endDate, { message: "The year must end after it starts", path: ["endDate"] });

export const updateYearSchema = z
  .object({ name: yearName, startDate: day, endDate: day, isCurrent: z.literal(true) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const promoteSchema = z.object({
  toYear: z.object({ name: yearName, startDate: day, endDate: day }).refine((v) => v.startDate < v.endDate, { message: "The year must end after it starts", path: ["endDate"] }),
  moves: z
    .array(z.object({ classId: objectId, target: z.union([objectId, z.enum(["graduate", "stay"])]) }))
    .min(1, "Choose where at least one class moves")
    .max(200),
  // Students who don't follow their class
  exceptions: z.array(z.object({ studentId: objectId, action: z.enum(["retain", "leave", "graduate"]) })).max(5000).default([]),
  clearRollNumbers: z.boolean().default(true),
});
