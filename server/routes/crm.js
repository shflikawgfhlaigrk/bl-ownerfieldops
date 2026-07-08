// Customers, properties, notes/activity timeline, and messages.
import { Router } from 'express';
import { q, logActivity, newToken } from '../db.js';
import { wrap, pick, required } from './helpers.js';

export const crm = Router();

const CUSTOMER_FIELDS = ['name','company','phone','email','address','city','state','zip','tags','notes','referred_by','sms_opt_out','email_opt_out'];

crm.get('/customers', wrap((req, res) => {
  const search = `%${(req.query.search || '').trim()}%`;
  const rows = q.all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) AS job_count,
            (SELECT COALESCE(SUM(ii.qty * ii.unit_price), 0) FROM invoices i
              JOIN invoice_items ii ON ii.invoice_id = i.id
              WHERE i.customer_id = c.id AND i.status = 'paid') AS lifetime_value,
            (SELECT COUNT(*) FROM messages m WHERE m.customer_id = c.id AND m.direction = 'in' AND m.read = 0) AS unread
       FROM customers c
      WHERE c.name LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.address LIKE ? OR c.tags LIKE ?
      ORDER BY c.name COLLATE NOCASE`,
    search, search, search, search, search, search);
  res.json(rows);
}));

crm.get('/customers/:id', wrap((req, res) => {
  const c = q.get(`SELECT * FROM customers WHERE id = ?`, req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  res.json({
    ...c,
    properties: q.all(`SELECT * FROM properties WHERE customer_id = ?`, c.id),
    activity: q.all(`SELECT * FROM activity WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`, c.id),
    jobs: q.all(`SELECT * FROM jobs WHERE customer_id = ? ORDER BY date DESC, id DESC`, c.id),
    quotes: q.all(`SELECT * FROM quotes WHERE customer_id = ? ORDER BY id DESC`, c.id),
    invoices: q.all(
      `SELECT i.*, COALESCE((SELECT SUM(qty*unit_price) FROM invoice_items WHERE invoice_id = i.id),0) AS subtotal
         FROM invoices i WHERE customer_id = ? ORDER BY id DESC`, c.id),
    photos: q.all(
      `SELECT p.* FROM photos p JOIN jobs j ON j.id = p.job_id WHERE j.customer_id = ? ORDER BY p.id DESC LIMIT 60`, c.id),
    messages: q.all(`SELECT * FROM messages WHERE customer_id = ? ORDER BY id ASC`, c.id),
    referrals_made: q.all(
      `SELECT r.*, ref.name AS referred_name FROM referrals r
        LEFT JOIN customers ref ON ref.id = r.referred_id WHERE r.referrer_id = ?`, c.id),
  });
}));

crm.post('/customers', wrap((req, res) => {
  required(req.body, ['name']);
  const f = pick(req.body, CUSTOMER_FIELDS, { company:'', phone:'', email:'', address:'', city:'', state:'', zip:'', tags:'', notes:'', referred_by:null, sms_opt_out:0, email_opt_out:0 });
  const r = q.run(
    `INSERT INTO customers (name, company, phone, email, address, city, state, zip, tags, notes, referred_by, sms_opt_out, email_opt_out, portal_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.name, f.company, f.phone, f.email, f.address, f.city, f.state, f.zip, f.tags, f.notes,
    f.referred_by || null, f.sms_opt_out ? 1 : 0, f.email_opt_out ? 1 : 0, newToken());
  const id = r.lastInsertRowid;
  logActivity(id, 'system', 'Customer added');
  if (f.referred_by) {
    q.run(`INSERT INTO referrals (referrer_id, referred_id, notes) VALUES (?, ?, 'Auto-created from customer record')`, f.referred_by, id);
  }
  res.json(q.get(`SELECT * FROM customers WHERE id = ?`, id));
}));

crm.put('/customers/:id', wrap((req, res) => {
  const c = q.get(`SELECT * FROM customers WHERE id = ?`, req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const f = pick(req.body, CUSTOMER_FIELDS, c);
  q.run(
    `UPDATE customers SET name=?, company=?, phone=?, email=?, address=?, city=?, state=?, zip=?, tags=?, notes=?, referred_by=?, sms_opt_out=?, email_opt_out=? WHERE id=?`,
    f.name, f.company, f.phone, f.email, f.address, f.city, f.state, f.zip, f.tags, f.notes,
    f.referred_by || null, f.sms_opt_out ? 1 : 0, f.email_opt_out ? 1 : 0, c.id);
  res.json(q.get(`SELECT * FROM customers WHERE id = ?`, c.id));
}));

crm.delete('/customers/:id', wrap((req, res) => {
  q.run(`DELETE FROM customers WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

crm.post('/customers/:id/notes', wrap((req, res) => {
  required(req.body, ['body']);
  logActivity(Number(req.params.id), req.body.kind || 'note', req.body.body);
  res.json({ ok: true });
}));

crm.post('/customers/:id/properties', wrap((req, res) => {
  const f = pick(req.body, ['label','address','city','state','zip','notes'], { label:'Main', address:'', city:'', state:'', zip:'', notes:'' });
  const r = q.run(`INSERT INTO properties (customer_id, label, address, city, state, zip, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    req.params.id, f.label, f.address, f.city, f.state, f.zip, f.notes);
  res.json(q.get(`SELECT * FROM properties WHERE id = ?`, r.lastInsertRowid));
}));

crm.delete('/properties/:id', wrap((req, res) => {
  q.run(`DELETE FROM properties WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// Messages (owner side of the customer-portal conversation)
crm.post('/customers/:id/messages', wrap((req, res) => {
  required(req.body, ['body']);
  q.run(`INSERT INTO messages (customer_id, direction, body) VALUES (?, 'out', ?)`, req.params.id, req.body.body);
  logActivity(Number(req.params.id), 'message', `Sent message: ${String(req.body.body).slice(0, 120)}`);
  res.json({ ok: true });
}));

crm.post('/customers/:id/messages/read', wrap((req, res) => {
  q.run(`UPDATE messages SET read = 1 WHERE customer_id = ? AND direction = 'in'`, req.params.id);
  res.json({ ok: true });
}));
