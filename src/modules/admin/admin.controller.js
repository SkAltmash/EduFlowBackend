import * as adminService from "./admin.service.js";

function ctx(req) {
  return { adminId: req.admin.id, ip: req.ip, userAgent: req.get("user-agent") };
}

export const me = (req, res) => res.json({ admin: req.admin, isSuperAdmin: true });
export const stats = async (req, res) => res.json(await adminService.getStats());
export const auditLogs = async (req, res) => res.json(await adminService.listAuditLogs(req.validatedQuery));

export const listTenants = async (req, res) => res.json(await adminService.listTenants(req.validatedQuery));
export const getTenant = async (req, res) => res.json(await adminService.getTenant(req.params.tenantId));
export const updateTenant = async (req, res) =>
  res.json(await adminService.updateTenant(ctx(req), req.params.tenantId, req.body));
export const enterTenant = async (req, res) =>
  res.json(await adminService.enterTenant(ctx(req), req.params.tenantId));

export const listMembers = async (req, res) =>
  res.json(await adminService.listTenantMembers(req.params.tenantId));
export const addMember = async (req, res) =>
  res.status(201).json(await adminService.addMember(ctx(req), req.params.tenantId, req.body));
export const updateMember = async (req, res) =>
  res.json(await adminService.updateMember(ctx(req), req.params.tenantId, req.params.userId, req.body));
export const removeMember = async (req, res) =>
  res.json(await adminService.removeMember(ctx(req), req.params.tenantId, req.params.userId));

export const listUsers = async (req, res) => res.json(await adminService.listUsers(req.validatedQuery));
export const getUser = async (req, res) => res.json(await adminService.getUser(req.params.userId));
export const updateUser = async (req, res) =>
  res.json(await adminService.updateUser(ctx(req), req.params.userId, req.body));
export const resetPassword = async (req, res) => {
  await adminService.resetUserPassword(ctx(req), req.params.userId, req.body);
  res.status(204).end();
};
