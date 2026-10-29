// Students of the current tenant. The tenant always comes from the verified token (req.user.tenantId).
import { Router } from "express";
import * as controller from "./students.controller.js";
import {
  createStudentWithFeesSchema,
  exportStudentsQuery,
  idParamSchema,
  importStudentsSchema,
  listStudentsQuery,
  updateStudentSchema,
} from "./students.validation.js";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";

const router = Router();

// Every member can view students; only owners and admins can change them
const canManage = authorize(ROLES.OWNER, ROLES.ADMIN);

router.use(authenticate);

router.param("studentId", (req, res, next, value) => {
  if (!idParamSchema.safeParse(value).success) throw AppError.badRequest("Invalid studentId", "INVALID_ID");
  next();
});

router.get("/", validateQuery(listStudentsQuery), controller.list);
router.get("/filters", controller.filters);
// Bulk download of personal data: owners and admins only
router.get("/export", canManage, validateQuery(exportStudentsQuery), controller.exportAll);
// CSV rows arrive as JSON; app.js gives this path a larger body limit
router.post("/import", canManage, validateBody(importStudentsSchema), controller.importCsv);
router.post("/", canManage, validateBody(createStudentWithFeesSchema), controller.create);
router.get("/:studentId", controller.get);
router.patch("/:studentId", canManage, validateBody(updateStudentSchema), controller.update);
router.delete("/:studentId", canManage, controller.remove);

export default router;
