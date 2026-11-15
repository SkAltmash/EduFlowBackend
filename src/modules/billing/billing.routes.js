// /api/billing: Plan & billing for owners and admins (Razorpay checkout), the Razorpay webhook,
// and /api/public/plans for the website's pricing section.
import { Router } from "express";
import { z } from "zod";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody } from "../../middleware/validate.js";
import * as billing from "./billing.service.js";

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");

export const billingRouter = Router();
billingRouter.use(authenticate, authorize(ROLES.OWNER, ROLES.ADMIN));
billingRouter.get("/", async (req, res) => res.json(await billing.overview(req.user)));
billingRouter.post("/checkout", validateBody(z.object({ planId: objectId, cycle: z.enum(["monthly", "yearly"]) })), async (req, res) => res.json(await billing.checkout(req.user, req.body)));
billingRouter.post(
  "/confirm",
  validateBody(z.object({ orderId: z.string().trim().min(1).max(60), paymentId: z.string().trim().min(1).max(60), signature: z.string().trim().min(1).max(200) })),
  async (req, res) => res.json(await billing.confirm(req.user, req.body))
);

/** Razorpay → EduFlow (the body arrives raw, for the signature check). */
export const billingWebhookRouter = Router();
billingWebhookRouter.post("/", async (req, res) => res.json(await billing.webhook(req.body, req.get("x-razorpay-signature"))));

/** The plans on offer, for the public website. */
export const publicRouter = Router();
publicRouter.get("/plans", async (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({ plans: await billing.offeredPlans() });
});
