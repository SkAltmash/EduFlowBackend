import * as attendanceService from "./attendance.service.js";
import { ROLES } from "../../models/Membership.js";
import { canTeachClass, teacherScope } from "../teaching/teaching.scope.js";

export const classes = async (req, res) => {
  const [result, scope] = await Promise.all([attendanceService.listClasses(req.user.tenantId, req.validatedQuery), teacherScope(req.user)]);
  // `mine`: classes this teacher is assigned to (every class when not limited)
  if (req.user.role !== ROLES.ACCOUNTANT) {
    return res.json({ ...result, limited: scope.limited, classes: result.classes.map((c) => ({ ...c, mine: canTeachClass(scope, c.grade, c.section) })) });
  }
  // Accountants don't see attendance: just the classes and their sizes
  res.json({ ...result, classes: result.classes.map(({ grade, section, students }) => ({ grade, section, students })) });
};

export const register = async (req, res) => {
  const [result, scope] = await Promise.all([attendanceService.getRegister(req.user.tenantId, req.user.role, req.validatedQuery), teacherScope(req.user)]);
  if (result.canEdit && !canTeachClass(scope, result.grade, result.section)) {
    return res.json({ ...result, canEdit: false, reason: "You aren't assigned to this class. You can view it, but only its teachers can mark it." });
  }
  res.json(result);
};

export const saveRegister = async (req, res) =>
  res.json(await attendanceService.saveRegister(req.user.tenantId, req.user, req.body));

export const report = async (req, res) =>
  res.json(await attendanceService.classReport(req.user.tenantId, req.validatedQuery));

export const studentHistory = async (req, res) =>
  res.json(await attendanceService.studentHistory(req.user.tenantId, req.params.studentId, req.validatedQuery));
