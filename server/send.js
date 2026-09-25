// Outbound SMS/email. Everything goes through the send_log ledger.
// With no Twilio/SMTP env vars (or Dry Run on in Settings), messages are
// logged as dry_run instead of sent — nothing goes out silently.
import { q, getSetting } from './db.js';
import { sendEmail } from './email.js';

export const smsConfigured = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);

export const emailConfigured = () =>
  !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

export const dryRunOn = () => getSetting('dry_run', '1') === '1';

export function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : m
  );
}

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/**
 * Send (or dry-run) one message and record it in the ledger.
 * opts: { channel, to, body, subject, customer_id, automation_id, trigger, ref_table, ref_id }
 * Returns the send_log row.
 */
export async function dispatch(opts) {
  const {
    channel = 'sms', to = '', body = '', subject = 'Message from your service provider',
    customer_id = null, automation_id = null, trigger = '', ref_table = '', ref_id = null,
  } = opts;

  let status = 'dry_run';
  let error = '';

  const customer = customer_id
    ? q.get(`SELECT sms_opt_out, email_opt_out FROM customers WHERE id = ?`, customer_id)
    : null;

  if (!to) {
    status = 'skipped_no_contact';
  } else if (customer && ((channel === 'sms' && customer.sms_opt_out) || (channel === 'email' && customer.email_opt_out))) {
    status = 'skipped_opt_out';
  } else if (dryRunOn() || (channel === 'sms' ? !smsConfigured() : !emailConfigured())) {
    status = 'dry_run';
  } else {
    try {
      if (channel === 'sms') await sendSms(to, body);
      else await sendEmail(to, subject, body);
      status = 'sent';
    } catch (e) {
      status = 'error';
      error = String(e.message || e).slice(0, 500);
    }
  }

  const r = q.run(
    `INSERT INTO send_log (automation_id, trigger, ref_table, ref_id, customer_id, channel, to_addr, body, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    automation_id, trigger, ref_table, ref_id, customer_id, channel, to, body, status, error
  );
  return q.get(`SELECT * FROM send_log WHERE id = ?`, r.lastInsertRowid);
}

/** Retry a failed ledger entry. */
export async function retrySend(logId) {
  const row = q.get(`SELECT * FROM send_log WHERE id = ?`, logId);
  if (!row) throw new Error('Send log entry not found');
  const result = await dispatch({
    channel: row.channel, to: row.to_addr, body: row.body,
    customer_id: row.customer_id, automation_id: row.automation_id,
    trigger: row.trigger, ref_table: row.ref_table, ref_id: row.ref_id,
  });
  q.run(`UPDATE send_log SET retries = retries + 1 WHERE id = ?`, logId);
  return result;
}
