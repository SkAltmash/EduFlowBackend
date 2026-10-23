// Example protected routes showing authenticate + authorize.
// Note the tenant always comes from req.user (the verified token), never from the request.
import { Router } from "express";
import Membership, { ROLES } from "../../models/Membership.js";
import Tenant from "../../models/Tenant.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import AppError from "../../utils/AppError.js";

const router = Router();

// Any member of the current tenant
router.get("/", authenticate, async (req, res) => {
  const tenant = await Tenant.findOne({ _id: req.user.tenantId, isActive: true });
  if (!tenant) throw AppError.notFound("Organization not found");
  res.json({ tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug }, role: req.user.role });
});

// Owners and admins only
router.get("/members", authenticate, authorize(ROLES.OWNER, ROLES.ADMIN), async (req, res) => {
  const memberships = await Membership.find({ tenantId: req.user.tenantId })
    .populate("userId", "name email isActive")
    .sort({ createdAt: 1 })
    .lean();

  res.json({
    members: memberships
      .filter((m) => m.userId)
      .map((m) => ({
        userId: String(m.userId._id),
        name: m.userId.name,
        email: m.userId.email,
        isActive: m.userId.isActive,
        role: m.role,
        joinedAt: m.createdAt,
      })),
  });
});

export default router;
