// Reviews, referrals, commercial prospects, automations, and the send ledger.
import { Router } from 'express';
import { q, logActivity, getSetting } from '../db.js';
import { wrap, pick, required, toCsv, parseCsv } from './helpers.js';
import { dispatch, retrySend, fillTemplate, smsConfigured, emailConfigured, dryRunOn } from '../send.js';

export const growth = Router();

// ---------- Review requests ----------
growth.get('/review-requests', wrap((req, res) => {
  res.json(q.all(
    `SELECT r.*, c.name AS customer_name, c.phone, c.email, j.title AS job_title
       FROM review_requests r
       LEFT JOIN customers c ON c.id = r.customer_id
       LEFT JOIN jobs j ON j.id = r.job_id
      ORDER BY r.id DESC LIMIT 300`));
}));

growth.post('/review-requests', wrap((req, res) => {
  required(req.body, ['customer_id']);
  const f = pick(req.body, ['customer_id','job_id','channel','message'], { job_id:null, channel:'sms', message:'' });
  if (!f.message) {
    const c = q.get(`SELECT name FROM customers WHERE id = ?`, f.customer_id);
    f.message = fillTemplate(
      `Hi {first_name}! Thanks for choosing {business}. If you were happy with the work, would you leave us a quick review? {review_link}`,
      { first_name: (c?.name || 'there').split(' ')[0], business: getSetting('business_name'), review_link: getSetting('review_link') });
  }
  const r = q.run(`INSERT INTO review_requests (customer_id, job_id, channel, message) VALUES (?, ?, ?, ?)`,
    f.customer_id, f.job_id || null, f.channel, f.message);
  res.json(q.get(`SELECT * FROM review_requests WHERE id = ?`, r.lastInsertRowid));
}));

// Send (or dry-run) one review request right now.
growth.post('/review-requests/:id/send', wrap(async (req, res) => {
  const r = q.get(
    `SELECT r.*, c.name, c.phone, c.email FROM review_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
    req.params.id);
  if (!r) return res.status(404).json({ error: 'Review request not found' });
  const to = r.channel === 'sms' ? r.phone : r.email;
  const log = await dispatch({
    channel: r.channel, to, body: r.message, subject: 'How did we do?',
    customer_id: r.customer_id, trigger: 'review_request', ref_table: 'review_requests', ref_id: r.id,
  });
  q.run(`UPDATE review_requests SET status = ?, error = ?, sent_at = datetime('now') WHERE id = ?`,
    log.status, log.error, r.id);
  res.json({ ...q.get(`SELECT * FROM review_requests WHERE id = ?`, r.id), log });
}));

growth.post('/review-requests/:id/skip', wrap((req, res) => {
  q.run(`UPDATE review_requests SET status = 'skipped' WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

growth.delete('/review-requests/:id', wrap((req, res) => {
  q.run(`DELETE FROM review_requests WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// ---------- Referrals ----------
growth.get('/referrals', wrap((req, res) => {
  const rows = q.all(
    `SELECT r.*, a.name AS referrer_name, b.name AS referred_name,
            COALESCE((SELECT SUM(ii.qty * ii.unit_price) FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
              WHERE i.customer_id = r.referred_id AND i.status = 'paid'), 0) AS referred_revenue
       FROM referrals r
       LEFT JOIN customers a ON a.id = r.referrer_id
       LEFT JOIN customers b ON b.id = r.referred_id
      ORDER BY r.id DESC`);
  res.json(rows);
}));

growth.post('/referrals', wrap((req, res) => {
  required(req.body, ['referrer_id']);
  const f = pick(req.body, ['referrer_id','referred_id','reward_amount','reward_paid','notes'],
    { referred_id:null, reward_amount:0, reward_paid:0, notes:'' });
  const r = q.run(`INSERT INTO referrals (referrer_id, referred_id, reward_amount, reward_paid, notes) VALUES (?, ?, ?, ?, ?)`,
    f.referrer_id, f.referred_id || null, Number(f.reward_amount) || 0, f.reward_paid ? 1 : 0, f.notes);
  res.json(q.get(`SELECT * FROM referrals WHERE id = ?`, r.lastInsertRowid));
}));

growth.put('/referrals/:id', wrap((req, res) => {
  const ref = q.get(`SELECT * FROM referrals WHERE id = ?`, req.params.id);
  if (!ref) return res.status(404).json({ error: 'Referral not found' });
  const f = pick(req.body, ['referrer_id','referred_id','reward_amount','reward_paid','notes'], ref);
  q.run(`UPDATE referrals SET referrer_id=?, referred_id=?, reward_amount=?, reward_paid=?, notes=? WHERE id=?`,
    f.referrer_id, f.referred_id || null, Number(f.reward_amount) || 0, f.reward_paid ? 1 : 0, f.notes, ref.id);
  res.json(q.get(`SELECT * FROM referrals WHERE id = ?`, ref.id));
}));

growth.delete('/referrals/:id', wrap((req, res) => {
  q.run(`DELETE FROM referrals WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// ---------- Commercial prospects ----------
const PROSPECT_FIELDS = ['company','contact','title','phone','email','website','industry','city','state','status','source','notes','last_contacted'];

growth.get('/prospects', wrap((req, res) => {
  const search = `%${(req.query.search || '').trim()}%`;
  res.json(q.all(
    `SELECT * FROM prospects
      WHERE company LIKE ? OR contact LIKE ? OR industry LIKE ? OR city LIKE ? OR email LIKE ?
      ORDER BY company COLLATE NOCASE`, search, search, search, search, search));
}));

growth.post('/prospects', wrap((req, res) => {
  required(req.body, ['company']);
  const f = pick(req.body, PROSPECT_FIELDS, Object.fromEntries(PROSPECT_FIELDS.map(k => [k, ''])));
  f.status ||= 'new';
  const r = q.run(
    `INSERT INTO prospects (company, contact, title, phone, email, website, industry, city, state, status, source, notes, last_contacted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...PROSPECT_FIELDS.map(k => f[k]));
  res.json(q.get(`SELECT * FROM prospects WHERE id = ?`, r.lastInsertRowid));
}));

growth.put('/prospects/:id', wrap((req, res) => {
  const p = q.get(`SELECT * FROM prospects WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Prospect not found' });
  const f = pick(req.body, PROSPECT_FIELDS, p);
  q.run(
    `UPDATE prospects SET company=?, contact=?, title=?, phone=?, email=?, website=?, industry=?, city=?, state=?, status=?, source=?, notes=?, last_contacted=? WHERE id=?`,
    ...PROSPECT_FIELDS.map(k => f[k]), p.id);
  res.json(q.get(`SELECT * FROM prospects WHERE id = ?`, p.id));
}));

growth.delete('/prospects/:id', wrap((req, res) => {
  q.run(`DELETE FROM prospects WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

growth.get('/prospects.csv', wrap((req, res) => {
  const rows = q.all(`SELECT * FROM prospects ORDER BY company COLLATE NOCASE`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="prospects.csv"');
  res.send(toCsv(rows, ['company','contact','title','phone','email','website','industry','city','state','status','source','notes','last_contacted']));
}));

growth.post('/prospects/import', wrap((req, res) => {
  required(req.body, ['csv']);
  const rows = parseCsv(req.body.csv);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one data row' });
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (name) => header.indexOf(name);
  let imported = 0, skipped = 0;
  for (const row of rows.slice(1)) {
    const get = (name) => (idx(name) >= 0 ? (row[idx(name)] || '').trim() : '');
    const company = get('company') || get('company_name') || get('business');
    if (!company) { skipped++; continue; }
    const email = get('email');
    if (email && q.get(`SELECT id FROM prospects WHERE email = ? AND email != ''`, email)) { skipped++; continue; }
    q.run(
      `INSERT INTO prospects (company, contact, title, phone, email, website, industry, city, state, status, source, notes, last_contacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      company, get('contact') || get('name'), get('title'), get('phone'), email, get('website'),
      get('industry'), get('city'), get('state'), get('status') || 'new', get('source') || 'csv import',
      get('notes'), get('last_contacted'));
    imported++;
  }
  res.json({ imported, skipped });
}));

// ---------- Automations ----------
growth.get('/automations', wrap((req, res) => {
  res.json({
    automations: q.all(`SELECT * FROM automations ORDER BY id`),
    channels: { sms_connected: smsConfigured(), email_connected: emailConfigured(), dry_run: dryRunOn() },
  });
}));

growth.post('/automations', wrap((req, res) => {
  required(req.body, ['name', 'trigger', 'template']);
  const f = pick(req.body, ['name','trigger','channel','delay_hours','template','active'],
    { channel:'sms', delay_hours:0, active:1 });
  const r = q.run(`INSERT INTO automations (name, trigger, channel, delay_hours, template, active) VALUES (?, ?, ?, ?, ?, ?)`,
    f.name, f.trigger, f.channel, Number(f.delay_hours) || 0, f.template, f.active ? 1 : 0);
  res.json(q.get(`SELECT * FROM automations WHERE id = ?`, r.lastInsertRowid));
}));

growth.put('/automations/:id', wrap((req, res) => {
  const a = q.get(`SELECT * FROM automations WHERE id = ?`, req.params.id);
  if (!a) return res.status(404).json({ error: 'Automation not found' });
  const f = pick(req.body, ['name','trigger','channel','delay_hours','template','active'], a);
  q.run(`UPDATE automations SET name=?, trigger=?, channel=?, delay_hours=?, template=?, active=? WHERE id=?`,
    f.name, f.trigger, f.channel, Number(f.delay_hours) || 0, f.template, f.active ? 1 : 0, a.id);
  res.json(q.get(`SELECT * FROM automations WHERE id = ?`, a.id));
}));

growth.delete('/automations/:id', wrap((req, res) => {
  q.run(`DELETE FROM automations WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// ---------- Send ledger ----------
growth.get('/send-log', wrap((req, res) => {
  res.json(q.all(
    `SELECT s.*, c.name AS customer_name, a.name AS automation_name
       FROM send_log s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN automations a ON a.id = s.automation_id
      ORDER BY s.id DESC LIMIT 300`));
}));

growth.post('/send-log/:id/retry', wrap(async (req, res) => {
  res.json(await retrySend(Number(req.params.id)));
}));
