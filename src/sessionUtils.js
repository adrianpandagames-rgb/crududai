// Keep in step with IDLE_TIMEOUT_MS in views/includes/scripts.ejs, which logs out the open page.
const SESSION_TIMEOUT_MS = 20 * 60 * 1000;
const REMEMBERED_SESSION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

const buildSessionCookieOptions = (rememberMe = false) => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  ...(rememberMe ? { maxAge: REMEMBERED_SESSION_TIMEOUT_MS } : {}),
});

const isSessionExpired = (session, now = Date.now()) => {
  if (!session) {
    return true;
  }

  const timeout = session.rememberMe ? REMEMBERED_SESSION_TIMEOUT_MS : SESSION_TIMEOUT_MS;
  return now - session.lastActivity > timeout;
};

export { SESSION_TIMEOUT_MS, REMEMBERED_SESSION_TIMEOUT_MS, buildSessionCookieOptions, isSessionExpired };
