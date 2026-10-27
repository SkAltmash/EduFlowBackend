// What a signed-in member may teach. Owners, admins and accountants are not limited here
// (their own role rules apply); a teacher with no assignments yet keeps school-wide access
// so schools that haven't set up assignments keep working.
import TeachingAssignment from "../../models/TeachingAssignment.js";
import { ROLES } from "../../models/Membership.js";
import AppError from "../../utils/AppError.js";

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

export async function teacherScope(user) {
  if (user.role !== ROLES.TEACHER) return { limited: false, assignments: [] };
  const assignments = await TeachingAssignment.find({ tenantId: user.tenantId, userId: user.id }, { grade: 1, section: 1, subject: 1 }).lean();
  return { limited: assignments.length > 0, assignments: assignments.map(({ grade, section, subject }) => ({ grade, section: section || "", subject: subject || "" })) };
}

/** Assignments that cover this class and section ("" section on either side = whole class). */
function covering(scope, grade, section = "") {
  return scope.assignments.filter((a) => a.grade === grade && (!a.section || !section || a.section === section));
}

export const canTeachClass = (scope, grade, section) => !scope.limited || covering(scope, grade, section).length > 0;
export const isClassTeacher = (scope, grade, section) => !scope.limited || covering(scope, grade, section).some((a) => !a.subject);

/** Subject names this member may enter marks for in the class; null = all. */
export function markableSubjects(scope, grade, section) {
  if (isClassTeacher(scope, grade, section)) return null;
  return covering(scope, grade, section).map((a) => a.subject);
}
export const canMarkSubject = (allowed, name) => allowed === null || allowed.some((s) => same(s, name));

export function assertTeachesClass(scope, grade, section, action = "do this for") {
  if (!canTeachClass(scope, grade, section)) {
    const cls = section ? `${grade} - ${section}` : grade;
    throw AppError.forbidden(`You aren't assigned to class ${cls}, so you can't ${action} it. Ask an admin to assign you.`, "NOT_YOUR_CLASS");
  }
}

/** Mongo filter for "my classes" on records with grade/section (null = no limit). */
export function classFilter(scope) {
  if (!scope.limited) return null;
  const seen = new Set();
  const or = [];
  for (const a of scope.assignments) {
    const key = `${a.grade}|${a.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    or.push(a.section ? { grade: a.grade, section: a.section } : { grade: a.grade });
  }
  return { $or: or };
}
