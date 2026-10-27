// Student performance leaderboards from test marks and attendance.
// Teaching staff only: it combines tests and attendance, which accountants don't see.
import { requireFeature } from "../platform/subscription.js";
import { Router } from "express";
import * as controller from "./performance.controller.js";
import { performanceQuery } from "./performance.validation.js";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateQuery } from "../../middleware/validate.js";

const router = Router();

router.use(authenticate, authorize(ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER), requireFeature("performance"));
router.get("/", validateQuery(performanceQuery), controller.leaderboard);

export default router;
