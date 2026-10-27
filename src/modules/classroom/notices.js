// Notices: GET/POST /api/notices, POST /api/notices/read-all, GET/DELETE /api/notices/:noticeId,
// POST /api/notices/:noticeId/read. Every member reads staff notices; teaching staff post.
import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import Notice from "../../models/Notice.js";
import Student from "../../models/Student.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import { assertTeachesClass, teacherScope } from "../teaching/teaching.scope.js";
import { canonical, fullName, idParam, isAdmin, nameOf, teachingStaff } from "./classroom.common.js";

const createSchema = z.object({
  audience: z.enum(["staff", "parents"]),
  title: z.string().trim().min(2, "Add a title").max(150),
  body: z.string().trim().min(2, "Write the notice").max(3000),
  classes: z.array(z.object({ grade: z.string().trim().min(1).max(50), section: z.string().trim().max(20).default("") })).max(50).default([]),
  pinned: z.boolean().default(false),
});

const serialize = (n, userId) => ({
  id: String(n._id),
  audience: n.audience,
  title: n.title,
  body: n.body,
  classes: n.classes ?? [],
  pinned: n.pinned,
  createdBy: String(n.createdBy),
  createdByName: n.createdByName || "",
  createdAt: n.createdAt,
  read: (n.readBy ?? []).some((id) => String(id) === String(userId)),
});

/** Students whose parents a parent notice goes to. */
function audienceFilter(tenantId, notice) {
  const base = { tenantId, status: "active" };
  if (!notice.classes?.length) return base;
  return { ...base, $or: notice.classes.map((c) => (c.section ? { grade: c.grade, section: c.section } : { grade: c.grade })) };
}

const router = Router();
router.use(authenticate);
idParam(router, "noticeId");

router.get("/", async (req, res) => {
  const list = await Notice.find({ tenantId: req.user.tenantId }).sort({ pinned: -1, createdAt: -1 }).limit(60).lean();
  const uid = new mongoose.Types.ObjectId(String(req.user.id));
  const unread = await Notice.countDocuments({ tenantId: req.user.tenantId, audience: "staff", readBy: { $ne: uid } });
  res.json({ notices: list.map((n) => serialize(n, req.user.id)), unread });
});

router.post("/", teachingStaff, validateBody(createSchema), async (req, res) => {
  const tenantId = req.user.tenantId;
  const classes = [];
  for (const c of req.body.classes) classes.push(await canonical(tenantId, c.grade, c.section));
  if (!isAdmin(req.user)) {
    // Teachers: parent notices for their own classes only; school-wide posts are for admins
    if (req.body.audience === "staff" && req.body.pinned) req.body.pinned = false;
    if (req.body.audience === "parents") {
      if (!classes.length) throw AppError.forbidden("Choose your class. Notices to the whole school are posted by admins.", "NOT_YOUR_CLASS");
      const scope = await teacherScope(req.user);
      for (const c of classes) assertTeachesClass(scope, c.grade, c.section, "send notices to");
    }
  }
  const n = await Notice.create({ ...req.body, classes, tenantId, createdBy: req.user.id, createdByName: await nameOf(req.user.id), readBy: [req.user.id] });
  res.status(201).json({ notice: serialize(n, req.user.id) });
});

router.post("/read-all", async (req, res) => {
  await Notice.updateMany({ tenantId: req.user.tenantId }, { $addToSet: { readBy: req.user.id } });
  res.json({ ok: true });
});

/** A notice with its parent recipients (for sending on WhatsApp). */
router.get("/:noticeId", async (req, res) => {
  const n = await Notice.findOne({ _id: req.params.noticeId, tenantId: req.user.tenantId }).lean();
  if (!n) throw AppError.notFound("Notice not found");
  const students = n.audience === "parents" ? await Student.find(audienceFilter(req.user.tenantId, n), { firstName: 1, lastName: 1, grade: 1, section: 1, guardianPhone: 1 }).limit(2000).lean() : [];
  res.json({ notice: serialize(n, req.user.id), students: students.map((s) => ({ id: String(s._id), fullName: fullName(s), grade: s.grade || "", section: s.section || "", hasPhone: Boolean(s.guardianPhone) })) });
});

router.post("/:noticeId/read", async (req, res) => {
  await Notice.updateOne({ _id: req.params.noticeId, tenantId: req.user.tenantId }, { $addToSet: { readBy: req.user.id } });
  res.json({ ok: true });
});

router.delete("/:noticeId", teachingStaff, async (req, res) => {
  const n = await Notice.findOne({ _id: req.params.noticeId, tenantId: req.user.tenantId });
  if (!n) throw AppError.notFound("Notice not found");
  if (!isAdmin(req.user) && String(n.createdBy) !== String(req.user.id)) throw AppError.forbidden("Only its author or an admin can delete this notice", "NOT_AUTHOR");
  await n.deleteOne();
  res.status(204).end();
});

export default router;
