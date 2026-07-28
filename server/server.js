// OwnerFieldOps — run your service business from one place.
//   npm install && npm start   →  http://localhost:4820
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { UPLOADS_DIR } from './db.js';
import { crm } from './routes/crm.js';
import { sales } from './routes/sales.js';
import { ops } from './routes/ops.js';
import { money } from './routes/money.js';
import { growth } from './routes/growth.js';
import { misc } from './routes/misc.js';
import { portal } from './routes/portal.js';
import rateLimit from 'express-rate-limit';
import { sharedLimitOptions, parseTrustProxy } from './rate-limit.js';
import { startAutomationLoop } from './automations.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// load .env if present (no dependency needed)
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const app = express();

// How the app is fronted decides what req.ip is, and req.ip is the rate-limit
// key — see the note in rate-limit.js. Default (TRUST_PROXY unset) is a direct
// listener, which is also Express's own default.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', trustProxy);
if (trustProxy === true) {
  console.warn(
    '  WARNING: TRUST_PROXY=true trusts any X-Forwarded-For header a client sends, which lets\n' +
    '  anyone bypass rate limiting. Set TRUST_PROXY to the number of proxies in front of the\n' +
    '  app (e.g. TRUST_PROXY=1) or to an explicit list of proxy addresses instead.\n'
  );
}

app.use(express.json({ limit: '25mb' })); // roomy enough for base64 photo uploads

// API
app.use('/api', crm, sales, ops, money, growth, misc, portal);

// Uploaded photos
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

// Static app
const PUBLIC = path.join(ROOT, 'public');
app.use(express.static(PUBLIC));

// Page loads are cheap, but the shareable links are public — cap floods well above
// anything a real person (or a whole office on one IP) would ever do in a minute.
const pageLimit = rateLimit({
  ...sharedLimitOptions,
  windowMs: 60_000,
  limit: 600,
  message: 'Too many requests. Please wait a moment and refresh.',
});

// Customer portal page (own URL so it can be shared safely)
app.get('/portal/:token', pageLimit, (req, res) => res.sendFile(path.join(PUBLIC, 'portal.html')));

// Printable invoice view
app.get('/invoice/:id/print', pageLimit, (req, res) => res.sendFile(path.join(PUBLIC, 'invoice-print.html')));

app.use(pageLimit, (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

const PORT = Number(process.env.PORT || 4820);
app.listen(PORT, () => {
  console.log(`\n  OwnerFieldOps is running:  http://localhost:${PORT}\n`);
  console.log(`  Owner dashboard  →  http://localhost:${PORT}/`);
  console.log(`  Worker view      →  http://localhost:${PORT}/#/worker\n`);
});

startAutomationLoop();
