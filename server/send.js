// Outbound SMS/email. Everything goes through the send_log ledger.
// With no Twilio/SMTP env vars (or Dry Run on in Settings), messages are
// logged as dry_run instead of sent — nothing goes out silently.
import { q, getSetting } from './db.js';

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

// Minimal SMTP client (STARTTLS or implicit TLS) — no dependency needed.
async function sendEmail(to, subject, body) {
  const net = await import('node:net');
  const tls = await import('node:tls');
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;
  const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];

  return new Promise((resolve, reject) => {
    let socket = port === 465
      ? tls.connect(port, host, { servername: host })
      : net.connect(port, host);
    let buffer = '';
    let steps = [];
    let stepIdx = 0;
    const fail = (err) => { try { socket.destroy(); } catch {} ; reject(err); };
    const write = (line) => socket.write(line + '\r\n');

    const buildSteps = () => {
      steps = [
        { expect: 220, send: `EHLO ownerfieldops.local` },
        ...(port !== 465 && !socket.encrypted ? [
          { expect: 250, send: `STARTTLS` },
          { expect: 220, send: null, upgrade: true },
          { expect: null, send: `EHLO ownerfieldops.local` },
        ] : []),
        { expect: 250, send: `AUTH LOGIN` },
        { expect: 334, send: Buffer.from(user).toString('base64') },
        { expect: 334, send: Buffer.from(pass).toString('base64') },
        { expect: 235, send: `MAIL FROM:<${fromAddr}>` },
        { expect: 250, send: `RCPT TO:<${to}>` },
        { expect: 250, send: `DATA` },
        { expect: 354, send:
          `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n` +
          `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n` +
          body.replace(/\r?\n\./g, '\n..') + `\r\n.` },
        { expect: 250, send: `QUIT`, done: true },
      ];
    };

    const attach = (sock) => {
      socket = sock;
      socket.setTimeout(15000, () => fail(new Error('SMTP timeout')));
      socket.on('error', fail);
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        // process complete final reply lines ("250 " not "250-")
        if (!/^\d{3} [^]*\r\n$/m.test(buffer) && !/\r\n$/.test(buffer)) return;
        const lines = buffer.split('\r\n').filter(Boolean);
        const last = lines[lines.length - 1];
        if (/^\d{3}-/.test(last)) return; // multiline reply still coming
        buffer = '';
        const code = Number(last.slice(0, 3));
        const step = steps[stepIdx];
        if (!step) return;
        if (step.expect && code !== step.expect) return fail(new Error(`SMTP ${code}: ${last}`));
        stepIdx++;
        if (step.upgrade) {
          const clear = socket;
          clear.removeAllListeners('data');
          const secure = tls.connect({ socket: clear, servername: host });
          secure.once('secureConnect', () => {
            attach(secure);
            write(steps[stepIdx].send);
            stepIdx++;
          });
          secure.on('error', fail);
          return;
        }
        if (step.done) { socket.end(); return resolve(); }
        const next = steps[stepIdx - 1];
        if (next && next.send) write(next.send);
      });
    };

    socket.once(port === 465 ? 'secureConnect' : 'connect', () => {
      buildSteps();
      attach(socket);
    });
    socket.on('error', fail);
  });
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
