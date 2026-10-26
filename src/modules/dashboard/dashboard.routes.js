// Home-screen summary for the current tenant. Every member can open it; the service
// leaves out sections the member's role can't see.
import { Router } from "express";
import * as controller from "./dashboard.controller.js";
import { dashboardQuery } from "./dashboard.validation.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../../middleware/validate.js";

const router = Router();

router.use(authenticate);
router.get("/", validateQuery(dashboardQuery), controller.overview);

export default router;
