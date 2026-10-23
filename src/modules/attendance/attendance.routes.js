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

// Every member can view; owners, admins and teachers can mark (date rules live in the service)
router.get("/classes", validateQuery(classesQuery), controller.classes);
router.get("/register", validateQuery(registerQuery), controller.register);
router.put(
  "/register",
  authorize(ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER),
  validateBody(saveRegisterSchema),
  controller.saveRegister
);
router.get("/report", validateQuery(reportQuery), controller.report);
router.get("/students/:studentId", validateQuery(studentHistoryQuery), controller.studentHistory);

export default router;
