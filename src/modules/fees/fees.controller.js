import * as feesService from "./fees.service.js";

const tid = (req) => req.user.tenantId;

export const listPlans = async (req, res) => res.json(await feesService.listPlans(tid(req), req.validatedQuery));
export const getPlan = async (req, res) => res.json(await feesService.getPlan(tid(req), req.params.planId));
export const createPlan = async (req, res) => res.status(201).json(await feesService.createPlan(tid(req), req.user.id, req.body));
export const updatePlan = async (req, res) => res.json(await feesService.updatePlan(tid(req), req.params.planId, req.body));
export const deletePlan = async (req, res) => {
  await feesService.deletePlan(tid(req), req.params.planId);
  res.status(204).end();
};
export const assignPlan = async (req, res) => res.json(await feesService.assignPlan(tid(req), req.params.planId, req.body));

export const register = async (req, res) => res.json(await feesService.feeRegister(tid(req), req.validatedQuery));
export const ledger = async (req, res) =>
  res.json(await feesService.studentLedger(tid(req), req.params.studentId, req.validatedQuery));
export const updateInvoice = async (req, res) => res.json(await feesService.updateInvoice(tid(req), req.params.invoiceId, req.body));
export const deleteInvoice = async (req, res) => {
  await feesService.deleteInvoice(tid(req), req.params.invoiceId);
  res.status(204).end();
};

export const listPayments = async (req, res) => res.json(await feesService.listPayments(tid(req), req.validatedQuery));
export const exportPayments = async (req, res) => res.json(await feesService.exportPayments(tid(req), req.validatedQuery));
export const createPayment = async (req, res) => res.status(201).json(await feesService.createPayment(tid(req), req.user, req.body));
export const getReceipt = async (req, res) => res.json(await feesService.getReceipt(tid(req), req.params.paymentId));
export const voidPayment = async (req, res) =>
  res.json(await feesService.voidPayment(tid(req), req.user, req.params.paymentId, req.body));

export const summary = async (req, res) => res.json(await feesService.summary(tid(req), req.validatedQuery));
