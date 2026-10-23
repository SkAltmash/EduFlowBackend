import * as authService from "./auth.service.js";
import { REFRESH_COOKIE_NAME, clearRefreshCookie, setRefreshCookie } from "../../utils/cookies.js";

function requestMeta(req) {
  return { userAgent: req.get("user-agent"), ip: req.ip };
}

/** Moves the refresh token into the HttpOnly cookie; it never appears in a response body. */
function sendAuthResult(res, status, result) {
  const { refreshToken, refreshTokenExpiresAt, ...body } = result;
  if (refreshToken) {
    setRefreshCookie(res, refreshToken, refreshTokenExpiresAt);
  }
  res.status(status).json(body);
}

export async function register(req, res) {
  const result = await authService.register(req.body, requestMeta(req));
  sendAuthResult(res, 201, result);
}

export async function login(req, res) {
  const result = await authService.login(req.body, requestMeta(req));
  if (result.requiresTenantSelection) {
    return res.status(200).json(result);
  }
  sendAuthResult(res, 200, result);
}

export async function selectTenant(req, res) {
  const result = await authService.selectTenant(req.user.id, req.body.tenantId, {
    currentRefreshToken: req.cookies?.[REFRESH_COOKIE_NAME],
    meta: requestMeta(req),
  });
  sendAuthResult(res, 200, result);
}

export async function refresh(req, res) {
  try {
    const result = await authService.refresh(req.cookies?.[REFRESH_COOKIE_NAME]);
    sendAuthResult(res, 200, result);
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
}

export async function logout(req, res) {
  await authService.logout(req.cookies?.[REFRESH_COOKIE_NAME]);
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function me(req, res) {
  res.json(await authService.getCurrentUser(req.user));
}
