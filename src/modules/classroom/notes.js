// Staff notes and behaviour log per student: GET/POST /api/notes, DELETE /api/notes/:noteId
import { Router } from "express";
import { z } from "zod";
import Student from "../../models/Student.js";
import StudentNote, { NOTE_KINDS } from "../../models/StudentNote.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import { idParam, isAdmin, nameOf, objectId, teachingStaff } from "./classroom.common.js";

const createSchema = z.object({ studentId: objectId, kind: z.enum(NOTE_KINDS).default("note"), text: z.string().trim().min(2, "Write the note").max(1000) });
const serialize = (n) => ({ id: String(n._id), studentId: String(n.studentId), kind: n.kind, text: n.text, createdBy: String(n.createdBy), createdByName: n.createdByName || "", createdAt: n.createdAt });

const router = Router();
router.use(authenticate, teachingStaff);
idParam(router, "noteId");

router.get("/", validateQuery(z.object({ studentId: objectId })), async (req, res) => {
  const notes = await StudentNote.find({ tenantId: req.user.tenantId, studentId: req.validatedQuery.studentId }).sort({ createdAt: -1 }).limit(100).lean();
  const counts = Object.fromEntries(NOTE_KINDS.map((k) => [k, notes.filter((n) => n.kind === k).length]));
  res.json({ notes: notes.map(serialize), counts });
});

router.post("/", validateBody(createSchema), async (req, res) => {
  if (!(await Student.exists({ _id: req.body.studentId, tenantId: req.user.tenantId }))) throw AppError.notFound("Student not found");
  const note = await StudentNote.create({ ...req.body, tenantId: req.user.tenantId, createdBy: req.user.id, createdByName: await nameOf(req.user.id) });
  res.status(201).json({ note: serialize(note) });
});

router.delete("/:noteId", async (req, res) => {
  const note = await StudentNote.findOne({ _id: req.params.noteId, tenantId: req.user.tenantId });
  if (!note) throw AppError.notFound("Note not found");
  if (!isAdmin(req.user) && String(note.createdBy) !== String(req.user.id)) throw AppError.forbidden("Only its author or an admin can delete this note", "NOT_AUTHOR");
  await note.deleteOne();
  res.status(204).end();
});

export default router;
