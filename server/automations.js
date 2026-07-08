// Automation engine. Runs every few minutes, scans for things that should
// trigger a message, and dispatches through the send ledger. Each
// (automation, record) pair fires at most once — the ledger is the dedupe.
import { q, getSetting } from './db.js';
import { dispatch, fillTemplate } from './send.js';

function alreadyFired(automationId, refTable, refId) {
  return !!q.get(
    `SELECT id FROM send_log WHERE automation_id = ? AND ref_table = ? AND ref_id = ?
       AND status != 'error'`,
    automationId, refTable, refId
  );
}

function vars(customer, extra = {}) {
  return {
    business: getSetting('business_name', 'our team'),
    review_link: getSetting('review_link', ''),
    first_name: (customer?.name || '').split(' ')[0] || 'there',
    name: customer?.name || 'there',
    ...extra,
  };
}

function targetFor(channel, contact) {
  return channel === 'sms' ? (contact?.phone || '') : (contact?.email || '');
}

async function fire(auto, refTable, refId, customer, extraVars) {
  const body = fillTemplate(auto.template, vars(customer, extraVars));
  await dispatch({
    channel: auto.channel,
    to: targetFor(auto.channel, customer),
    body,
    subject: auto.name,
    customer_id: customer?.id || null,
    automation_id: auto.id,
    trigger: auto.trigger,
    ref_table: refTable,
    ref_id: refId,
  });
}

export async function runAutomations() {
  const autos = q.all(`SELECT * FROM automations WHERE active = 1`);
  let fired = 0;

  for (const auto of autos) {
    const delay = `-${Number(auto.delay_hours || 0)} hours`;

    if (auto.trigger === 'new_lead') {
      const rows = q.all(
        `SELECT l.*, l.id AS lead_id FROM leads l
          WHERE l.stage NOT IN ('won','lost') AND l.created_at <= datetime('now', ?)`, delay);
      for (const lead of rows) {
        if (alreadyFired(auto.id, 'leads', lead.lead_id)) continue;
        const contact = { id: lead.customer_id, name: lead.name, phone: lead.phone, email: lead.email };
        await fire(auto, 'leads', lead.lead_id, contact, { service: lead.service_type });
        fired++;
      }
    }

    if (auto.trigger === 'quote_sent') {
      const rows = q.all(
        `SELECT qu.*, c.id AS cid, c.name, c.phone, c.email, c.sms_opt_out, c.email_opt_out
           FROM quotes qu JOIN customers c ON c.id = qu.customer_id
          WHERE qu.status = 'sent' AND qu.sent_at IS NOT NULL AND qu.sent_at <= datetime('now', ?)`, delay);
      for (const row of rows) {
        if (alreadyFired(auto.id, 'quotes', row.id)) continue;
        await fire(auto, 'quotes', row.id,
          { id: row.cid, name: row.name, phone: row.phone, email: row.email },
          { quote_title: row.title });
        fired++;
      }
    }

    if (auto.trigger === 'job_reminder') {
      // fires for jobs happening tomorrow (or today if delay 0 and same-day)
      const rows = q.all(
        `SELECT j.*, c.id AS cid, c.name, c.phone, c.email
           FROM jobs j JOIN customers c ON c.id = j.customer_id
          WHERE j.status = 'scheduled' AND j.date != '' AND j.date = date('now', '+1 day')`);
      for (const row of rows) {
        if (alreadyFired(auto.id, 'jobs', row.id)) continue;
        await fire(auto, 'jobs', row.id,
          { id: row.cid, name: row.name, phone: row.phone, email: row.email },
          { job_title: row.title, job_date: row.date, job_time: row.time_start, address: row.address });
        fired++;
      }
    }

    if (auto.trigger === 'job_completed') {
      const rows = q.all(
        `SELECT j.*, c.id AS cid, c.name, c.phone, c.email
           FROM jobs j JOIN customers c ON c.id = j.customer_id
          WHERE j.status = 'complete' AND j.completed_at IS NOT NULL
            AND j.completed_at <= datetime('now', ?)`, delay);
      for (const row of rows) {
        if (alreadyFired(auto.id, 'jobs', row.id)) continue;
        await fire(auto, 'jobs', row.id,
          { id: row.cid, name: row.name, phone: row.phone, email: row.email },
          { job_title: row.title });
        fired++;
      }
    }

    if (auto.trigger === 'invoice_overdue') {
      const rows = q.all(
        `SELECT i.*, c.id AS cid, c.name, c.phone, c.email
           FROM invoices i JOIN customers c ON c.id = i.customer_id
          WHERE i.status IN ('sent','overdue') AND i.due_date != '' AND i.due_date < date('now')`);
      for (const row of rows) {
        q.run(`UPDATE invoices SET status = 'overdue' WHERE id = ? AND status = 'sent'`, row.id);
        if (alreadyFired(auto.id, 'invoices', row.id)) continue;
        await fire(auto, 'invoices', row.id,
          { id: row.cid, name: row.name, phone: row.phone, email: row.email },
          { invoice_number: row.number, due_date: row.due_date, payment_link: row.payment_link });
        fired++;
      }
    }

    if (auto.trigger === 'review_request') {
      const rows = q.all(
        `SELECT r.*, c.name, c.phone, c.email
           FROM review_requests r JOIN customers c ON c.id = r.customer_id
          WHERE r.status = 'queued' AND r.created_at <= datetime('now', ?)`, delay);
      for (const row of rows) {
        const contact = { id: row.customer_id, name: row.name, phone: row.phone, email: row.email };
        const result = await fire(auto, 'review_requests', row.id, contact, {});
        const log = q.get(
          `SELECT status FROM send_log WHERE ref_table = 'review_requests' AND ref_id = ? ORDER BY id DESC`, row.id);
        q.run(
          `UPDATE review_requests SET status = ?, sent_at = datetime('now') WHERE id = ?`,
          log?.status === 'sent' ? 'sent' : (log?.status || 'dry_run'), row.id);
        fired++;
      }
    }
  }

  // keep overdue statuses fresh even with no automation configured
  q.run(`UPDATE invoices SET status = 'overdue'
          WHERE status = 'sent' AND due_date != '' AND due_date < date('now')`);
  q.run(`UPDATE quotes SET status = 'expired'
          WHERE status = 'sent' AND expires_on != '' AND expires_on < date('now')`);

  return fired;
}

export function startAutomationLoop() {
  const run = () => runAutomations().catch(err => console.error('[automations]', err.message));
  setTimeout(run, 5000);
  setInterval(run, 5 * 60 * 1000);
}
