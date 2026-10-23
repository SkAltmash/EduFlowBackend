import env from "../config/env.js";

export const REFRESH_COOKIE_NAME = "eduflow_rt";

function baseCookieOptions() {
  return {
    httpOnly: true,
    // SameSite=None requires Secure, so force it in that case too
    secure: env.isProduction || env.COOKIE_SAMESITE === "none",
    sameSite: env.COOKIE_SAMESITE,
    // The cookie is only sent to auth endpoints, never to the rest of the API
    path: "/api/auth",
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setRefreshCookie(res, token, expiresAt) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, baseCookieOptions());
}
