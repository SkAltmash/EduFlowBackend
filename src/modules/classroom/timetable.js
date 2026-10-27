// Weekly timetable: GET /api/timetable?grade=&section= (a class) or ?mine=1 (my periods),
// PUT /api/timetable (replace one class's week; owners/admins)
import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import Membership from "../../models/Membership.js";
import TimetableSlot from "../../models/TimetableSlot.js";
import User from "../../models/User.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import { loadClassList } from "../academics/class-names.js";
import { adminOnly, canonical, classFields, objectId } from "./classroom.common.js";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const slot = z
  .object({ day: z.number().int().min(1).max(7), start: time, end: time, subject: z.string().trim().min(1, "Subject is required").max(60), teacherId: objectId.nullish() })
  .refine((s) => s.start < s.end, { message: "A period must end after it starts", path: ["end"] });
const putSchema = z.object({ ...classFields, slots: z.array(slot).max(120) });
const getQuery = z.object({ grade: z.string().trim().max(50).optional(), section: z.string().trim().max(20).optional(), mine: z.enum(["1", "0"]).optional() });

async function serialize(tenantId, slots) {
  const users = await User.find({ _id: { $in: [...new Set(slots.filter((s) => s.teacherId).map((s) => String(s.teacherId)))] } }, { name: 1 }).lean();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  const classList = await loadClassList(tenantId);
  return slots
    .map((s) => ({ id: String(s._id), grade: s.grade, section: s.section || "", day: s.day, start: s.start, end: s.end, subject: s.subject, teacherId: s.teacherId ? String(s.teacherId) : null, teacherName: s.teacherId ? (names.get(String(s.teacherId)) ?? "") : "" }))
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start) || classList.compareGrades(a.grade, b.grade));
}

/** One teacher's periods on a weekday (1 = Monday), for "My day". */
export async function periodsFor(tenantId, userId, day) {
  return serialize(tenantId, await TimetableSlot.find({ tenantId, teacherId: userId, day }).lean());
}

const router = Router();
router.use(authenticate);

router.get("/", validateQuery(getQuery), async (req, res) => {
  const { grade, section, mine } = req.validatedQuery;
  const tenantId = req.user.tenantId;
  if (mine === "1") return res.json({ slots: await serialize(tenantId, await TimetableSlot.find({ tenantId, teacherId: req.user.id }).lean()) });
  if (!grade) throw AppError.badRequest("Choose a class", "INVALID_CLASS");
  const cls = await canonical(tenantId, grade, section);
  // A section's week also shows periods set for the whole class
  const slots = await TimetableSlot.find({ tenantId, grade: cls.grade, section: { $in: [...new Set(["", cls.section])] } }).lean();
  res.json({ slots: await serialize(tenantId, slots) });
});

router.put("/", adminOnly, validateBody(putSchema), async (req, res) => {
  const tenantId = req.user.tenantId;
  const cls = await canonical(tenantId, req.body.grade, req.body.section);
  const teacherIds = [...new Set(req.body.slots.map((s) => s.teacherId).filter(Boolean))];
  if (teacherIds.length) {
    const members = await Membership.countDocuments({ tenantId, userId: { $in: teacherIds } });
    if (members !== teacherIds.length) throw AppError.badRequest("A chosen teacher isn't on your team", "INVALID_TEACHER");
  }
  // Overlapping periods in the same class and day
  const byDay = new Map();
  for (const s of req.body.slots) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  for (const list of byDay.values()) {
    const sorted = list.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) throw AppError.badRequest(`Periods overlap at ${sorted[i].start}`, "OVERLAP");
    }
  }
  await mongoose.connection.transaction(async (session) => {
    await TimetableSlot.deleteMany({ tenantId, ...cls }, { session });
    if (req.body.slots.length) await TimetableSlot.insertMany(req.body.slots.map((s) => ({ ...s, teacherId: s.teacherId || undefined, ...cls, tenantId })), { session });
  });
  res.json({ slots: await serialize(tenantId, await TimetableSlot.find({ tenantId, ...cls }).lean()) });
});

export default router;
