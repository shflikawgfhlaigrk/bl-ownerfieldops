// Customer portal — token-scoped, read-mostly API. Each customer gets a
// private link: /portal/<token>. No login needed; the token IS the access.
import { Router } from 'express';
import { db, q, logActivity, getSetting } from '../db.js';
import { wrap, required } from './helpers.js';
import { rateLimit } from '../rate-limit.js';
import { quoteTotals } from './sales.js';
import { invoiceTotals } from './money.js';
import { storePhoto, servePhoto } from '../photos.js';

export const portal = Router();

function customerByToken(token) {
  if (!token || String(token).length < 16) return null;
  return q.get(`SELECT * FROM customers WHERE portal_token = ?`, token);
}

portal.get('/portal-data/:token', wrap((req, res) => {
  const c = customerByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'This link is not valid. Please contact us for a new one.' });

  const quotes = q.all(
    `SELECT * FROM quotes WHERE customer_id = ? AND status IN ('sent','approved','declined','expired') ORDER BY id DESC`, c.id);
  for (const quote of quotes) {
    quote.items = q.all(`SELECT kind, description, qty, unit_price FROM quote_items WHERE quote_id = ? ORDER BY id`, quote.id);
    quote.totals = quoteTotals(quote);
  }

  const invoices = q.all(
    `SELECT * FROM invoices WHERE customer_id = ? AND status IN ('sent','paid','overdue') ORDER BY id DESC`, c.id);
  for (const inv of invoices) {
    inv.items = q.all(`SELECT description, qty, unit_price FROM invoice_items WHERE invoice_id = ? ORDER BY id`, inv.id);
    inv.totals = invoiceTotals(inv, inv.items);
  }

  const jobs = q.all(
    `SELECT id, title, service_type, date, time_start, time_end, address, status
       FROM jobs WHERE customer_id = ? AND status != 'canceled' ORDER BY date DESC LIMIT 20`, c.id);
  for (const job of jobs) {
    job.photos = q.all(`SELECT id, kind, filename, created_at FROM photos WHERE job_id = ? ORDER BY id`, job.id);
    for (const photo of job.photos) photo.url = `/api/portal-data/${encodeURIComponent(req.params.token)}/photos/${photo.id}`;
  }

  res.json({
    business: {
      name: getSetting('business_name'),
      phone: getSetting('business_phone'),
      email: getSetting('business_email'),
    },
    customer: { name: c.name },
    quotes, invoices, jobs,
    messages: q.all(`SELECT direction, body, created_at FROM messages WHERE customer_id = ? ORDER BY id ASC LIMIT 200`, c.id),
  });
}));

portal.post('/portal-data/:token/approve-quote/:quoteId', wrap((req, res) => {
  const c = customerByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid link' });
  const quote = q.get(`SELECT * FROM quotes WHERE id = ? AND customer_id = ?`, req.params.quoteId, c.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  db.exec('BEGIN IMMEDIATE');
  try {
    // The UTC calendar date matches the expiry sweep: today is still valid.
    // Validate canonical dates too; malformed nonempty values fail closed.
    const result = q.run(`UPDATE quotes
        SET status = 'approved', approved_at = datetime('now'), approval_name = ?
        WHERE id = ? AND customer_id = ? AND status = 'sent'
          AND (COALESCE(expires_on, '') = '' OR (
            length(expires_on) = 10
            AND expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND date(expires_on, '+0 days') = expires_on
            AND expires_on >= date('now')
          ))`, req.body.name || c.name, quote.id, c.id);
    if (result.changes !== 1) {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: 'This quote can no longer be approved.' });
    }
    const approved = q.get(`SELECT * FROM quotes WHERE id = ?`, quote.id);
    if (approved.lead_id) q.run(`UPDATE leads SET stage = 'won', updated_at = datetime('now') WHERE id = ? AND customer_id = ?`, approved.lead_id, c.id);
    logActivity(c.id, 'quote', `Customer approved quote "${approved.title || '#' + approved.id}" via portal`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
}));

portal.post('/portal-data/:token/decline-quote/:quoteId', wrap((req, res) => {
  const c = customerByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid link' });
  const quote = q.get(`SELECT * FROM quotes WHERE id = ? AND customer_id = ? AND status = 'sent'`, req.params.quoteId, c.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  q.run(`UPDATE quotes SET status = 'declined' WHERE id = ?`, quote.id);
  logActivity(c.id, 'quote', `Customer declined quote "${quote.title || '#' + quote.id}" via portal`);
  res.json({ ok: true });
}));

portal.post('/portal-data/:token/messages', wrap((req, res) => {
  const c = customerByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid link' });
  required(req.body, ['body']);
  q.run(`INSERT INTO messages (customer_id, direction, body) VALUES (?, 'in', ?)`, c.id, String(req.body.body).slice(0, 2000));
  logActivity(c.id, 'message', `Customer sent a message via portal`);
  res.json({ ok: true });
}));

portal.get('/portal-data/:token/photos/:id', wrap((req, res) => {
  const customer = customerByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Photo not found.' });
  servePhoto(req, res, q.get('SELECT * FROM photos WHERE id = ?', req.params.id), customer.id);
}));

// The portal link is public, so photo upload is the one open door that writes to disk.
// 60/min per IP is far above a real customer sending a few pictures.
const uploadLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: 'Too many uploads right now. Please wait a minute and try again.',
});

// Customer photo upload (e.g. "here's the problem area") attaches to their most recent job.
portal.post('/portal-data/:token/photos', uploadLimit, wrap((req, res) => {
  const c = customerByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid link' });
  required(req.body, ['data']);
  const job = req.body.job_id
    ? q.get(`SELECT id FROM jobs WHERE id = ? AND customer_id = ?`, req.body.job_id, c.id)
    : q.get(`SELECT id FROM jobs WHERE customer_id = ? ORDER BY id DESC`, c.id);
  if (!job) return res.status(400).json({ error: 'No job on file to attach this photo to yet.' });
  storePhoto(job.id, req.body.data, 'other', c.name, { customerId: c.id });
  logActivity(c.id, 'message', 'Customer uploaded a photo via portal');
  res.json({ ok: true });
}));
