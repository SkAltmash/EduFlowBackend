import { Router } from "express";
import * as controller from "./admin.controller.js";
import {
  addMemberSchema,
  idParamSchema,
  listAuditLogsQuery,
  listTenantsQuery,
  listUsersQuery,
  resetPasswordSchema,
  updateMemberSchema,
  updateTenantSchema,
  updateUserSchema,
} from "./admin.validation.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import { requireSuperAdmin } from "../../middleware/requireSuperAdmin.js";
import { adminIpAllowlist } from "../../middleware/ipAllowlist.js";
import { adminLimiter } from "../../middleware/rateLimit.js";
import AppError from "../../utils/AppError.js";
import { adminPlatformRouter } from "../platform/platform.routes.js";

const router = Router();

// Every /api/admin route: IP allowlist -> rate limit -> super admin token
router.use(adminIpAllowlist, adminLimiter, requireSuperAdmin);

for (const name of ["tenantId", "userId"]) {
  router.param(name, (req, res, next, value) => {
    if (!idParamSchema.safeParse(value).success) throw AppError.badRequest(`Invalid ${name}`, "INVALID_ID");
    next();
  });
}

router.get("/me", controller.me);
router.get("/stats", controller.stats);
router.get("/audit-logs", validateQuery(listAuditLogsQuery), controller.auditLogs);

router.get("/tenants", validateQuery(listTenantsQuery), controller.listTenants);
router.get("/tenants/:tenantId", controller.getTenant);
router.patch("/tenants/:tenantId", validateBody(updateTenantSchema), controller.updateTenant);
router.post("/tenants/:tenantId/enter", controller.enterTenant);

router.get("/tenants/:tenantId/members", controller.listMembers);
router.post("/tenants/:tenantId/members", validateBody(addMemberSchema), controller.addMember);
router.patch("/tenants/:tenantId/members/:userId", validateBody(updateMemberSchema), controller.updateMember);
router.delete("/tenants/:tenantId/members/:userId", controller.removeMember);

router.get("/users", validateQuery(listUsersQuery), controller.listUsers);
router.get("/users/:userId", controller.getUser);
router.patch("/users/:userId", validateBody(updateUserSchema), controller.updateUser);
router.post("/users/:userId/reset-password", validateBody(resetPasswordSchema), controller.resetPassword);

// Console: dashboard, schools, plans, announcements, search, system, two-step login
router.use(adminPlatformRouter);

export default router;
