// Helpers shared by the classroom features (homework, leave, notes, notices, timetable, syllabus).
import { z } from "zod";
import Student from "../../models/Student.js";
import User from "../../models/User.js";
import { ROLES } from "../../models/Membership.js";
import { authorize } from "../../middleware/authorize.js";
import AppError from "../../utils/AppError.js";
import { loadClassList } from "../academics/class-names.js";
import { objectId } from "../auth/auth.validation.js";

export { objectId };
export { day } from "../attendance/attendance.validation.js";

/** Owners, admins and teachers: the people who run classes. */
export const teachingStaff = authorize(ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER);
export const adminOnly = authorize(ROLES.OWNER, ROLES.ADMIN);
export const isAdmin = (user) => user.role === ROLES.OWNER || user.role === ROLES.ADMIN;

export const classFields = {
  grade: z.string({ error: "Choose a class" }).trim().min(1, "Choose a class").max(50),
  section: z.string().trim().max(20).default(""),
};

export function idParam(router, ...names) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (!objectId.safeParse(value).success) throw AppError.badRequest(`Invalid ${name}`, "INVALID_ID");
      next();
    });
  }
}

/** The school's spelling of a class/section, or a 400. */
export async function canonical(tenantId, grade, section) {
  const r = (await loadClassList(tenantId)).resolve(grade, section);
  if (r.error || !r.grade) throw AppError.badRequest(r.error?.message ?? "Choose a class", "INVALID_CLASS", [r.error ?? { field: "grade", message: "Choose a class" }]);
  return { grade: r.grade, section: r.section };
}

export async function nameOf(userId) {
  return (await User.findById(userId, { name: 1 }).lean())?.name ?? "";
}

/** Active students of a class ("" section = every section), in roll order. */
export function classStudents(tenantId, grade, section) {
  return Student.find({ tenantId, status: "active", grade, ...(section ? { section } : {}) }, { firstName: 1, lastName: 1, rollNo: 1, section: 1, guardianPhone: 1 })
    .collation({ locale: "en", numericOrdering: true })
    .sort({ section: 1, rollNo: 1, firstName: 1 })
    .lean();
}

export const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
export const asyncRoute = (fn) => (req, res) => fn(req, res);
