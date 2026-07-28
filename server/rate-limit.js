// Tiny in-process rate limiter — no dependencies, no config, no extra state store.
// Deliberately generous: it exists to stop floods and disk-fill abuse of the open
// endpoints, not to get in the way of a real customer or crew member.
const SWEEP_EVERY = 60_000;
const MAX_KEYS = 20_000;

export function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, resetAt }
  let lastSweep = 0;

  return function limiter(req, res, next) {
    const now = Date.now();

    if (now - lastSweep > SWEEP_EVERY || hits.size > MAX_KEYS) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }

    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429);
      if (req.originalUrl.startsWith('/api/')) return res.json({ error: message });
      return res.type('text/plain').send(message);
    }
    next();
  };
}
