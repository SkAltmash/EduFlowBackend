import * as schoolService from "./school.service.js";

const ctx = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

export const get = async (req, res) => res.json(await schoolService.getSchool(req.user.tenantId));
export const update = async (req, res) => res.json(await schoolService.updateSchool(req.user, req.body));

export const listMembers = async (req, res) => res.json(await schoolService.listMembers(req.user.tenantId));
export const addMember = async (req, res) => res.status(201).json(await schoolService.addMember(req.user, ctx(req), req.body));
export const updateMember = async (req, res) => res.json(await schoolService.updateMember(req.user, ctx(req), req.params.userId, req.body));
export const removeMember = async (req, res) => res.json(await schoolService.removeMember(req.user, ctx(req), req.params.userId));

export const logoSignature = async (req, res) => res.json(await schoolService.logoUploadSignature(req.user.tenantId));
export const saveLogo = async (req, res) => res.json(await schoolService.saveLogo(req.user, ctx(req), req.body));
export const removeLogo = async (req, res) => res.json(await schoolService.removeLogo(req.user, ctx(req)));
export const updateReceipt = async (req, res) => res.json(await schoolService.updateReceipt(req.user, ctx(req), req.body));
export const updateReportCard = async (req, res) => res.json(await schoolService.updateReportCard(req.user, ctx(req), req.body));
