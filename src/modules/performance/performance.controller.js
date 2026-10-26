import * as performanceService from "./performance.service.js";

export const leaderboard = async (req, res) => res.json(await performanceService.leaderboard(req.user.tenantId, req.validatedQuery));
