// Requests to fix student details: GET/POST /api/corrections, PATCH /api/corrections/:requestId
import { Router } from "express";
import { z } from "zod";
import CorrectionRequest from "../../models/CorrectionRequest.js";
import Student from "../../models/Student.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import { adminOnly, fullName, idParam, isAdmin, nameOf, objectId, teachingStaff } from "./classroom.common.js";

const router = Router();
router.use(authenticate, teachingStaff);
idParam(router, "requestId");

/** Admins see every request; teachers see the ones they made. */
router.get("/", validateQuery(z.object({ status: z.enum(["open", "resolved", "all"]).default("open"), studentId: objectId.optional() })), async (req, res) => {
  const { status, studentId } = req.validatedQuery;
  const filter = { tenantId: req.user.tenantId, ...(status !== "all" ? { status } : {}), ...(studentId ? { studentId } : {}), ...(isAdmin(req.user) ? {} : { createdBy: req.user.id }) };
  const list = await CorrectionRequest.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const students = await Student.find({ _id: { $in: list.map((r) => r.studentId) }, tenantId: req.user.tenantId }, { firstName: 1, lastName: 1, admissionNo: 1, grade: 1, section: 1 }).lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));
  res.json({
    requests: list.map((r) => {
      const s = byId.get(String(r.studentId));
      return {
        id: String(r._id),
        studentId: String(r.studentId),
        studentName: s ? fullName(s) : "(removed student)",
        admissionNo: s?.admissionNo ?? "",
        grade: s?.grade ?? "",
        section: s?.section ?? "",
        message: r.message,
        status: r.status,
        createdByName: r.createdByName || "",
        createdAt: r.createdAt,
        resolvedByName: r.resolvedByName ?? null,
        resolvedAt: r.resolvedAt ?? null,
      };
    }),
    open: await CorrectionRequest.countDocuments({ tenantId: req.user.tenantId, status: "open", ...(isAdmin(req.user) ? {} : { createdBy: req.user.id }) }),
  });
});

router.post("/", validateBody(z.object({ studentId: objectId, message: z.string().trim().min(3, "Say what needs fixing").max(500) })), async (req, res) => {
  if (!(await Student.exists({ _id: req.body.studentId, tenantId: req.user.tenantId }))) throw AppError.notFound("Student not found");
  const r = await CorrectionRequest.create({ ...req.body, tenantId: req.user.tenantId, createdBy: req.user.id, createdByName: await nameOf(req.user.id) });
  res.status(201).json({ id: String(r._id) });
});

router.patch("/:requestId", adminOnly, validateBody(z.object({ status: z.enum(["open", "resolved"]) })), async (req, res) => {
  const r = await CorrectionRequest.findOne({ _id: req.params.requestId, tenantId: req.user.tenantId });
  if (!r) throw AppError.notFound("Request not found");
  r.status = req.body.status;
  if (req.body.status === "resolved") Object.assign(r, { resolvedBy: req.user.id, resolvedByName: await nameOf(req.user.id), resolvedAt: new Date() });
  await r.save();
  res.json({ ok: true });
});

export default router;
