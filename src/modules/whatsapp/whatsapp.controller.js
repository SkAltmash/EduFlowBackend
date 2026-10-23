import * as service from "./whatsapp.service.js";
import AppError from "../../utils/AppError.js";

const tid = (req) => req.user.tenantId;

export const getSettings = async (req, res) => res.json(await service.getSettings(tid(req)));
export const updateSettings = async (req, res) => res.json(await service.updateSettings(tid(req), req.user.id, req.body));
export const test = async (req, res) => res.json(await service.testSend(tid(req), req.body));
export const prepare = async (req, res) => res.json(await service.prepare(tid(req), req.body));
export const send = async (req, res) => res.json(await service.send(tid(req), req.user, req.body));
export const logOpened = async (req, res) => res.status(201).json(await service.logOpened(tid(req), req.user, req.body));
export const history = async (req, res) => res.json(await service.history(tid(req), req.validatedQuery));

export const verifyWebhook = (req, res) => res.type("text/plain").send(service.verifyWebhook(req.query));

export async function receiveWebhook(req, res) {
  // req.body is the raw Buffer here (see app.js) so the signature can be checked
  if (!service.verifySignature(req.body, req.get("x-hub-signature-256"))) {
    throw AppError.unauthorized("Invalid signature", "INVALID_SIGNATURE");
  }
  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    throw AppError.badRequest("Malformed JSON body", "INVALID_JSON");
  }
  await service.handleWebhook(payload);
  // Meta only needs a 200 quickly
  res.sendStatus(200);
}
