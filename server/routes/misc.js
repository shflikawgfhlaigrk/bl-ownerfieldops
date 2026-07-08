// Owner dashboard, reports, and settings.
import { Router } from 'express';
import { q, getSetting, setSetting } from '../db.js';
import { wrap } from './helpers.js';
import { invoiceTotals } from './money.js';
import { runAutomations } from '../automations.js';
import { smsConfigured, emailConfigured } from '../send.js';

export const misc = Router();

const invTotal = (row) => invoiceTotals(row, [{ qty: 1, unit_price: row.subtotal }]).total;

misc.get('/dashboard', wrap((req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';

  const todaysJobs = q.all(
    `SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
      WHERE j.date = ? AND j.status != 'canceled' ORDER BY j.time_start`, today);
  for (const j of todaysJobs) {
    j.workers = q.all(`SELECT w.name, w.color FROM job_workers jw JOIN workers w ON w.id = jw.worker_id WHERE jw.job_id = ?`, j.id);
  }

  const unpaid = q.all(
    `SELECT i.*, c.name AS customer_name,
            COALESCE((SELECT SUM(qty*unit_price) FROM invoice_items WHERE invoice_id = i.id),0) AS subtotal
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.status IN ('sent','overdue') ORDER BY i.due_date`);

  const paidThisMonth = q.all(
    `SELECT i.*, COALESCE((SELECT SUM(qty*unit_price) FROM invoice_items WHERE invoice_id = i.id),0) AS subtotal
       FROM invoices i WHERE i.status = 'paid' AND date(i.paid_at) >= ?`, monthStart);

  const hoursThisWeek = q.all(
    `SELECT w.name, SUM((julianday(COALESCE(t.clock_out, datetime('now'))) - julianday(t.clock_in)) * 24) AS hours
       FROM time_entries t JOIN workers w ON w.id = t.worker_id
      WHERE date(t.clock_in) >= date('now', 'weekday 0', '-6 days')
      GROUP BY w.id ORDER BY hours DESC`);

  res.json({
    business_name: getSetting('business_name'),
    today,
    todays_jobs: todaysJobs,
    new_leads: q.all(`SELECT * FROM leads WHERE stage = 'new' ORDER BY created_at DESC LIMIT 8`),
    new_lead_count: q.get(`SELECT COUNT(*) c FROM leads WHERE stage = 'new'`).c,
    open_quotes: q.all(
      `SELECT qu.*, COALESCE(c.name, l.name) AS who,
              COALESCE((SELECT SUM(qty*unit_price) FROM quote_items WHERE quote_id = qu.id),0) AS subtotal
         FROM quotes qu LEFT JOIN customers c ON c.id = qu.customer_id LEFT JOIN leads l ON l.id = qu.lead_id
        WHERE qu.status IN ('draft','sent') ORDER BY qu.id DESC LIMIT 8`),
    active_jobs: q.all(
      `SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
        WHERE j.status = 'in_progress' ORDER BY j.date`),
    unpaid_invoices: unpaid.map(i => ({ ...i, total: invTotal(i) })),
    unpaid_total: +unpaid.reduce((s, i) => s + invTotal(i), 0).toFixed(2),
    revenue_month: +paidThisMonth.reduce((s, i) => s + invTotal(i), 0).toFixed(2),
    worker_hours_week: hoursThisWeek.map(h => ({ ...h, hours: +(h.hours || 0).toFixed(1) })),
    pending_reviews: q.get(`SELECT COUNT(*) c FROM review_requests WHERE status = 'queued'`).c,
    unread_messages: q.get(`SELECT COUNT(*) c FROM messages WHERE direction = 'in' AND read = 0`).c,
    clocked_in_now: q.all(
      `SELECT w.name, w.color, t.clock_in, j.title AS job_title
         FROM time_entries t JOIN workers w ON w.id = t.worker_id LEFT JOIN jobs j ON j.id = t.job_id
        WHERE t.clock_out IS NULL`),
  });
}));

misc.get('/reports', wrap((req, res) => {
  const from = req.query.from || new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);

  // Lead conversion
  const leadTotal = q.get(`SELECT COUNT(*) c FROM leads WHERE date(created_at) BETWEEN ? AND ?`, from, to).c;
  const leadWon = q.get(`SELECT COUNT(*) c FROM leads WHERE stage IN ('won','scheduled') AND date(created_at) BETWEEN ? AND ?`, from, to).c;
  const leadLost = q.get(`SELECT COUNT(*) c FROM leads WHERE stage = 'lost' AND date(created_at) BETWEEN ? AND ?`, from, to).c;
  const bySource = q.all(
    `SELECT COALESCE(NULLIF(source,''),'(no source)') AS source, COUNT(*) AS total,
            SUM(CASE WHEN stage IN ('won','scheduled') THEN 1 ELSE 0 END) AS won
       FROM leads WHERE date(created_at) BETWEEN ? AND ? GROUP BY 1 ORDER BY total DESC`, from, to);

  // Quotes
  const quotesSent = q.get(`SELECT COUNT(*) c FROM quotes WHERE status IN ('sent','approved','declined','expired') AND date(created_at) BETWEEN ? AND ?`, from, to).c;
  const quotesApproved = q.get(`SELECT COUNT(*) c FROM quotes WHERE status = 'approved' AND date(created_at) BETWEEN ? AND ?`, from, to).c;

  // Revenue by month (paid invoices)
  const revenueByMonth = q.all(
    `SELECT substr(paid_at, 1, 7) AS month,
            SUM((SELECT SUM(qty*unit_price) FROM invoice_items WHERE invoice_id = i.id)) AS revenue
       FROM invoices i WHERE status = 'paid' AND paid_at IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12`);

  // Jobs + service mix
  const jobsDone = q.get(`SELECT COUNT(*) c FROM jobs WHERE status = 'complete' AND date BETWEEN ? AND ?`, from, to).c;
  const byService = q.all(
    `SELECT COALESCE(NULLIF(service_type,''),'(none)') AS service, COUNT(*) AS jobs
       FROM jobs WHERE date BETWEEN ? AND ? GROUP BY 1 ORDER BY jobs DESC`, from, to);

  // Worker hours
  const workerHours = q.all(
    `SELECT w.name, w.hourly_rate,
            ROUND(SUM((julianday(t.clock_out) - julianday(t.clock_in)) * 24), 1) AS hours
       FROM time_entries t JOIN workers w ON w.id = t.worker_id
      WHERE t.clock_out IS NOT NULL AND date(t.clock_in) BETWEEN ? AND ?
      GROUP BY w.id ORDER BY hours DESC`, from, to);

  // Money outstanding
  const unpaidRows = q.all(
    `SELECT i.*, COALESCE((SELECT SUM(qty*unit_price) FROM invoice_items WHERE invoice_id = i.id),0) AS subtotal
       FROM invoices i WHERE status IN ('sent','overdue')`);

  // Reviews + referrals
  const reviewsSent = q.get(`SELECT COUNT(*) c FROM review_requests WHERE status = 'sent' AND date(created_at) BETWEEN ? AND ?`, from, to).c;
  const referrals = q.get(`SELECT COUNT(*) c, COALESCE(SUM(reward_amount),0) owed FROM referrals WHERE reward_paid = 0`);

  res.json({
    from, to,
    leads: { total: leadTotal, won: leadWon, lost: leadLost,
      conversion: leadTotal ? +((leadWon / leadTotal) * 100).toFixed(1) : 0, by_source: bySource },
    quotes: { sent: quotesSent, approved: quotesApproved,
      close_rate: quotesSent ? +((quotesApproved / quotesSent) * 100).toFixed(1) : 0 },
    revenue_by_month: revenueByMonth.map(r => ({ ...r, revenue: +(r.revenue || 0).toFixed(2) })),
    jobs: { completed: jobsDone, by_service: byService },
    worker_hours: workerHours,
    outstanding: +unpaidRows.reduce((s, i) => s + invTotal(i), 0).toFixed(2),
    reviews_sent: reviewsSent,
    referral_rewards_owed: +referrals.owed.toFixed(2),
  });
}));

// ---------- Settings ----------
misc.get('/settings', wrap((req, res) => {
  const rows = q.all(`SELECT key, value FROM settings`);
  res.json({
    settings: Object.fromEntries(rows.map(r => [r.key, r.value])),
    integrations: {
      stripe_connected: !!process.env.STRIPE_SECRET_KEY,
      sms_connected: smsConfigured(),
      email_connected: emailConfigured(),
    },
  });
}));

misc.put('/settings', wrap((req, res) => {
  const allowed = ['business_name','business_phone','business_email','business_address','default_tax_rate','default_hourly_rate','review_link','dry_run','invoice_terms_days','invoice_footer'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) setSetting(key, req.body[key]);
  }
  res.json({ ok: true });
}));

// Manually run the automation engine now (the "Run now" button).
misc.post('/automations/run-now', wrap(async (req, res) => {
  const fired = await runAutomations();
  res.json({ fired });
}));
