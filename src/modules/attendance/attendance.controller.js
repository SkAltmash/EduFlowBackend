import * as attendanceService from "./attendance.service.js";

export const classes = async (req, res) =>
  res.json(await attendanceService.listClasses(req.user.tenantId, req.validatedQuery));

export const register = async (req, res) =>
  res.json(await attendanceService.getRegister(req.user.tenantId, req.user.role, req.validatedQuery));

export const saveRegister = async (req, res) =>
  res.json(await attendanceService.saveRegister(req.user.tenantId, req.user, req.body));

export const report = async (req, res) =>
  res.json(await attendanceService.classReport(req.user.tenantId, req.validatedQuery));

export const studentHistory = async (req, res) =>
  res.json(await attendanceService.studentHistory(req.user.tenantId, req.params.studentId, req.validatedQuery));
