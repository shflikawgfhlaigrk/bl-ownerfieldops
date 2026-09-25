import { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { q, db } from './db.js';
import { rateLimit } from './rate-limit.js';
import { wrap } from './routes/helpers.js';

db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY, role TEXT NOT NULL,
  worker_id INTEGER REFERENCES workers(id), credential_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);`);
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const ownerPassword = () => process.env.OFO_OWNER_PASSWORD || '';
const ownerConfigured = () => ownerPassword().length >= 16;
const COOKIE = 'ofo_session';

function token(req) {
  const authorization = req.get('Authorization');
  const value = authorization?.startsWith('Bearer ') ? authorization.slice(7) :
    (req.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}

function clearSession(req, res) {
  const previous = token(req);
  if (previous) q.run('DELETE FROM auth_sessions WHERE token_hash = ?', hash(previous));
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
}

function issueSession(req, res, role, worker = null) {
  const previous = token(req);
  if (previous) q.run('DELETE FROM auth_sessions WHERE token_hash = ?', hash(previous));
  const value = randomBytes(32).toString('hex');
  const age = 8 * 60 * 60 * 1000;
  q.run('DELETE FROM auth_sessions WHERE expires_at <= ?', Date.now());
  q.run('INSERT INTO auth_sessions (token_hash, role, worker_id, credential_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
    hash(value), role, worker?.id || null, hash(worker ? worker.pin : ownerPassword()), Date.now() + age);
  res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'strict', secure: req.secure || process.env.OFO_PUBLIC_ORIGIN?.startsWith('https://'), path: '/', maxAge: age });
  res.setHeader('Cache-Control', 'no-store');
}

export function resolveSession(req, _res, next) {
  req.auth = null;
  const value = token(req);
  const session = value ? q.get('SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > ?', hash(value), Date.now()) : null;
  if (session?.role === 'owner' && ownerConfigured() && session.credential_hash === hash(ownerPassword())) req.auth = { role: 'owner' };
  if (session?.role === 'worker') {
    const worker = q.get('SELECT id, name, color, pin FROM workers WHERE id = ? AND active = 1', session.worker_id);
    if (worker && hash(worker.pin) === session.credential_hash) req.auth = { role: 'worker', worker: { id: worker.id, name: worker.name, color: worker.color } };
  }
  if (session && !req.auth) q.run('DELETE FROM auth_sessions WHERE token_hash = ?', session.token_hash);
  next();
}

// Require same-origin JSON on browser writes. Bearer clients still have to
// authenticate; no Origin header is needed for non-browser API clients.
export function protectWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('Origin');
  const expected = process.env.OFO_PUBLIC_ORIGIN || `${req.protocol}://${req.get('Host')}`;
  if ((origin && origin !== expected) || !/^application\/json(?:;|$)/i.test(req.get('Content-Type') || '')) return res.status(403).json({ error: 'Use same-origin JSON requests.' });
  next();
}

export function requireSession(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.auth) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export function requireOwner(req, res, next) {
  if (req.auth?.role !== 'owner') return res.status(403).json({ error: 'Owner access required.' });
  next();
}

export const auth = Router();
const loginLimit = rateLimit({ windowMs: 60_000, max: 10, message: 'Too many sign-in attempts. Try again in a minute.' });
auth.get('/auth/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ authenticated: !!req.auth, ...req.auth, owner_configured: ownerConfigured() });
});
auth.post('/auth/login', loginLimit, wrap((req, res) => {
  if (!ownerConfigured()) return res.status(503).json({ error: 'Owner sign-in is not configured. Set OFO_OWNER_PASSWORD to at least 16 characters on the server.' });
  if (typeof req.body.password !== 'string' || !equal(req.body.password, ownerPassword())) return res.status(401).json({ error: 'Incorrect password.' });
  issueSession(req, res, 'owner');
  res.json({ role: 'owner' });
}));
auth.post('/worker-login', loginLimit, wrap((req, res) => {
  const worker = q.get('SELECT id, name, color, pin FROM workers WHERE id = ? AND active = 1', req.body.worker_id || null);
  if (!worker || String(worker.pin).length < 4 || typeof req.body.pin !== 'string' || !equal(req.body.pin, worker.pin)) return res.status(401).json({ error: 'Wrong worker ID or PIN.' });
  issueSession(req, res, 'worker', worker);
  res.json({ id: worker.id, name: worker.name, color: worker.color });
}));
auth.post('/auth/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });

function assigned(workerId, jobId) {
  return !!q.get('SELECT 1 FROM job_workers WHERE worker_id = ? AND job_id = ?', workerId, jobId);
}

export function workerScope(req, res, next) {
  if (req.auth?.role === 'owner') return next();
  const workerId = req.auth?.worker?.id;
  if (!workerId) return res.status(401).json({ error: 'Sign in to continue.' });
  const deny = () => res.status(403).json({ error: 'This action is outside your assigned work.' });
  const self = claimed => claimed === undefined || String(claimed) === String(workerId);
  const pathname = req.path.replace(/\/$/, '');
  if (req.method === 'GET' && ['/jobs', '/time-entries'].includes(pathname)) {
    if (!self(req.query.worker_id)) return deny();
    req.query.worker_id = String(workerId);
    return next();
  }
  const clockStatus = pathname.match(/^\/clock-status\/(\d+)$/);
  if (req.method === 'GET' && clockStatus) return self(clockStatus[1]) ? next() : deny();
  if (req.method === 'POST' && ['/clock-in', '/clock-out'].includes(pathname)) {
    if (!self(req.body.worker_id)) return deny();
    req.body.worker_id = workerId;
    const jobId = pathname === '/clock-in' ? req.body.job_id :
      q.get('SELECT job_id FROM time_entries WHERE worker_id = ? AND clock_out IS NULL ORDER BY id DESC', workerId)?.job_id;
    if (jobId && !assigned(workerId, jobId)) return deny();
    return next();
  }
  const job = pathname.match(/^\/jobs\/(\d+)(\/photos)?$/);
  if (job && assigned(workerId, job[1])) {
    if (req.method === 'GET' && !job[2]) return next();
    if (req.method === 'POST' && job[2]) { req.body.uploaded_by = req.auth.worker.name; return next(); }
    if (req.method === 'PUT' && !job[2] && Object.keys(req.body).every(k => ['notes', 'status'].includes(k)) &&
        (req.body.status === undefined || ['in_progress', 'complete'].includes(req.body.status))) return next();
  }
  const checklist = pathname.match(/^\/checklist-items\/(\d+)$/);
  if (req.method === 'PUT' && checklist) {
    const item = q.get('SELECT job_id FROM job_checklist_items WHERE id = ?', checklist[1]);
    if (item && assigned(workerId, item.job_id)) return next();
  }
  return deny();
}
