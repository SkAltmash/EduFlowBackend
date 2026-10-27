import mongoose from "mongoose";
import Membership, { ROLES } from "../../models/Membership.js";
import TeachingAssignment from "../../models/TeachingAssignment.js";
import AppError from "../../utils/AppError.js";
import { loadClassList } from "../academics/class-names.js";
import { teacherScope } from "./teaching.scope.js";

const naturalCompare = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

function group(assignments, classList) {
  // { grade, section, classTeacher, subjects[] } per class/section, in school order
  const map = new Map();
  for (const a of assignments) {
    const key = `${a.grade}|${a.section || ""}`;
    const g = map.get(key) ?? { grade: a.grade, section: a.section || "", classTeacher: false, subjects: [] };
    if (a.subject) g.subjects.push(a.subject);
    else g.classTeacher = true;
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, subjects: g.subjects.sort(naturalCompare) }))
    .sort((a, b) => classList.compareGrades(a.grade, b.grade) || naturalCompare(a.section, b.section));
}

/** The signed-in member's classes ("My classes"). */
export async function mine(user) {
  const [scope, classList] = await Promise.all([teacherScope(user), loadClassList(user.tenantId)]);
  return { limited: scope.limited, classes: group(scope.assignments, classList) };
}

/** Every assignment, grouped by teacher (for Settings → Team and class pages). */
export async function listAll(tenantId) {
  const [rows, classList] = await Promise.all([TeachingAssignment.find({ tenantId }).lean(), loadClassList(tenantId)]);
  const byUser = new Map();
  for (const r of rows) byUser.set(String(r.userId), [...(byUser.get(String(r.userId)) ?? []), r]);
  return {
    teachers: [...byUser.entries()].map(([userId, list]) => ({ userId, classes: group(list, classList) })),
    // Class teacher(s) of each class/section, for showing on class lists
    classTeachers: rows.filter((r) => !r.subject).map((r) => ({ userId: String(r.userId), grade: r.grade, section: r.section || "" })),
  };
}

/** Replaces one member's assignments. Classes and sections must be in the class list. */
export async function replace(tenantId, userId, { assignments }) {
  const member = await Membership.findOne({ tenantId, userId }).lean();
  if (!member) throw AppError.notFound("Team member not found");
  if (member.role === ROLES.ACCOUNTANT) throw AppError.badRequest("Accountants can't be assigned to classes", "NOT_TEACHING_STAFF");

  const classList = await loadClassList(tenantId);
  const clean = [];
  const seen = new Set();
  for (const [i, a] of assignments.entries()) {
    const r = classList.resolve(a.grade, a.section);
    if (r.error || !r.grade) throw AppError.badRequest(r.error?.message ?? "Choose a class", "INVALID_CLASS", [{ field: `assignments.${i}`, message: r.error?.message ?? "Choose a class" }]);
    const subject = (a.subject ?? "").trim();
    const key = `${r.grade}|${r.section}|${subject.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ tenantId, userId, grade: r.grade, section: r.section, subject });
  }

  await mongoose.connection.transaction(async (session) => {
    await TeachingAssignment.deleteMany({ tenantId, userId }, { session });
    if (clean.length) await TeachingAssignment.insertMany(clean, { session });
  });
  return listAll(tenantId);
}
