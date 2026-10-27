// Fee plans, dues, payments and receipts for the current tenant.
// The tenant always comes from the verified token (req.user.tenantId).
import { Router } from "express";
import * as controller from "./fees.controller.js";
import {
  assignPlanSchema,
  createPaymentSchema,
  createPlanSchema,
  exportPaymentsQuery,
  idParamSchema,
  listPaymentsQuery,
  listPlansQuery,
  registerQuery,
  studentLedgerQuery,
  summaryQuery,
  updateInvoiceSchema,
  updatePlanSchema,
  voidPaymentSchema,
} from "./fees.validation.js";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import { mountConcessionRoutes } from "./fees.concessions.js";
import * as feesService from "./fees.service.js";

const router = Router();

// Fees are visible to owners, admins and accountants only (not teachers)
router.use(authenticate, authorize(ROLES.OWNER, ROLES.ADMIN, ROLES.ACCOUNTANT));
// Voiding a payment is reserved for owners and admins
const canVoid = authorize(ROLES.OWNER, ROLES.ADMIN);

for (const name of ["planId", "studentId", "invoiceId", "paymentId"]) {
  router.param(name, (req, res, next, value) => {
    if (!idParamSchema.safeParse(value).success) throw AppError.badRequest(`Invalid ${name}`, "INVALID_ID");
    next();
  });
}

router.get("/summary", validateQuery(summaryQuery), controller.summary);
mountConcessionRoutes(router);
router.delete("/students/:studentId/plans/:planId", async (req, res) =>
  res.json(await feesService.removePlanFromStudent(req.user.tenantId, req.params.studentId, req.params.planId))
);

router.get("/plans", validateQuery(listPlansQuery), controller.listPlans);
router.post("/plans", validateBody(createPlanSchema), controller.createPlan);
router.get("/plans/:planId", controller.getPlan);
router.patch("/plans/:planId", validateBody(updatePlanSchema), controller.updatePlan);
router.delete("/plans/:planId", controller.deletePlan);
router.post("/plans/:planId/assign", validateBody(assignPlanSchema), controller.assignPlan);

router.get("/register", validateQuery(registerQuery), controller.register);
router.get("/students/:studentId", validateQuery(studentLedgerQuery), controller.ledger);
router.patch("/dues/:invoiceId", validateBody(updateInvoiceSchema), controller.updateInvoice);
router.delete("/dues/:invoiceId", controller.deleteInvoice);

router.get("/payments", validateQuery(listPaymentsQuery), controller.listPayments);
router.get("/payments/export", validateQuery(exportPaymentsQuery), controller.exportPayments);
router.post("/payments", validateBody(createPaymentSchema), controller.createPayment);
router.get("/payments/:paymentId", controller.getReceipt);
router.post("/payments/:paymentId/void", canVoid, validateBody(voidPaymentSchema), controller.voidPayment);

export default router;
