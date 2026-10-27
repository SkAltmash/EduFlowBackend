import * as teaching from "./teaching.service.js";

export const mine = async (req, res) => res.json(await teaching.mine(req.user));
export const listAll = async (req, res) => res.json(await teaching.listAll(req.user.tenantId));
export const replace = async (req, res) => res.json(await teaching.replace(req.user.tenantId, req.params.userId, req.body));
