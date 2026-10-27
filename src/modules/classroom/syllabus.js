// Syllabus progress: GET /api/syllabus?grade=&subject=, POST /api/syllabus (add topics),
// PATCH/DELETE /api/syllabus/:topicId
import { requireFeature } from "../platform/subscription.js";
import { Router } from "express";
import { z } from "zod";
import SyllabusTopic from "../../models/SyllabusTopic.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import { assertTeachesClass, canMarkSubject, markableSubjects, teacherScope } from "../teaching/teaching.scope.js";
import { canonical, day, idParam, nameOf, teachingStaff } from "./classroom.common.js";

const subject = z.string().trim().min(1, "Choose a subject").max(60);
const serialize = (t) => ({ id: String(t._id), title: t.title, order: t.order, completed: (t.completed ?? []).map((c) => ({ section: c.section || "", date: c.date, byName: c.byName || "" })) });

async function assertMayEdit(user, grade, section, subj) {
  const scope = await teacherScope(user);
  assertTeachesClass(scope, grade, section, "update the syllabus of");
  if (!canMarkSubject(markableSubjects(scope, grade, section), subj)) throw AppError.forbidden(`You don't teach ${subj} in this class`, "NOT_YOUR_SUBJECT");
}

const router = Router();
router.use(authenticate, teachingStaff, requireFeature("homework"));
idParam(router, "topicId");

router.get("/", validateQuery(z.object({ grade: z.string().trim().min(1).max(50), subject })), async (req, res) => {
  const { grade } = await canonical(req.user.tenantId, req.validatedQuery.grade, "");
  const topics = await SyllabusTopic.find({ tenantId: req.user.tenantId, grade, subject: req.validatedQuery.subject }).sort({ order: 1, createdAt: 1 }).lean();
  res.json({ topics: topics.map(serialize) });
});

router.post("/", validateBody(z.object({ grade: z.string().trim().min(1).max(50), subject, titles: z.array(z.string().trim().min(1).max(200)).min(1).max(100) })), async (req, res) => {
  const { grade } = await canonical(req.user.tenantId, req.body.grade, "");
  await assertMayEdit(req.user, grade, "", req.body.subject);
  const last = await SyllabusTopic.findOne({ tenantId: req.user.tenantId, grade, subject: req.body.subject }).sort({ order: -1 }).lean();
  let order = last?.order ?? 0;
  await SyllabusTopic.insertMany(req.body.titles.map((title) => ({ tenantId: req.user.tenantId, grade, subject: req.body.subject, title, order: ++order })));
  const topics = await SyllabusTopic.find({ tenantId: req.user.tenantId, grade, subject: req.body.subject }).sort({ order: 1 }).lean();
  res.status(201).json({ topics: topics.map(serialize) });
});

router.patch(
  "/:topicId",
  validateBody(z.object({ title: z.string().trim().min(1).max(200).optional(), done: z.object({ section: z.string().trim().max(20).default(""), value: z.boolean(), date: day.optional() }).optional() })),
  async (req, res) => {
    const t = await SyllabusTopic.findOne({ _id: req.params.topicId, tenantId: req.user.tenantId });
    if (!t) throw AppError.notFound("Topic not found");
    await assertMayEdit(req.user, t.grade, req.body.done?.section ?? "", t.subject);
    if (req.body.title) t.title = req.body.title;
    if (req.body.done) {
      const { section, value, date } = req.body.done;
      t.completed = t.completed.filter((c) => (c.section || "") !== section);
      if (value) t.completed.push({ section, date: date ?? new Date().toISOString().slice(0, 10), by: req.user.id, byName: await nameOf(req.user.id) });
    }
    await t.save();
    res.json({ topic: serialize(t) });
  }
);

router.delete("/:topicId", async (req, res) => {
  const t = await SyllabusTopic.findOne({ _id: req.params.topicId, tenantId: req.user.tenantId });
  if (!t) throw AppError.notFound("Topic not found");
  await assertMayEdit(req.user, t.grade, "", t.subject);
  await t.deleteOne();
  res.status(204).end();
});

export default router;
