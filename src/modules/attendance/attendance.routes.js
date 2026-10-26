// Daily attendance per class. The tenant always comes from the verified token (req.user.tenantId).
import { Router } from "express";
import * as controller from "./attendance.controller.js";
import {
  classesQuery,
  idParamSchema,
  registerQuery,
  reportQuery,
  saveRegisterSchema,
  studentHistoryQuery,
} from "./attendance.validation.js";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";

const router = Router();

router.use(authenticate);

router.param("studentId", (req, res, next, value) => {
  if (!idParamSchema.safeParse(value).success) throw AppError.badRequest("Invalid studentId", "INVALID_ID");
  next();
});

// The class list is open to every member (accountants pick classes when assigning fees,
// and get it without attendance numbers). Everything else is for teaching staff only.
router.get("/classes", validateQuery(classesQuery), controller.classes);

const teachingStaff = authorize(ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER);
router.get("/register", teachingStaff, validateQuery(registerQuery), controller.register);
// Date rules (teachers: last 7 days) live in the service
router.put("/register", teachingStaff, validateBody(saveRegisterSchema), controller.saveRegister);
router.get("/report", teachingStaff, validateQuery(reportQuery), controller.report);
router.get("/students/:studentId", teachingStaff, validateQuery(studentHistoryQuery), controller.studentHistory);

export default router;
