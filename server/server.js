import './env.js';
// OwnerFieldOps — run your service business from one place.
//   npm install && npm start   →  http://localhost:4820
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crm } from './routes/crm.js';
import { sales } from './routes/sales.js';
import { ops } from './routes/ops.js';
import { money } from './routes/money.js';
import { growth } from './routes/growth.js';
import { misc } from './routes/misc.js';
import { portal } from './routes/portal.js';
import { rateLimit } from './rate-limit.js';
import { startAutomationLoop } from './automations.js';
import { auth, resolveSession, protectWrites, requireSession, requireOwner } from './auth.js';
import { q } from './db.js';
import { servePhoto } from './photos.js';
import { wrap } from './routes/helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export const app = express();
app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
app.use(express.json({ limit: '25mb' })); // roomy enough for base64 photo uploads

// API
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, resolveSession, protectWrites, auth, portal, requireSession, ops, requireOwner, crm, sales, money, growth, misc);

// Uploaded photos
app.get('/uploads/:filename', resolveSession, requireSession, wrap((req, res) =>
  servePhoto(req, res, q.get('SELECT * FROM photos WHERE filename = ?', req.params.filename))));
app.use('/uploads', (_req, res) => res.status(404).json({ error: 'Photo not found.' }));

// Static app
const PUBLIC = path.join(ROOT, 'public');
app.use(express.static(PUBLIC));

// Page loads are cheap, but the shareable links are public — cap floods well above
// anything a real person (or a whole office on one IP) would ever do in a minute.
const pageLimit = rateLimit({
  windowMs: 60_000,
  max: 600,
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

if (isMain) {
  const PORT = Number(process.env.PORT || 4820);
  app.listen(PORT, process.env.OFO_BIND_HOST || '127.0.0.1', () => {
  console.log(`\n  OwnerFieldOps is running:  http://localhost:${PORT}\n`);
  console.log(`  Owner dashboard  →  http://localhost:${PORT}/`);
  console.log(`  Worker view      →  http://localhost:${PORT}/#/worker\n`);
  });

  startAutomationLoop();
}
