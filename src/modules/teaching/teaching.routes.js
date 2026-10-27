// Teaching assignments: class teachers and subject teachers.
import { Router } from "express";
import * as controller from "./teaching.controller.js";
import { idParamSchema, replaceSchema } from "./teaching.validation.js";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";

const router = Router();
const manage = authorize(ROLES.OWNER, ROLES.ADMIN);

router.use(authenticate);
router.param("userId", (req, res, next, value) => {
  if (!idParamSchema.safeParse(value).success) throw AppError.badRequest("Invalid userId", "INVALID_ID");
  next();
});

router.get("/me", controller.mine);
// Every member can see who teaches which class (shown on class and student pages)
router.get("/assignments", controller.listAll);
router.put("/assignments/:userId", manage, validateBody(replaceSchema), controller.replace);

export default router;
