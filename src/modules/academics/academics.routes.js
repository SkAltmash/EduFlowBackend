// Classes (with sections and subjects), academic years and year-end promotion.
// The tenant always comes from the verified token (req.user.tenantId).
import { Router } from "express";
import * as controller from "./academics.controller.js";
import {
  bulkCreateSchema,
  createClassSchema,
  createYearSchema,
  idParamSchema,
  mergeSchema,
  promoteSchema,
  reorderSchema,
  updateClassSchema,
  updateYearSchema,
} from "./academics.validation.js";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";

const router = Router();
const manage = authorize(ROLES.OWNER, ROLES.ADMIN);

router.use(authenticate);

for (const name of ["classId", "yearId", "promotionId"]) {
  router.param(name, (req, res, next, value) => {
    if (!idParamSchema.safeParse(value).success) throw AppError.badRequest(`Invalid ${name}`, "INVALID_ID");
    next();
  });
}

// Every member reads the class list and years (forms, filters); owners and admins change them
router.get("/classes", controller.listClasses);
router.post("/classes", manage, validateBody(createClassSchema), controller.createClass);
router.post("/classes/bulk", manage, validateBody(bulkCreateSchema), controller.bulkCreate);
router.post("/classes/setup-from-students", manage, controller.setupFromStudents);
router.post("/classes/merge", manage, validateBody(mergeSchema), controller.merge);
router.put("/classes/order", manage, validateBody(reorderSchema), controller.reorder);
router.patch("/classes/:classId", manage, validateBody(updateClassSchema), controller.updateClass);
router.delete("/classes/:classId", manage, controller.deleteClass);

router.get("/years", controller.listYears);
router.post("/years", manage, validateBody(createYearSchema), controller.createYear);
router.patch("/years/:yearId", manage, validateBody(updateYearSchema), controller.updateYear);
router.delete("/years/:yearId", manage, controller.deleteYear);

router.get("/promotions", manage, controller.listPromotions);
router.get("/promotions/preview", manage, controller.promotionPreview);
router.post("/promotions", manage, validateBody(promoteSchema), controller.promote);
router.post("/promotions/:promotionId/undo", manage, controller.undoPromotion);

export default router;
