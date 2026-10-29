// The school's own profile and its team. The tenant always comes from the verified token.
import { Router } from "express";
import { z } from "zod";
import * as controller from "./school.controller.js";
import { addMemberSchema, idParamSchema, receiptSettingsSchema, reportCardSettingsSchema, updateMemberSchema, updateSchoolSchema } from "./school.validation.js";
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

// Every member can read the profile (it heads receipts and report cards)
router.get("/", controller.get);
router.patch("/", manage, validateBody(updateSchoolSchema), controller.update);
router.put("/receipt", manage, validateBody(receiptSettingsSchema), controller.updateReceipt);
router.put("/report-card", manage, validateBody(reportCardSettingsSchema), controller.updateReportCard);
router.post("/logo/signature", manage, controller.logoSignature);
router.put("/logo", manage, validateBody(z.object({ url: z.string().trim().url().max(500) })), controller.saveLogo);
router.delete("/logo", manage, controller.removeLogo);

router.get("/members", manage, controller.listMembers);
router.post("/members", manage, validateBody(addMemberSchema), controller.addMember);
router.patch("/members/:userId", manage, validateBody(updateMemberSchema), controller.updateMember);
router.delete("/members/:userId", manage, controller.removeMember);

export default router;
