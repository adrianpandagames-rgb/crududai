const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 20;
const MAX_FAILURES_PER_EMAIL = 5;

// Failures are counted per IP and per email, so one attacker cannot try many
// accounts and many IPs cannot target one account. Counters live in memory.
const createLoginRateLimiter = ({
  windowMs = LOGIN_WINDOW_MS,
  maxPerIp = MAX_FAILURES_PER_IP,
  maxPerEmail = MAX_FAILURES_PER_EMAIL,
} = {}) => {
  const failures = new Map();

  const activeEntry = (key, now) => {
    const entry = failures.get(key);
    if (!entry) return null;
    if (now - entry.firstFailure >= windowMs) {
      failures.delete(key);
      return null;
    }
    return entry;
  };

  const keysFor = (ip, email) => [
    { key: `ip:${ip}`, max: maxPerIp },
    ...(email ? [{ key: `email:${email}`, max: maxPerEmail }] : []),
  ];

  // Returns the milliseconds until another attempt is allowed, or 0 when allowed.
  const retryAfterMs = (ip, email, now = Date.now()) => {
    let wait = 0;
    for (const { key, max } of keysFor(ip, email)) {
      const entry = activeEntry(key, now);
      if (entry && entry.count >= max) wait = Math.max(wait, entry.firstFailure + windowMs - now);
    }
    return wait;
  };

  const recordFailure = (ip, email, now = Date.now()) => {
    for (const { key } of keysFor(ip, email)) {
      const entry = activeEntry(key, now);
      if (entry) entry.count += 1;
      else failures.set(key, { count: 1, firstFailure: now });
    }
  };

  // A successful login only clears the account counter; the IP keeps its failures.
  const recordSuccess = (email) => {
    if (email) failures.delete(`email:${email}`);
  };

  const prune = (now = Date.now()) => {
    for (const key of failures.keys()) activeEntry(key, now);
  };

  return { retryAfterMs, recordFailure, recordSuccess, prune, size: () => failures.size };
};

export { createLoginRateLimiter, LOGIN_WINDOW_MS, MAX_FAILURES_PER_IP, MAX_FAILURES_PER_EMAIL };
