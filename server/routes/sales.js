// Leads pipeline + quotes (with line items and the estimate calculator save path).
import { Router } from 'express';
import { q, logActivity, getSetting, newToken } from '../db.js';
import { wrap, pick, required } from './helpers.js';

export const sales = Router();

export const LEAD_STAGES = ['new','contacted','estimate_scheduled','quote_sent','won','scheduled','lost'];

// ---------- Leads ----------
const LEAD_FIELDS = ['name','phone','email','address','source','service_type','stage','value_estimate','next_action','next_action_date','owner','notes','lost_reason','customer_id'];

sales.get('/leads', wrap((req, res) => {
  const rows = q.all(`SELECT * FROM leads ORDER BY
    CASE stage WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 WHEN 'estimate_scheduled' THEN 2
      WHEN 'quote_sent' THEN 3 WHEN 'won' THEN 4 WHEN 'scheduled' THEN 5 ELSE 6 END,
    updated_at DESC`);
  res.json(rows);
}));

sales.post('/leads', wrap((req, res) => {
  required(req.body, ['name']);
  const f = pick(req.body, LEAD_FIELDS, { phone:'', email:'', address:'', source:'', service_type:'', stage:'new', value_estimate:0, next_action:'', next_action_date:'', owner:'', notes:'', lost_reason:'', customer_id:null });
  const r = q.run(
    `INSERT INTO leads (name, phone, email, address, source, service_type, stage, value_estimate, next_action, next_action_date, owner, notes, customer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.name, f.phone, f.email, f.address, f.source, f.service_type, f.stage, Number(f.value_estimate) || 0,
    f.next_action, f.next_action_date, f.owner, f.notes, f.customer_id || null);
  res.json(q.get(`SELECT * FROM leads WHERE id = ?`, r.lastInsertRowid));
}));

sales.put('/leads/:id', wrap((req, res) => {
  const lead = q.get(`SELECT * FROM leads WHERE id = ?`, req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const f = pick(req.body, LEAD_FIELDS, lead);
  if (f.stage && !LEAD_STAGES.includes(f.stage)) return res.status(400).json({ error: 'Bad stage' });

  // Winning a lead promotes it to a customer automatically.
  let customerId = f.customer_id || lead.customer_id;
  if (f.stage === 'won' && !customerId) {
    const r = q.run(
      `INSERT INTO customers (name, phone, email, address, portal_token, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      f.name, f.phone, f.email, f.address, newToken(), `Converted from lead (source: ${f.source || 'unknown'})`);
    customerId = r.lastInsertRowid;
    logActivity(customerId, 'system', 'Created from won lead');
  }

  q.run(
    `UPDATE leads SET name=?, phone=?, email=?, address=?, source=?, service_type=?, stage=?, value_estimate=?, next_action=?, next_action_date=?, owner=?, notes=?, lost_reason=?, customer_id=?, updated_at=datetime('now') WHERE id=?`,
    f.name, f.phone, f.email, f.address, f.source, f.service_type, f.stage, Number(f.value_estimate) || 0,
    f.next_action, f.next_action_date, f.owner, f.notes, f.lost_reason, customerId || null, lead.id);
  res.json(q.get(`SELECT * FROM leads WHERE id = ?`, lead.id));
}));

sales.delete('/leads/:id', wrap((req, res) => {
  q.run(`DELETE FROM leads WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// ---------- Quotes ----------
function quoteWithItems(id) {
  const quote = q.get(
    `SELECT qu.*, c.name AS customer_name, c.portal_token, l.name AS lead_name
       FROM quotes qu
       LEFT JOIN customers c ON c.id = qu.customer_id
       LEFT JOIN leads l ON l.id = qu.lead_id
      WHERE qu.id = ?`, id);
  if (!quote) return null;
  quote.items = q.all(`SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id`, id);
  quote.totals = quoteTotals(quote);
  return quote;
}

export function quoteTotals(quote) {
  const subtotal = (quote.items || []).reduce((s, it) => s + it.qty * it.unit_price, 0);
  const afterDiscount = Math.max(0, subtotal - (quote.discount || 0));
  const tax = afterDiscount * ((quote.tax_rate || 0) / 100);
  return {
    subtotal: +subtotal.toFixed(2),
    discount: +(quote.discount || 0).toFixed(2),
    tax: +tax.toFixed(2),
    total: +(afterDiscount + tax).toFixed(2),
  };
}

function replaceItems(quoteId, items) {
  q.run(`DELETE FROM quote_items WHERE quote_id = ?`, quoteId);
  const ins = q.run;
  for (const it of items || []) {
    ins(`INSERT INTO quote_items (quote_id, kind, description, qty, unit_price) VALUES (?, ?, ?, ?, ?)`,
      quoteId, it.kind || 'labor', it.description || '', Number(it.qty) || 1, Number(it.unit_price) || 0);
  }
}

sales.get('/quotes', wrap((req, res) => {
  const rows = q.all(
    `SELECT qu.*, c.name AS customer_name, l.name AS lead_name,
            COALESCE((SELECT SUM(qty*unit_price) FROM quote_items WHERE quote_id = qu.id), 0) AS subtotal
       FROM quotes qu
       LEFT JOIN customers c ON c.id = qu.customer_id
       LEFT JOIN leads l ON l.id = qu.lead_id
      ORDER BY qu.id DESC`);
  res.json(rows.map(r => ({ ...r, total: quoteTotals({ ...r, items: [{ qty: 1, unit_price: r.subtotal }] }).total })));
}));

sales.get('/quotes/:id', wrap((req, res) => {
  const quote = quoteWithItems(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  res.json(quote);
}));

sales.post('/quotes', wrap((req, res) => {
  const f = pick(req.body, ['lead_id','customer_id','title','service_type','notes','discount','tax_rate','expires_on','status'],
    { lead_id:null, customer_id:null, title:'', service_type:'', notes:'', discount:0, tax_rate:Number(getSetting('default_tax_rate','0')), expires_on:'', status:'draft' });
  const r = q.run(
    `INSERT INTO quotes (lead_id, customer_id, title, service_type, notes, discount, tax_rate, expires_on, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.lead_id || null, f.customer_id || null, f.title, f.service_type, f.notes,
    Number(f.discount) || 0, Number(f.tax_rate) || 0, f.expires_on, f.status);
  const id = r.lastInsertRowid;
  replaceItems(id, req.body.items);
  if (f.customer_id) logActivity(f.customer_id, 'quote', `Quote created: ${f.title || '#' + id}`);
  res.json(quoteWithItems(id));
}));

sales.put('/quotes/:id', wrap((req, res) => {
  const quote = q.get(`SELECT * FROM quotes WHERE id = ?`, req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  const f = pick(req.body, ['lead_id','customer_id','title','service_type','notes','discount','tax_rate','expires_on','status'], quote);

  // status transitions worth stamping
  let sentAt = quote.sent_at, approvedAt = quote.approved_at;
  if (f.status === 'sent' && quote.status !== 'sent') sentAt = new Date().toISOString();
  if (f.status === 'approved' && quote.status !== 'approved') approvedAt = new Date().toISOString();

  q.run(
    `UPDATE quotes SET lead_id=?, customer_id=?, title=?, service_type=?, notes=?, discount=?, tax_rate=?, expires_on=?, status=?, sent_at=?, approved_at=? WHERE id=?`,
    f.lead_id || null, f.customer_id || null, f.title, f.service_type, f.notes,
    Number(f.discount) || 0, Number(f.tax_rate) || 0, f.expires_on, f.status, sentAt, approvedAt, quote.id);
  if (req.body.items) replaceItems(quote.id, req.body.items);

  // keep the lead's stage in step with the quote
  if (quote.lead_id) {
    if (f.status === 'sent') q.run(`UPDATE leads SET stage='quote_sent', updated_at=datetime('now') WHERE id=? AND stage NOT IN ('won','scheduled','lost')`, quote.lead_id);
    if (f.status === 'approved') q.run(`UPDATE leads SET stage='won', updated_at=datetime('now') WHERE id=? AND stage NOT IN ('scheduled')`, quote.lead_id);
  }
  res.json(quoteWithItems(quote.id));
}));

sales.delete('/quotes/:id', wrap((req, res) => {
  q.run(`DELETE FROM quotes WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));
