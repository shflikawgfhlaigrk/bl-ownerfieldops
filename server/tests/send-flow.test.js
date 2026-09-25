import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';

const scratch = mkdtempSync(path.join(tmpdir(), 'ofo-send-flow-'));
process.env.OFO_DB_PATH = path.join(scratch, 'test.db');
Object.assign(process.env, { SMTP_HOST: 'synthetic.invalid', SMTP_USER: 'sender@example.invalid', SMTP_PASS: 'synthetic-only', SMTP_FROM: 'Sender <sender@example.invalid>', SMTP_PORT: '587' });
const { db, q, setSetting } = await import('../db.js');
const { dispatch } = await import('../send.js');
const { runAutomations } = await import('../automations.js');
const messages = [];
mock.method(nodemailer, 'createTransport', () => ({
  async sendMail(message) { messages.push(message); return { accepted: message.envelope.to, messageId: 'synthetic-only' }; },
  close() {},
}));
mock.method(globalThis, 'fetch', () => { throw new Error('External fetch forbidden in this test'); });
after(() => { mock.restoreAll(); db.close(); rmSync(scratch, { recursive: true, force: true }); });

test('dry-run, missing contact and opt-out remain recorded without SMTP activity', async () => {
  const row = await dispatch({ channel: 'email', to: 'recipient@example.invalid', body: 'Synthetic' });
  assert.equal(row.status, 'dry_run');
  assert.equal((await dispatch({ channel: 'email', to: '' })).status, 'skipped_no_contact');
  const customer = q.run(`INSERT INTO customers (name, email_opt_out) VALUES ('Synthetic', 1)`).lastInsertRowid;
  setSetting('dry_run', '0');
  assert.equal((await dispatch({ channel: 'email', to: 'recipient@example.invalid', customer_id: customer })).status, 'skipped_opt_out');
  assert.equal(messages.length, 0);
});

test('automation names with CRLF are logged as errors and never reach SMTP; valid automation works', async () => {
  setSetting('dry_run', '0');
  const id = q.run(`INSERT INTO automations (name, trigger, channel, template) VALUES (?, 'new_lead', 'email', 'Hello {first_name}')`, 'Reminder\r\nReply-To: redirected@example.invalid').lastInsertRowid;
  q.run(`INSERT INTO leads (name, email) VALUES ('Synthetic Person', 'recipient@example.invalid')`);
  await runAutomations();
  const rejected = q.get(`SELECT * FROM send_log WHERE automation_id = ? ORDER BY id DESC`, id);
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.error, 'Invalid email subject');
  assert.equal(messages.length, 0);
  q.run(`UPDATE automations SET name = 'Reminder' WHERE id = ?`, id);
  await runAutomations();
  const accepted = q.get(`SELECT * FROM send_log WHERE automation_id = ? ORDER BY id DESC`, id);
  assert.equal(accepted.status, 'sent'); // Synthetic SMTP acceptance only.
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, 'Reminder');
  assert.equal(messages[0].text, 'Hello Synthetic');
  await runAutomations();
  assert.equal(messages.length, 1, 'successful automation dedupe preserved');
});
