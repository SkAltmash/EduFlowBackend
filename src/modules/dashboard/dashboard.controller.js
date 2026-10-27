import * as dashboardService from "./dashboard.service.js";

export const overview = async (req, res) =>
  res.json(await dashboardService.overview(req.user.tenantId, req.user, req.validatedQuery));
