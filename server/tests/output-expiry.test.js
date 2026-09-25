import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { csvEscape, toCsv, parseCsv } from '../routes/helpers.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'ofo-output-'));
process.env.OFO_DB_PATH = path.join(scratch, 'test.db');
const { db, q } = await import('../db.js');
const { portal } = await import('../routes/portal.js');
const { growth } = await import('../routes/growth.js');
const { money } = await import('../routes/money.js');
after(() => { db.close(); rmSync(scratch, { recursive: true, force: true }); });

// Run the actual route handler against isolated SQLite, without starting the
// service, its automation loop, or any network connection.
async function route(router, method, pattern, request = {}) {
  const layer = router.stack.find(x => x.route?.path === pattern && x.route.methods[method]);
  assert.ok(layer, pattern);
  const response = { statusCode: 200, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
  await layer.route.stack.at(-1).handle({ params: {}, body: {}, query: {}, ...request }, response);
  return response;
}

test('CSV formula prefixes including leading whitespace and controls are literal text', () => {
  for (const prefix of ['=', '+', '-', '@', '＝', '＋', '－', '＠']) {
    for (const lead of ['', ' ', '\t', '\r', '\n', '\u0000', '\u000b', '\ufeff', '\u200b', ' \t\r\n']) {
      const value = `${lead}${prefix}1+1`;
      assert.equal(parseCsv(toCsv([{ note: value }], ['note']))[1][0], `'${value}`);
    }
  }
});

test('CSV preserves numeric values, literal phone and signed strings, commas and line endings', () => {
  assert.equal(csvEscape(-12.5), '-12.5');
  assert.equal(csvEscape(0), '0');
  assert.equal(csvEscape(null), '');
  for (const value of ['+1 (555) 010-2000', '-12.50', '+42']) {
    assert.equal(parseCsv(toCsv([{ value }], ['value']))[1][0], `'${value}`);
  }
  const values = ['Plain name', 'comma, here', 'a "quote"', 'bare\rreturn', 'line\nfeed', 'both\r\nends'];
  assert.deepEqual(parseCsv(toCsv(values.map(value => ({ value })), ['value'])).slice(1), values.map(x => [x]));
  assert.deepEqual(parseCsv('a,b\r\n1,2\r3,4\n'), [['a','b'],['1','2'],['3','4']]);
});

test('CSV column headings use the same escaping and formula protection', () => {
  assert.deepEqual(parseCsv(toCsv([], ['=heading', 'comma,heading', 'line\rheading'])), [["'=heading", 'comma,heading', 'line\rheading']]);
});

test('actual prospect and payroll exports protect imported fields and worker, job and note text', async () => {
  q.run(`INSERT INTO prospects (company, phone, notes) VALUES (?, ?, ?)`, '=1+1', '+15550102000', '\t@SUM(1,2)');
  const prospect = await route(growth, 'get', '/prospects.csv');
  const cells = parseCsv(prospect.body);
  assert.equal(cells[1][0], "'=1+1");
  assert.equal(cells[1][3], "'+15550102000");
  assert.equal(cells[1][11], "'\t@SUM(1,2)");
  const worker = q.run(`INSERT INTO workers (name, hourly_rate) VALUES (?, 20)`, '=Worker').lastInsertRowid;
  const job = q.run(`INSERT INTO jobs (title) VALUES (?)`, '-Job').lastInsertRowid;
  q.run(`INSERT INTO time_entries (worker_id, job_id, clock_in, clock_out, notes) VALUES (?, ?, '2026-09-01 08:00:00', '2026-09-01 10:00:00', ?)`, worker, job, '\r+Note');
  const payroll = await route(money, 'get', '/payroll.csv', { query: { from: '2026-09-01', to: '2026-09-01' } });
  assert.deepEqual(parseCsv(payroll.body)[1], ["'=Worker", '2026-09-01 08:00:00', '2026-09-01 10:00:00', '2', '20', '40', "'-Job", "'\r+Note"]);
});

const token = 'synthetic-customer-portal-token';
const customerId = q.run(`INSERT INTO customers (name, portal_token) VALUES ('Test Customer', ?)`, token).lastInsertRowid;
const otherId = q.run(`INSERT INTO customers (name, portal_token) VALUES ('Other Customer', 'other-synthetic-customer-token')`).lastInsertRowid;
function quote(expires, status = 'sent', customer = customerId) {
  const leadId = q.run(`INSERT INTO leads (name, customer_id, stage) VALUES ('Synthetic lead', ?, 'quote_sent')`, customer).lastInsertRowid;
  const id = q.run(`INSERT INTO quotes (customer_id, lead_id, title, status, expires_on) VALUES (?, ?, 'Synthetic quote', ?, ?)`, customer, leadId, status, expires).lastInsertRowid;
  return { id, leadId };
}
const approve = (id, customerToken = token) => route(portal, 'post', '/portal-data/:token/approve-quote/:quoteId', { params: { token: customerToken, quoteId: String(id) }, body: { name: 'Approver' } });

test('expired sent quotes are rejected before the sweep, without approval or lead/activity side effects', async () => {
  const { id, leadId } = quote(q.get(`SELECT date('now', '-1 day') d`).d);
  const before = q.get(`SELECT count(*) n FROM activity`).n;
  assert.equal((await approve(id)).statusCode, 400);
  assert.deepEqual({ ...q.get(`SELECT status, approved_at, approval_name FROM quotes WHERE id = ?`, id) }, { status: 'sent', approved_at: null, approval_name: '' });
  assert.equal(q.get(`SELECT stage FROM leads WHERE id = ?`, leadId).stage, 'quote_sent');
  assert.equal(q.get(`SELECT count(*) n FROM activity`).n, before);
});

test('invalid nonempty expiry dates fail closed', async () => {
  for (const expires of ['tomorrow', '9999-99-99', '9999-02-30', '9999-2-01', ' ', '9999-01-01T00:00:00Z']) {
    const { id } = quote(expires);
    assert.equal((await approve(id)).statusCode, 400, expires);
    assert.equal(q.get(`SELECT status FROM quotes WHERE id = ?`, id).status, 'sent');
  }
});

test('today, future and no-expiry quotes approve once; duplicate approval is rejected', async () => {
  for (const expires of ['', null, q.get(`SELECT date('now') d`).d, q.get(`SELECT date('now', '+1 day') d`).d]) {
    const { id, leadId } = quote(expires);
    const before = q.get(`SELECT count(*) n FROM activity`).n;
    assert.equal((await approve(id)).statusCode, 200);
    const row = q.get(`SELECT * FROM quotes WHERE id = ?`, id);
    assert.equal(row.status, 'approved');
    assert.equal(row.approval_name, 'Approver');
    assert.ok(row.approved_at);
    assert.equal(q.get(`SELECT stage FROM leads WHERE id = ?`, leadId).stage, 'won');
    assert.equal((await approve(id)).statusCode, 400);
    assert.equal(q.get(`SELECT count(*) n FROM activity`).n, before + 1);
  }
});

test('invalid tokens, another customer and non-sent quote states cannot approve', async () => {
  assert.equal((await approve(quote('').id, 'invalid')).statusCode, 404);
  assert.equal((await approve(quote('', 'sent', otherId).id)).statusCode, 404);
  for (const status of ['draft', 'declined', 'expired', 'approved']) {
    const { id } = quote('', status);
    assert.equal((await approve(id)).statusCode, 400);
    assert.equal(q.get(`SELECT status FROM quotes WHERE id = ?`, id).status, status);
  }
});

test('approval rechecks expiry, sent state and ownership in its database update', async () => {
  const realGet = q.get;
  for (const mutation of ["expires_on = '2000-01-01'", "status = 'declined'", `customer_id = ${otherId}`]) {
    const { id, leadId } = quote('');
    q.get = (sql, ...args) => {
      const result = realGet(sql, ...args);
      if (/SELECT \* FROM quotes WHERE id/.test(sql)) q.run(`UPDATE quotes SET ${mutation} WHERE id = ?`, id);
      return result;
    };
    try { assert.equal((await approve(id)).statusCode, 400, mutation); }
    finally { q.get = realGet; }
    assert.equal(q.get(`SELECT stage FROM leads WHERE id = ?`, leadId).stage, 'quote_sent');
    assert.equal(q.get(`SELECT approved_at FROM quotes WHERE id = ?`, id).approved_at, null);
  }
});

test('an activity write failure rolls back quote approval and its lead transition', async () => {
  const { id, leadId } = quote('');
  const realRun = q.run;
  const originalError = console.error;
  q.run = (sql, ...args) => {
    if (/INSERT INTO activity/.test(sql)) throw new Error('Synthetic activity write failure');
    return realRun(sql, ...args);
  };
  console.error = () => {};
  try { assert.equal((await approve(id)).statusCode, 500); }
  finally { q.run = realRun; console.error = originalError; }
  assert.equal(q.get(`SELECT status FROM quotes WHERE id = ?`, id).status, 'sent');
  assert.equal(q.get(`SELECT stage FROM leads WHERE id = ?`, leadId).stage, 'quote_sent');
});
