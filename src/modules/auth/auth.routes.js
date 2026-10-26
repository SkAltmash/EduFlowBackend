import { Router } from "express";
import * as controller from "./auth.controller.js";
import { changePasswordSchema, loginSchema, registerSchema, selectTenantSchema, updateMeSchema } from "./auth.validation.js";
import { validateBody } from "../../middleware/validate.js";
import { authenticate, authenticateForTenantSelection } from "../../middleware/authenticate.js";
import { loginLimiter, refreshLimiter, registerLimiter } from "../../middleware/rateLimit.js";

const router = Router();

router.post("/register", registerLimiter, validateBody(registerSchema), controller.register);
router.post("/login", loginLimiter, validateBody(loginSchema), controller.login);
router.post(
  "/select-tenant",
  loginLimiter,
  authenticateForTenantSelection,
  validateBody(selectTenantSchema),
  controller.selectTenant
);
router.post("/refresh", refreshLimiter, controller.refresh);
router.post("/logout", controller.logout);
router.get("/me", authenticate, controller.me);
router.patch("/me", authenticate, validateBody(updateMeSchema), controller.updateMe);
// Same limit as login: the current password is checked here
router.post("/change-password", loginLimiter, authenticate, validateBody(changePasswordSchema), controller.changePassword);

export default router;
