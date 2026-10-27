// WhatsApp messaging to parents. The tenant always comes from the verified token.
import { Router } from "express";
import * as controller from "./whatsapp.controller.js";
import { historyQuery, logOpenedSchema, prepareSchema, sendSchema, settingsSchema, testSchema } from "./whatsapp.validation.js";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";

const router = Router();

// Public: Meta calls these (no login); the POST is protected by the request signature
router.get("/webhook", controller.verifyWebhook);
router.post("/webhook", controller.receiveWebhook);

router.use(authenticate);

const adminOnly = authorize(ROLES.OWNER, ROLES.ADMIN);

// Fee messages are for fee staff, attendance messages for teaching staff
const ROLES_BY_TYPE = {
  fee_receipt: [ROLES.OWNER, ROLES.ADMIN, ROLES.ACCOUNTANT],
  fee_reminder: [ROLES.OWNER, ROLES.ADMIN, ROLES.ACCOUNTANT],
  absence: [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER],
  attendance_summary: [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER],
  exam_result: [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER],
  progress_report: [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER],
  performance_report: [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER],
  homework: [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER],
  notice: [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER],
};
function canSendType(req, res, next) {
  if (!ROLES_BY_TYPE[req.body.type]?.includes(req.user.role)) throw AppError.forbidden();
  next();
}

router.get("/settings", adminOnly, controller.getSettings);
router.put("/settings", adminOnly, validateBody(settingsSchema), controller.updateSettings);
router.post("/settings/test", adminOnly, validateBody(testSchema), controller.test);
router.get("/messages", adminOnly, validateQuery(historyQuery), controller.history);

router.post("/prepare", validateBody(prepareSchema), canSendType, controller.prepare);
router.post("/send", validateBody(sendSchema), canSendType, controller.send);
router.post("/log", validateBody(logOpenedSchema), canSendType, controller.logOpened);

export default router;
