import * as service from "./exams.service.js";

const tid = (req) => req.user.tenantId;

export const getSettings = async (req, res) => res.json(await service.getSettings(tid(req)));
export const updateSettings = async (req, res) => res.json(await service.updateSettings(tid(req), req.user.id, req.body));

export const list = async (req, res) => res.json(await service.listExams(tid(req), req.validatedQuery, req.user));
export const create = async (req, res) => res.status(201).json(await service.createExam(tid(req), req.user, req.body));
export const get = async (req, res) => res.json(await service.getExam(tid(req), req.params.examId, req.user));
export const update = async (req, res) => res.json(await service.updateExam(tid(req), req.params.examId, req.body, req.user));
export const remove = async (req, res) => {
  await service.deleteExam(tid(req), req.params.examId);
  res.status(204).end();
};
export const saveMarks = async (req, res) => res.json(await service.saveMarks(tid(req), req.user, req.params.examId, req.body));

export const studentReport = async (req, res) =>
  res.json(await service.studentMonthlyReport(tid(req), req.params.studentId, req.validatedQuery));
export const classReport = async (req, res) => res.json(await service.classMonthlyReport(tid(req), req.validatedQuery));
