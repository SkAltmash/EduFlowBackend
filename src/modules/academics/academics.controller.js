import * as academics from "./academics.service.js";

const tid = (req) => req.user.tenantId;

export const listClasses = async (req, res) => res.json(await academics.listClasses(tid(req)));
export const createClass = async (req, res) => res.status(201).json(await academics.createClass(tid(req), req.body));
export const bulkCreate = async (req, res) => res.status(201).json(await academics.bulkCreateClasses(tid(req), req.body));
export const updateClass = async (req, res) => res.json(await academics.updateClass(tid(req), req.params.classId, req.body));
export const reorder = async (req, res) => res.json(await academics.reorderClasses(tid(req), req.body));
export const deleteClass = async (req, res) => res.json(await academics.deleteClass(tid(req), req.params.classId));
export const setupFromStudents = async (req, res) => res.json(await academics.setupFromStudents(tid(req)));
export const merge = async (req, res) => res.json(await academics.mergeClass(tid(req), req.body));

export const listYears = async (req, res) => res.json(await academics.listYears(tid(req)));
export const createYear = async (req, res) => res.status(201).json(await academics.createYear(tid(req), req.body));
export const updateYear = async (req, res) => res.json(await academics.updateYear(tid(req), req.params.yearId, req.body));
export const deleteYear = async (req, res) => res.json(await academics.deleteYear(tid(req), req.params.yearId));

export const promotionPreview = async (req, res) => res.json(await academics.promotionPreview(tid(req)));
export const listPromotions = async (req, res) => res.json(await academics.listPromotions(tid(req)));
export const promote = async (req, res) => res.status(201).json(await academics.promote(req.user, req.body));
export const undoPromotion = async (req, res) => res.json(await academics.undoPromotion(req.user, req.params.promotionId));
