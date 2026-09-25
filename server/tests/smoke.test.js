// Real HTTP on ephemeral loopback and synthetic SQLite; no child process, .env loading or automation loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('server serves the UI, 404s unknown API routes and protects exports and expired approval over HTTP', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'ofo-test-'));
  process.env.OFO_DB_PATH = path.join(scratch, 'test.db');
  process.env.OFO_OWNER_PASSWORD = 'synthetic-smoke-password';
  const { app } = await import('../server.js');
  const { db, q } = await import('../db.js');
  let server;
  try {
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const PORT = server.address().port;

    const page = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<!doctype html|<html/i);
    const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.OFO_OWNER_PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const api = await fetch(`http://127.0.0.1:${PORT}/api/definitely-not-a-route`, { headers: { Cookie: cookie } });
    assert.equal(api.status, 404);
    const body = await api.json();
    assert.equal(body.error, 'Not found');
    const token = 'synthetic-http-customer-token';
    const customer = q.run(`INSERT INTO customers (name, portal_token) VALUES ('HTTP Customer', ?)`, token).lastInsertRowid;
    const id = q.run(`INSERT INTO quotes (customer_id, status, expires_on) VALUES (?, 'sent', '2000-01-01')`, customer).lastInsertRowid;
    const approve = await fetch(`http://127.0.0.1:${PORT}/api/portal-data/${token}/approve-quote/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic Approver' }),
    });
    assert.equal(approve.status, 400);
    assert.match((await approve.json()).error, /no longer/);
    assert.equal(q.get(`SELECT status FROM quotes WHERE id = ?`, id).status, 'sent');
    q.run(`INSERT INTO prospects (company) VALUES ('=1+1')`);
    const csv = await fetch(`http://127.0.0.1:${PORT}/api/prospects.csv`, { headers: { Cookie: cookie } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(await csv.text(), /\n'=1\+1,/);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
