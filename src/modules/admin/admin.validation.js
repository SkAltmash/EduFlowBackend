import { z } from "zod";
import { ROLES } from "../../models/Membership.js";
import { email, objectId, strongPassword } from "../auth/auth.validation.js";

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

const status = z.enum(["active", "inactive", "all"]).default("all");

export const idParamSchema = objectId;

export const listTenantsQuery = z.object({
  ...pagination,
  status,
  search: z.string().trim().max(100).optional(),
});

export const listUsersQuery = z.object({
  ...pagination,
  status,
  search: z.string().trim().max(100).optional(),
});

export const listAuditLogsQuery = z.object({
  ...pagination,
  action: z.string().trim().max(100).optional(),
  actorId: objectId.optional(),
  targetId: objectId.optional(),
});

export const updateTenantSchema = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const resetPasswordSchema = z.object({ password: strongPassword });

export const addMemberSchema = z.object({
  email,
  role: z.enum(Object.values(ROLES)),
});

export const updateMemberSchema = z.object({
  role: z.enum(Object.values(ROLES)),
});
