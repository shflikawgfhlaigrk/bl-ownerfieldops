// Jobs & scheduling, workers, checklists, time clock, and job photos.
import { Router } from 'express';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { q, logActivity, UPLOADS_DIR } from '../db.js';
import { wrap, pick, required } from './helpers.js';
import { rateLimit } from '../rate-limit.js';

export const ops = Router();

// ---------- Workers ----------
ops.get('/workers', wrap((req, res) => {
  res.json(q.all(`SELECT id, name, phone, email, hourly_rate, color, active, created_at FROM workers ORDER BY active DESC, name`));
}));

ops.post('/workers', wrap((req, res) => {
  required(req.body, ['name']);
  const f = pick(req.body, ['name','phone','email','pin','hourly_rate','color','active'],
    { phone:'', email:'', pin:String(Math.floor(1000 + Math.random() * 9000)), hourly_rate:0, color:'#2f6fed', active:1 });
  const r = q.run(`INSERT INTO workers (name, phone, email, pin, hourly_rate, color, active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    f.name, f.phone, f.email, String(f.pin), Number(f.hourly_rate) || 0, f.color, f.active ? 1 : 0);
  res.json(q.get(`SELECT * FROM workers WHERE id = ?`, r.lastInsertRowid));
}));

ops.put('/workers/:id', wrap((req, res) => {
  const w = q.get(`SELECT * FROM workers WHERE id = ?`, req.params.id);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  const f = pick(req.body, ['name','phone','email','pin','hourly_rate','color','active'], w);
  q.run(`UPDATE workers SET name=?, phone=?, email=?, pin=?, hourly_rate=?, color=?, active=? WHERE id=?`,
    f.name, f.phone, f.email, String(f.pin), Number(f.hourly_rate) || 0, f.color, f.active ? 1 : 0, w.id);
  res.json(q.get(`SELECT * FROM workers WHERE id = ?`, w.id));
}));

ops.delete('/workers/:id', wrap((req, res) => {
  q.run(`UPDATE workers SET active = 0 WHERE id = ?`, req.params.id); // keep history, just deactivate
  res.json({ ok: true });
}));

// Worker login for the mobile view: name pick + PIN.
ops.post('/worker-login', wrap((req, res) => {
  required(req.body, ['worker_id', 'pin']);
  const w = q.get(`SELECT id, name, color FROM workers WHERE id = ? AND pin = ? AND active = 1`,
    req.body.worker_id, String(req.body.pin));
  if (!w) return res.status(401).json({ error: 'Wrong PIN' });
  res.json(w);
}));

// ---------- Checklist templates ----------
ops.get('/checklist-templates', wrap((req, res) => {
  const tpls = q.all(`SELECT * FROM checklist_templates ORDER BY name`);
  for (const t of tpls) t.items = q.all(`SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY sort, id`, t.id);
  res.json(tpls);
}));

ops.post('/checklist-templates', wrap((req, res) => {
  required(req.body, ['name']);
  const r = q.run(`INSERT INTO checklist_templates (name, service_type) VALUES (?, ?)`,
    req.body.name, req.body.service_type || '');
  const id = r.lastInsertRowid;
  (req.body.items || []).forEach((it, idx) =>
    q.run(`INSERT INTO checklist_template_items (template_id, text, requirement, sort) VALUES (?, ?, ?, ?)`,
      id, it.text || '', it.requirement || 'required', idx));
  res.json({ id });
}));

ops.put('/checklist-templates/:id', wrap((req, res) => {
  q.run(`UPDATE checklist_templates SET name = ?, service_type = ? WHERE id = ?`,
    req.body.name, req.body.service_type || '', req.params.id);
  q.run(`DELETE FROM checklist_template_items WHERE template_id = ?`, req.params.id);
  (req.body.items || []).forEach((it, idx) =>
    q.run(`INSERT INTO checklist_template_items (template_id, text, requirement, sort) VALUES (?, ?, ?, ?)`,
      req.params.id, it.text || '', it.requirement || 'required', idx));
  res.json({ ok: true });
}));

ops.delete('/checklist-templates/:id', wrap((req, res) => {
  q.run(`DELETE FROM checklist_templates WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// ---------- Jobs ----------
function jobFull(id) {
  const job = q.get(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, c.portal_token
       FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id WHERE j.id = ?`, id);
  if (!job) return null;
  job.workers = q.all(
    `SELECT w.id, w.name, w.color FROM job_workers jw JOIN workers w ON w.id = jw.worker_id WHERE jw.job_id = ?`, id);
  job.checklist = q.all(`SELECT * FROM job_checklist_items WHERE job_id = ? ORDER BY sort, id`, id);
  job.photos = q.all(`SELECT * FROM photos WHERE job_id = ? ORDER BY id`, id);
  job.time_entries = q.all(
    `SELECT t.*, w.name AS worker_name FROM time_entries t JOIN workers w ON w.id = t.worker_id WHERE t.job_id = ? ORDER BY t.clock_in`, id);
  return job;
}

function setJobWorkers(jobId, workerIds) {
  q.run(`DELETE FROM job_workers WHERE job_id = ?`, jobId);
  for (const wid of workerIds || []) q.run(`INSERT OR IGNORE INTO job_workers (job_id, worker_id) VALUES (?, ?)`, jobId, wid);
}

function conflictsFor(date, timeStart, timeEnd, workerIds, excludeJobId) {
  if (!date || !workerIds?.length) return [];
  const rows = q.all(
    `SELECT j.id, j.title, j.time_start, j.time_end, w.name AS worker_name, w.id AS worker_id
       FROM jobs j JOIN job_workers jw ON jw.job_id = j.id JOIN workers w ON w.id = jw.worker_id
      WHERE j.date = ? AND j.status IN ('scheduled','in_progress') AND j.id != ?`,
    date, excludeJobId || 0);
  const s1 = timeStart || '00:00', e1 = timeEnd || '23:59';
  return rows.filter(r =>
    workerIds.includes(r.worker_id) &&
    (r.time_start || '00:00') < e1 && s1 < (r.time_end || '23:59'));
}

ops.get('/jobs', wrap((req, res) => {
  const { from, to, worker_id, status } = req.query;
  let sql = `SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id WHERE 1=1`;
  const args = [];
  if (from) { sql += ` AND j.date >= ?`; args.push(from); }
  if (to) { sql += ` AND j.date <= ?`; args.push(to); }
  if (status) { sql += ` AND j.status = ?`; args.push(status); }
  if (worker_id) { sql += ` AND j.id IN (SELECT job_id FROM job_workers WHERE worker_id = ?)`; args.push(worker_id); }
  sql += ` ORDER BY j.date, j.time_start`;
  const rows = q.all(sql, ...args);
  for (const j of rows) {
    j.workers = q.all(`SELECT w.id, w.name, w.color FROM job_workers jw JOIN workers w ON w.id = jw.worker_id WHERE jw.job_id = ?`, j.id);
    const cl = q.get(`SELECT COUNT(*) total, SUM(done) done FROM job_checklist_items WHERE job_id = ?`, j.id);
    j.checklist_done = cl.done || 0; j.checklist_total = cl.total || 0;
  }
  res.json(rows);
}));

ops.get('/jobs/:id', wrap((req, res) => {
  const job = jobFull(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}));

ops.post('/jobs/check-conflicts', wrap((req, res) => {
  const { date, time_start, time_end, worker_ids, exclude_job_id } = req.body;
  res.json(conflictsFor(date, time_start, time_end, worker_ids || [], exclude_job_id));
}));

ops.post('/jobs', wrap((req, res) => {
  required(req.body, ['title']);
  const f = pick(req.body, ['customer_id','quote_id','title','service_type','date','time_start','time_end','address','notes','status'],
    { customer_id:null, quote_id:null, service_type:'', date:'', time_start:'', time_end:'', address:'', notes:'', status:'scheduled' });

  // default the address from the customer record
  if (!f.address && f.customer_id) {
    const c = q.get(`SELECT address, city, state, zip FROM customers WHERE id = ?`, f.customer_id);
    if (c) f.address = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
  }

  const r = q.run(
    `INSERT INTO jobs (customer_id, quote_id, title, service_type, date, time_start, time_end, address, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.customer_id || null, f.quote_id || null, f.title, f.service_type, f.date, f.time_start, f.time_end, f.address, f.notes, f.status);
  const id = r.lastInsertRowid;
  setJobWorkers(id, req.body.worker_ids);

  // attach checklist from template (explicit id, or match by service type)
  let tplId = req.body.checklist_template_id;
  if (!tplId && f.service_type) {
    tplId = q.get(`SELECT id FROM checklist_templates WHERE service_type = ?`, f.service_type)?.id;
  }
  if (tplId) {
    const items = q.all(`SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY sort, id`, tplId);
    items.forEach((it, idx) =>
      q.run(`INSERT INTO job_checklist_items (job_id, text, requirement, sort) VALUES (?, ?, ?, ?)`, id, it.text, it.requirement, idx));
  }

  if (f.customer_id) logActivity(f.customer_id, 'job', `Job scheduled: ${f.title}${f.date ? ' on ' + f.date : ''}`);
  if (f.quote_id) q.run(`UPDATE quotes SET status = 'approved', approved_at = COALESCE(approved_at, datetime('now')) WHERE id = ? AND status IN ('draft','sent')`, f.quote_id);
  const lead = f.quote_id ? q.get(`SELECT lead_id FROM quotes WHERE id = ?`, f.quote_id) : null;
  if (lead?.lead_id) q.run(`UPDATE leads SET stage = 'scheduled', updated_at = datetime('now') WHERE id = ?`, lead.lead_id);

  res.json({ ...jobFull(id), conflicts: conflictsFor(f.date, f.time_start, f.time_end, req.body.worker_ids || [], id) });
}));

ops.put('/jobs/:id', wrap((req, res) => {
  const job = q.get(`SELECT * FROM jobs WHERE id = ?`, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const f = pick(req.body, ['customer_id','quote_id','title','service_type','date','time_start','time_end','address','notes','status'], job);

  let completedAt = job.completed_at;
  if (f.status === 'complete' && job.status !== 'complete') {
    completedAt = new Date().toISOString();
    if (job.customer_id) logActivity(job.customer_id, 'job', `Job completed: ${f.title}`);
  }

  q.run(
    `UPDATE jobs SET customer_id=?, quote_id=?, title=?, service_type=?, date=?, time_start=?, time_end=?, address=?, notes=?, status=?, completed_at=? WHERE id=?`,
    f.customer_id || null, f.quote_id || null, f.title, f.service_type, f.date, f.time_start, f.time_end, f.address, f.notes, f.status, completedAt, job.id);
  if (req.body.worker_ids) setJobWorkers(job.id, req.body.worker_ids);
  res.json(jobFull(job.id));
}));

ops.delete('/jobs/:id', wrap((req, res) => {
  q.run(`DELETE FROM jobs WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// checklist item toggle
ops.put('/checklist-items/:id', wrap((req, res) => {
  const done = req.body.done ? 1 : 0;
  q.run(`UPDATE job_checklist_items SET done = ?, done_at = ? WHERE id = ?`,
    done, done ? new Date().toISOString() : null, req.params.id);
  res.json({ ok: true });
}));

// ---------- Time clock ----------
ops.get('/time-entries', wrap((req, res) => {
  const { worker_id, from, to } = req.query;
  let sql = `SELECT t.*, w.name AS worker_name, w.hourly_rate, j.title AS job_title
               FROM time_entries t JOIN workers w ON w.id = t.worker_id LEFT JOIN jobs j ON j.id = t.job_id WHERE 1=1`;
  const args = [];
  if (worker_id) { sql += ` AND t.worker_id = ?`; args.push(worker_id); }
  if (from) { sql += ` AND t.clock_in >= ?`; args.push(from); }
  if (to) { sql += ` AND t.clock_in <= ? || ' 23:59:59'`; args.push(to); }
  sql += ` ORDER BY t.clock_in DESC LIMIT 500`;
  res.json(q.all(sql, ...args));
}));

ops.post('/clock-in', wrap((req, res) => {
  required(req.body, ['worker_id']);
  const open = q.get(`SELECT id FROM time_entries WHERE worker_id = ? AND clock_out IS NULL`, req.body.worker_id);
  if (open) return res.status(400).json({ error: 'Already clocked in — clock out first.' });
  const r = q.run(`INSERT INTO time_entries (worker_id, job_id, gps_in, notes) VALUES (?, ?, ?, ?)`,
    req.body.worker_id, req.body.job_id || null, req.body.gps || '', req.body.notes || '');
  if (req.body.job_id) q.run(`UPDATE jobs SET status = 'in_progress' WHERE id = ? AND status = 'scheduled'`, req.body.job_id);
  res.json(q.get(`SELECT * FROM time_entries WHERE id = ?`, r.lastInsertRowid));
}));

ops.post('/clock-out', wrap((req, res) => {
  required(req.body, ['worker_id']);
  const open = q.get(`SELECT * FROM time_entries WHERE worker_id = ? AND clock_out IS NULL ORDER BY id DESC`, req.body.worker_id);
  if (!open) return res.status(400).json({ error: 'Not clocked in.' });
  q.run(`UPDATE time_entries SET clock_out = datetime('now'), gps_out = ?, notes = CASE WHEN ? != '' THEN ? ELSE notes END WHERE id = ?`,
    req.body.gps || '', req.body.notes || '', req.body.notes || '', open.id);
  res.json(q.get(`SELECT * FROM time_entries WHERE id = ?`, open.id));
}));

ops.get('/clock-status/:workerId', wrap((req, res) => {
  const open = q.get(
    `SELECT t.*, j.title AS job_title FROM time_entries t LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.worker_id = ? AND t.clock_out IS NULL`, req.params.workerId);
  res.json({ clocked_in: !!open, entry: open || null });
}));

// ---------- Photos (JSON upload with base64 data — no extra deps) ----------
// Photos land on disk, so cap the burst rate — 240/min per IP still leaves a whole
// crew room to dump a day of before/after shots at once.
const photoLimit = rateLimit({
  windowMs: 60_000,
  max: 240,
  message: 'Too many photo uploads at once. Please wait a moment and try again.',
});

ops.post('/jobs/:id/photos', photoLimit, wrap((req, res) => {
  required(req.body, ['data']);
  const job = q.get(`SELECT id FROM jobs WHERE id = ?`, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const match = String(req.body.data).match(/^data:image\/(png|jpe?g|webp|heic);base64,(.+)$/s);
  if (!match) return res.status(400).json({ error: 'Send a data URL for a png/jpg/webp image' });
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Photo too large (15MB max)' });
  const filename = `job${job.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  const r = q.run(`INSERT INTO photos (job_id, kind, filename, uploaded_by) VALUES (?, ?, ?, ?)`,
    job.id, req.body.kind === 'after' ? 'after' : req.body.kind === 'other' ? 'other' : 'before',
    filename, req.body.uploaded_by || '');
  res.json(q.get(`SELECT * FROM photos WHERE id = ?`, r.lastInsertRowid));
}));

ops.delete('/photos/:id', wrap((req, res) => {
  q.run(`DELETE FROM photos WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));
