// Tests, marks and report cards. The tenant always comes from the verified token.
import { Router } from "express";
import * as controller from "./exams.controller.js";
import {
  classReportQuery,
  createExamSchema,
  gradingSchema,
  idParamSchema,
  listExamsQuery,
  saveMarksSchema,
  studentReportQuery,
  updateExamSchema,
} from "./exams.validation.js";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";

const router = Router();

// Academic staff only: owners, admins and teachers (accountants don't handle marks)
router.use(authenticate, authorize(ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER));
const adminOnly = authorize(ROLES.OWNER, ROLES.ADMIN);

for (const name of ["examId", "studentId"]) {
  router.param(name, (req, res, next, value) => {
    if (!idParamSchema.safeParse(value).success) throw AppError.badRequest(`Invalid ${name}`, "INVALID_ID");
    next();
  });
}

router.get("/settings", controller.getSettings);
router.put("/settings", adminOnly, validateBody(gradingSchema), controller.updateSettings);

router.get("/reports/class", validateQuery(classReportQuery), controller.classReport);
router.get("/reports/students/:studentId", validateQuery(studentReportQuery), controller.studentReport);

router.get("/", validateQuery(listExamsQuery), controller.list);
router.post("/", validateBody(createExamSchema), controller.create);
router.get("/:examId", controller.get);
router.patch("/:examId", validateBody(updateExamSchema), controller.update);
// Deleting a test removes everyone's marks: owners and admins only
router.delete("/:examId", adminOnly, controller.remove);
router.put("/:examId/marks", validateBody(saveMarksSchema), controller.saveMarks);

export default router;
