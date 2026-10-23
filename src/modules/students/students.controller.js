import * as studentsService from "./students.service.js";

export const list = async (req, res) =>
  res.json(await studentsService.listStudents(req.user.tenantId, req.validatedQuery));

export const exportAll = async (req, res) =>
  res.json(await studentsService.exportStudents(req.user.tenantId, req.validatedQuery));

export const filters = async (req, res) => res.json(await studentsService.getStudentFilters(req.user.tenantId));

export const get = async (req, res) => res.json(await studentsService.getStudent(req.user.tenantId, req.params.studentId));

export const create = async (req, res) =>
  res.status(201).json(await studentsService.createStudent(req.user.tenantId, req.user.id, req.body));

export const update = async (req, res) =>
  res.json(await studentsService.updateStudent(req.user.tenantId, req.user.id, req.params.studentId, req.body));

export const remove = async (req, res) => {
  await studentsService.deleteStudent(req.user.tenantId, req.params.studentId);
  res.status(204).end();
};

export const importCsv = async (req, res) =>
  res.json(await studentsService.importStudents(req.user.tenantId, req.user.id, req.body));
