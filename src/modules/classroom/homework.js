// Homework / class diary: GET/POST /api/homework, GET/PATCH/DELETE /api/homework/:homeworkId
import { Router } from "express";
import { z } from "zod";
import Homework from "../../models/Homework.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import { assertTeachesClass, canMarkSubject, classFilter, markableSubjects, teacherScope } from "../teaching/teaching.scope.js";
import { canonical, classFields, classStudents, day, fullName, idParam, isAdmin, nameOf, teachingStaff } from "./classroom.common.js";

const fields = {
  subject: z.string().trim().min(1, "Choose a subject").max(60),
  title: z.string().trim().min(2, "Give the homework a title").max(150),
  details: z.string().trim().max(2000).default(""),
  date: day,
  dueDate: day.nullish(),
};
const createSchema = z.object({ ...classFields, ...fields });
const updateSchema = z.object({ ...fields, details: z.string().trim().max(2000) }).partial().refine((v) => Object.keys(v).length > 0, "Nothing to update");
const listQuery = z.object({ from: day.optional(), to: day.optional(), grade: z.string().trim().max(50).optional(), section: z.string().trim().max(20).optional(), mine: z.enum(["1", "0"]).optional() });

const serialize = (h) => ({
  id: String(h._id),
  grade: h.grade,
  section: h.section || "",
  subject: h.subject,
  title: h.title,
  details: h.details || "",
  date: h.date,
  dueDate: h.dueDate ?? null,
  createdBy: String(h.createdBy),
  createdByName: h.createdByName || "",
  createdAt: h.createdAt,
});

/** Teachers post for their classes; a subject teacher only for their subjects. */
async function assertMayPost(user, grade, section, subject) {
  const scope = await teacherScope(user);
  assertTeachesClass(scope, grade, section, "post homework for");
  if (!canMarkSubject(markableSubjects(scope, grade, section), subject)) {
    throw AppError.forbidden(`You don't teach ${subject} in this class`, "NOT_YOUR_SUBJECT");
  }
}

async function findOwned(user, id) {
  const hw = await Homework.findOne({ _id: id, tenantId: user.tenantId });
  if (!hw) throw AppError.notFound("Homework not found");
  if (!isAdmin(user) && String(hw.createdBy) !== String(user.id)) throw AppError.forbidden("Only its author or an admin can change this", "NOT_AUTHOR");
  return hw;
}

const router = Router();
router.use(authenticate, teachingStaff);
idParam(router, "homeworkId");

router.get("/", validateQuery(listQuery), async (req, res) => {
  const { from, to, grade, section, mine } = req.validatedQuery;
  const filter = { tenantId: req.user.tenantId };
  if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (grade) Object.assign(filter, { grade, ...(section ? { section: { $in: ["", section] } } : {}) });
  if (mine === "1") {
    const scoped = classFilter(await teacherScope(req.user));
    if (scoped) filter.$or = scoped.$or.map((c) => (c.section ? { grade: c.grade, section: { $in: ["", c.section] } } : { grade: c.grade }));
  }
  const list = await Homework.find(filter).sort({ date: -1, createdAt: -1 }).limit(200).lean();
  res.json({ homework: list.map(serialize) });
});

router.post("/", validateBody(createSchema), async (req, res) => {
  const cls = await canonical(req.user.tenantId, req.body.grade, req.body.section);
  await assertMayPost(req.user, cls.grade, cls.section, req.body.subject);
  if (req.body.dueDate && req.body.dueDate < req.body.date) throw AppError.badRequest("The due date can't be before the homework date", "INVALID_DATES", [{ field: "dueDate", message: "Due date is before the homework date" }]);
  const hw = await Homework.create({ ...req.body, ...cls, dueDate: req.body.dueDate ?? undefined, tenantId: req.user.tenantId, createdBy: req.user.id, createdByName: await nameOf(req.user.id) });
  res.status(201).json({ homework: serialize(hw) });
});

/** One entry with the students whose parents can be messaged. */
router.get("/:homeworkId", async (req, res) => {
  const hw = await Homework.findOne({ _id: req.params.homeworkId, tenantId: req.user.tenantId }).lean();
  if (!hw) throw AppError.notFound("Homework not found");
  const students = await classStudents(req.user.tenantId, hw.grade, hw.section);
  res.json({ homework: serialize(hw), students: students.map((s) => ({ id: String(s._id), fullName: fullName(s), section: s.section || "", hasPhone: Boolean(s.guardianPhone) })) });
});

router.patch("/:homeworkId", validateBody(updateSchema), async (req, res) => {
  const hw = await findOwned(req.user, req.params.homeworkId);
  if (req.body.subject) await assertMayPost(req.user, hw.grade, hw.section, req.body.subject);
  Object.assign(hw, { ...req.body, dueDate: req.body.dueDate === null ? undefined : (req.body.dueDate ?? hw.dueDate) });
  await hw.save();
  res.json({ homework: serialize(hw) });
});

router.delete("/:homeworkId", async (req, res) => {
  const hw = await findOwned(req.user, req.params.homeworkId);
  await hw.deleteOne();
  res.status(204).end();
});

export default router;
