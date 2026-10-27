// Student leave: GET/POST /api/leaves, DELETE /api/leaves/:leaveId
import { Router } from "express";
import { z } from "zod";
import Student from "../../models/Student.js";
import StudentLeave from "../../models/StudentLeave.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import { assertTeachesClass, teacherScope } from "../teaching/teaching.scope.js";
import { day, fullName, idParam, isAdmin, nameOf, objectId, teachingStaff } from "./classroom.common.js";

const createSchema = z
  .object({ studentId: objectId, from: day, to: day, reason: z.string().trim().max(200).default("") })
  .refine((v) => v.from <= v.to, { message: "Leave must end on or after it starts", path: ["to"] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 60, { message: "At most 60 days at a time", path: ["to"] });
const listQuery = z.object({ from: day, to: day, studentId: objectId.optional() });

/** Leaves overlapping [from, to], with student names. */
export async function leavesBetween(tenantId, from, to, extra = {}) {
  const leaves = await StudentLeave.find({ tenantId, from: { $lte: to }, to: { $gte: from }, ...extra }).sort({ from: 1 }).lean();
  const students = await Student.find({ tenantId, _id: { $in: leaves.map((l) => l.studentId) } }, { firstName: 1, lastName: 1, grade: 1, section: 1 }).lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));
  return leaves
    .filter((l) => byId.has(String(l.studentId)))
    .map((l) => {
      const s = byId.get(String(l.studentId));
      return { id: String(l._id), studentId: String(l.studentId), studentName: fullName(s), grade: s.grade || "", section: s.section || "", from: l.from, to: l.to, reason: l.reason || "", createdBy: String(l.createdBy), createdByName: l.createdByName || "" };
    });
}

const router = Router();
router.use(authenticate, teachingStaff);
idParam(router, "leaveId");

router.get("/", validateQuery(listQuery), async (req, res) => {
  const { from, to, studentId } = req.validatedQuery;
  res.json({ leaves: await leavesBetween(req.user.tenantId, from, to, studentId ? { studentId } : {}) });
});

router.post("/", validateBody(createSchema), async (req, res) => {
  const student = await Student.findOne({ _id: req.body.studentId, tenantId: req.user.tenantId }, { grade: 1, section: 1 }).lean();
  if (!student) throw AppError.notFound("Student not found");
  assertTeachesClass(await teacherScope(req.user), student.grade, student.section || "", "record leave for");
  const leave = await StudentLeave.create({ ...req.body, tenantId: req.user.tenantId, createdBy: req.user.id, createdByName: await nameOf(req.user.id) });
  res.status(201).json({ leave: (await leavesBetween(req.user.tenantId, leave.from, leave.to, { _id: leave._id }))[0] });
});

router.delete("/:leaveId", async (req, res) => {
  const leave = await StudentLeave.findOne({ _id: req.params.leaveId, tenantId: req.user.tenantId });
  if (!leave) throw AppError.notFound("Leave not found");
  if (!isAdmin(req.user) && String(leave.createdBy) !== String(req.user.id)) throw AppError.forbidden("Only who recorded it or an admin can remove it", "NOT_AUTHOR");
  await leave.deleteOne();
  res.status(204).end();
});

export default router;
