// Shared rate-limiting configuration.
//
// The limiter middleware itself is built with `rateLimit()` from
// `express-rate-limit` at each place it is attached to a route (server.js,
// routes/ops.js, routes/portal.js). This file only holds the pieces every
// limiter shares, so the response shape and the proxy handling stay identical
// everywhere.
//
// Limits are deliberately generous: they exist to stop floods, portal-token
// guessing and disk-fill abuse of the open endpoints — not to get in the way of
// a real customer or of a whole crew working off one office IP.

// Reply in the shape the rest of the app already uses: JSON under /api/, plain
// text for page loads. Always send Retry-After so a client can back off.
export function limitHandler(req, res, _next, options) {
  const resetTime = req.rateLimit?.resetTime;
  const retryAfter = resetTime
    ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
    : Math.ceil(options.windowMs / 1000);
  if (!res.headersSent) res.setHeader('Retry-After', String(retryAfter));
  res.status(options.statusCode);
  if (req.originalUrl.startsWith('/api/')) return res.json({ error: options.message });
  return res.type('text/plain').send(options.message);
}

// Options every limiter in the app shares. Headers stay off so a limited
// response looks exactly like it did before, apart from Retry-After.
export const sharedLimitOptions = {
  standardHeaders: false,
  legacyHeaders: false,
  handler: limitHandler,
};

// Express's `trust proxy` setting decides what `req.ip` is, and `req.ip` is what
// the limiter counts against. Getting it wrong breaks the limiter in one of two
// ways:
//   * left off while the app sits behind nginx/Caddy/Cloudflare, every request
//     looks like it came from the proxy, so all customers share one bucket and
//     a single busy visitor locks everyone out at once;
//   * turned on while the app is reachable directly, anyone can send their own
//     X-Forwarded-For header, mint an unlimited number of buckets and walk
//     straight past the limit.
//
// OwnerFieldOps ships as a direct listener (`npm start` -> http://localhost:4820)
// and there is no reverse proxy in this repo, so the default is OFF, which is
// also Express's own default. If you put it behind a proxy, set TRUST_PROXY in
// .env to the NUMBER of proxies in front of the app (TRUST_PROXY=1 for a single
// nginx; 2 for Cloudflare -> nginx -> app), or to a comma-separated list of
// trusted proxy addresses/CIDRs. `true` is accepted but discouraged: it trusts
// the whole forwarded chain and is trivially spoofable.
export function parseTrustProxy(raw) {
  const v = String(raw ?? '').trim();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
