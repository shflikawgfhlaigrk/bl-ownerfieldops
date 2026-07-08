// Invoices, payment links, and payroll export.
import { Router } from 'express';
import { q, logActivity, getSetting } from '../db.js';
import { wrap, pick, required, toCsv } from './helpers.js';

export const money = Router();

export function invoiceTotals(inv, items) {
  const subtotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const afterDiscount = Math.max(0, subtotal - (inv.discount || 0));
  const tax = afterDiscount * ((inv.tax_rate || 0) / 100);
  return {
    subtotal: +subtotal.toFixed(2),
    discount: +(inv.discount || 0).toFixed(2),
    tax: +tax.toFixed(2),
    total: +(afterDiscount + tax).toFixed(2),
  };
}

function invoiceFull(id) {
  const inv = q.get(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            c.address AS customer_address, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
            c.portal_token, j.title AS job_title
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN jobs j ON j.id = i.job_id
      WHERE i.id = ?`, id);
  if (!inv) return null;
  inv.items = q.all(`SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id`, id);
  inv.totals = invoiceTotals(inv, inv.items);
  return inv;
}

function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const row = q.get(`SELECT COUNT(*) c FROM invoices WHERE number LIKE ?`, `INV-${year}-%`);
  return `INV-${year}-${String(row.c + 1).padStart(4, '0')}`;
}

function replaceItems(invoiceId, items) {
  q.run(`DELETE FROM invoice_items WHERE invoice_id = ?`, invoiceId);
  for (const it of items || []) {
    q.run(`INSERT INTO invoice_items (invoice_id, description, qty, unit_price) VALUES (?, ?, ?, ?)`,
      invoiceId, it.description || '', Number(it.qty) || 1, Number(it.unit_price) || 0);
  }
}

money.get('/invoices', wrap((req, res) => {
  const rows = q.all(
    `SELECT i.*, c.name AS customer_name,
            COALESCE((SELECT SUM(qty*unit_price) FROM invoice_items WHERE invoice_id = i.id), 0) AS subtotal
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      ORDER BY i.id DESC`);
  res.json(rows.map(r => {
    const t = invoiceTotals(r, [{ qty: 1, unit_price: r.subtotal }]);
    return { ...r, total: t.total };
  }));
}));

money.get('/invoices/:id', wrap((req, res) => {
  const inv = invoiceFull(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json(inv);
}));

money.post('/invoices', wrap((req, res) => {
  const f = pick(req.body, ['customer_id','job_id','quote_id','due_date','tax_rate','discount','payment_link','notes','status'],
    { customer_id:null, job_id:null, quote_id:null, due_date:'', tax_rate:Number(getSetting('default_tax_rate','0')), discount:0, payment_link:'', notes:'', status:'draft' });
  if (!f.due_date) {
    const days = Number(getSetting('invoice_terms_days', '14')) || 14;
    f.due_date = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  }
  const number = nextInvoiceNumber();
  const r = q.run(
    `INSERT INTO invoices (number, customer_id, job_id, quote_id, due_date, tax_rate, discount, payment_link, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    number, f.customer_id || null, f.job_id || null, f.quote_id || null, f.due_date,
    Number(f.tax_rate) || 0, Number(f.discount) || 0, f.payment_link, f.notes, f.status);
  replaceItems(r.lastInsertRowid, req.body.items);
  if (f.customer_id) logActivity(f.customer_id, 'invoice', `Invoice ${number} created`);
  res.json(invoiceFull(r.lastInsertRowid));
}));

// One-click: build an invoice from a completed job or an approved quote.
money.post('/invoices/from-job/:jobId', wrap((req, res) => {
  const job = q.get(`SELECT * FROM jobs WHERE id = ?`, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const quote = job.quote_id ? q.get(`SELECT * FROM quotes WHERE id = ?`, job.quote_id) : null;
  const items = quote
    ? q.all(`SELECT description, qty, unit_price FROM quote_items WHERE quote_id = ?`, quote.id)
    : [{ description: job.title || 'Service', qty: 1, unit_price: 0 }];
  const days = Number(getSetting('invoice_terms_days', '14')) || 14;
  const number = nextInvoiceNumber();
  const r = q.run(
    `INSERT INTO invoices (number, customer_id, job_id, quote_id, due_date, tax_rate, discount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
    number, job.customer_id, job.id, job.quote_id,
    new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
    quote ? quote.tax_rate : Number(getSetting('default_tax_rate', '0')),
    quote ? quote.discount : 0);
  replaceItems(r.lastInsertRowid, items);
  if (job.customer_id) logActivity(job.customer_id, 'invoice', `Invoice ${number} created from job "${job.title}"`);
  res.json(invoiceFull(r.lastInsertRowid));
}));

money.post('/invoices/from-quote/:quoteId', wrap((req, res) => {
  const quote = q.get(`SELECT * FROM quotes WHERE id = ?`, req.params.quoteId);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  const items = q.all(`SELECT description, qty, unit_price FROM quote_items WHERE quote_id = ?`, quote.id);
  const days = Number(getSetting('invoice_terms_days', '14')) || 14;
  const number = nextInvoiceNumber();
  const r = q.run(
    `INSERT INTO invoices (number, customer_id, quote_id, due_date, tax_rate, discount, status)
     VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
    number, quote.customer_id, quote.id,
    new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
    quote.tax_rate, quote.discount);
  replaceItems(r.lastInsertRowid, items);
  res.json(invoiceFull(r.lastInsertRowid));
}));

money.put('/invoices/:id', wrap((req, res) => {
  const inv = q.get(`SELECT * FROM invoices WHERE id = ?`, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const f = pick(req.body, ['customer_id','job_id','due_date','tax_rate','discount','payment_link','notes','status'], inv);
  let paidAt = inv.paid_at;
  if (f.status === 'paid' && inv.status !== 'paid') {
    paidAt = new Date().toISOString();
    if (inv.customer_id) logActivity(inv.customer_id, 'invoice', `Invoice ${inv.number} paid`);
  }
  q.run(
    `UPDATE invoices SET customer_id=?, job_id=?, due_date=?, tax_rate=?, discount=?, payment_link=?, notes=?, status=?, paid_at=? WHERE id=?`,
    f.customer_id || null, f.job_id || null, f.due_date, Number(f.tax_rate) || 0, Number(f.discount) || 0,
    f.payment_link, f.notes, f.status, paidAt, inv.id);
  if (req.body.items) replaceItems(inv.id, req.body.items);
  res.json(invoiceFull(inv.id));
}));

money.delete('/invoices/:id', wrap((req, res) => {
  q.run(`DELETE FROM invoices WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// Stripe payment link (only if STRIPE_SECRET_KEY is configured).
money.post('/invoices/:id/stripe-link', wrap(async (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(400).json({ error: 'Stripe is not connected. Add STRIPE_SECRET_KEY to .env, or paste a payment link manually.' });
  const inv = invoiceFull(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.totals.total <= 0) return res.status(400).json({ error: 'Invoice total is $0 — add line items first.' });

  const stripe = (path, params) => fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }).then(async r => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `Stripe error ${r.status}`);
    return data;
  });

  const price = await stripe('prices', {
    'currency': 'usd',
    'unit_amount': String(Math.round(inv.totals.total * 100)),
    'product_data[name]': `Invoice ${inv.number}${inv.customer_name ? ' — ' + inv.customer_name : ''}`,
  });
  const link = await stripe('payment_links', { 'line_items[0][price]': price.id, 'line_items[0][quantity]': '1' });
  q.run(`UPDATE invoices SET payment_link = ? WHERE id = ?`, link.url, inv.id);
  res.json({ payment_link: link.url });
}));

// ---------- Payroll export ----------
money.get('/payroll', wrap((req, res) => {
  const from = req.query.from || new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const entries = q.all(
    `SELECT t.*, w.name AS worker_name, w.hourly_rate, j.title AS job_title
       FROM time_entries t JOIN workers w ON w.id = t.worker_id LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.clock_out IS NOT NULL AND date(t.clock_in) >= ? AND date(t.clock_in) <= ?
      ORDER BY w.name, t.clock_in`, from, to);
  const byWorker = {};
  for (const e of entries) {
    const hours = (new Date(e.clock_out + 'Z') - new Date(e.clock_in + 'Z')) / 3600000;
    e.hours = +hours.toFixed(2);
    e.pay = +(hours * e.hourly_rate).toFixed(2);
    byWorker[e.worker_name] ??= { worker: e.worker_name, rate: e.hourly_rate, hours: 0, pay: 0, entries: 0 };
    byWorker[e.worker_name].hours = +(byWorker[e.worker_name].hours + e.hours).toFixed(2);
    byWorker[e.worker_name].pay = +(byWorker[e.worker_name].pay + e.pay).toFixed(2);
    byWorker[e.worker_name].entries++;
  }
  res.json({ from, to, entries, summary: Object.values(byWorker) });
}));

money.get('/payroll.csv', wrap((req, res) => {
  const from = req.query.from || new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const entries = q.all(
    `SELECT w.name AS worker, t.clock_in, t.clock_out, w.hourly_rate AS rate, COALESCE(j.title,'') AS job, t.notes
       FROM time_entries t JOIN workers w ON w.id = t.worker_id LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.clock_out IS NOT NULL AND date(t.clock_in) >= ? AND date(t.clock_in) <= ?
      ORDER BY w.name, t.clock_in`, from, to);
  for (const e of entries) {
    e.hours = +(((new Date(e.clock_out + 'Z') - new Date(e.clock_in + 'Z')) / 3600000)).toFixed(2);
    e.pay = +(e.hours * e.rate).toFixed(2);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${from}-to-${to}.csv"`);
  res.send(toCsv(entries, ['worker','clock_in','clock_out','hours','rate','pay','job','notes']));
}));
