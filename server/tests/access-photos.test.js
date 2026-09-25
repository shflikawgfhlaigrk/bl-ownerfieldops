import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scratch = mkdtempSync(path.join(tmpdir(), 'ofo-access-'));
process.env.OFO_DB_PATH = path.join(scratch, 'test.db');
process.env.OFO_OWNER_PASSWORD = 'synthetic-owner-password-only';
const { app } = await import('../server.js');
const { db, q, UPLOADS_DIR } = await import('../db.js');
const { storePhoto } = await import('../photos.js');
const tokenA = 'synthetic-customer-a-token', tokenB = 'synthetic-customer-b-token';
const customerA = q.run('INSERT INTO customers (name, portal_token) VALUES (?, ?)', 'Customer A', tokenA).lastInsertRowid;
const customerB = q.run('INSERT INTO customers (name, portal_token) VALUES (?, ?)', 'Customer B', tokenB).lastInsertRowid;
const workerA = q.run("INSERT INTO workers (name, pin) VALUES ('Worker A', '123456')").lastInsertRowid;
const workerB = q.run("INSERT INTO workers (name, pin) VALUES ('Worker B', '654321')").lastInsertRowid;
const jobA = q.run("INSERT INTO jobs (customer_id, title) VALUES (?, 'Job A')", customerA).lastInsertRowid;
const jobB = q.run("INSERT INTO jobs (customer_id, title) VALUES (?, 'Job B')", customerB).lastInsertRowid;
q.run('INSERT INTO job_workers (job_id, worker_id) VALUES (?, ?)', jobA, workerA);
q.run('INSERT INTO job_workers (job_id, worker_id) VALUES (?, ?)', jobB, workerB);
const png = 'data:image/png;base64,iVBORw0KGgo='; // Synthetic signature bytes only.
const ownerAccess = { auth: { role: 'owner' } };
let server, base, ownerCookie, workerCookie;
async function request(url, { cookie, method = 'GET', body, headers = {} } = {}) {
  return fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function login(body, worker = false) {
  const response = await request(worker ? '/api/worker-login' : '/api/auth/login', { method: 'POST', body });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i);
  return cookie.split(';')[0];
}
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  ownerCookie = await login({ password: process.env.OFO_OWNER_PASSWORD });
  workerCookie = await login({ worker_id: workerA, pin: '123456' }, true);
});
after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  db.close(); rmSync(scratch, { recursive: true, force: true });
});

test('every mounted privileged route denies anonymous requests; owner retains business reads and writes', async t => {
  let checked = 0;
  for (const name of ['crm', 'sales', 'ops', 'money', 'growth', 'misc']) {
    const router = (await import(`../routes/${name}.js`))[name];
    for (const layer of router.stack.filter(x => x.route)) {
      for (const method of Object.keys(layer.route.methods)) {
        const url = '/api' + layer.route.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '1');
        const response = await request(url, { method: method.toUpperCase(), body: ['get', 'head'].includes(method) ? undefined : {} });
        assert.equal(response.status, 401, `${method} ${url}`); checked++;
      }
    }
  }
  assert.ok(checked >= 60);
  t.diagnostic(`${checked} mounted privileged methods/paths denied anonymous access`);
  assert.equal((await request('/api/customers', { cookie: ownerCookie })).status, 200);
  assert.equal((await request('/api/customers', { cookie: ownerCookie, method: 'POST', body: { name: 'Owner-created' } })).status, 200);
  assert.equal((await request('/api/settings', { cookie: workerCookie })).status, 403);
  assert.equal((await request('/api/payroll.csv', { cookie: workerCookie })).status, 403);
  assert.equal((await request('/api/customers', { headers: { Authorization: 'Bearer ' + 'a'.repeat(64), 'X-Role': 'owner' } })).status, 401);
});

test('cross-origin writes and forged worker identities cannot mutate business records', async () => {
  assert.equal((await request('/api/customers', { method: 'POST', cookie: ownerCookie, headers: { Origin: 'https://unrelated.invalid' }, body: { name: 'forged' } })).status, 403);
  assert.equal((await request('/api/clock-in', { cookie: workerCookie, method: 'POST', body: { worker_id: workerB, job_id: jobB } })).status, 403);
  assert.equal((await request('/api/clock-in', { cookie: workerCookie, method: 'POST', body: { job_id: jobB } })).status, 403);
  assert.equal((await request('/api/clock-status/' + workerB, { cookie: workerCookie })).status, 403);
  assert.equal(q.get('SELECT count(*) n FROM time_entries').n, 0);
});

test('worker jobs, clock and checklist stay scoped while owner can select another active worker', async () => {
  const jobs = await (await request('/api/jobs', { cookie: workerCookie })).json();
  assert.deepEqual(jobs.map(x => x.id), [jobA]);
  assert.equal((await request(`/api/jobs?worker_id=${workerB}`, { cookie: workerCookie })).status, 403);
  assert.equal((await request(`/api/jobs/${jobB}`, { cookie: workerCookie })).status, 403);
  const detail = await (await request(`/api/jobs/${jobA}`, { cookie: workerCookie })).json();
  assert.equal(detail.portal_token, undefined);
  assert.equal((await request(`/api/jobs/${jobA}`, { cookie: workerCookie, method: 'PUT', body: { customer_id: customerB } })).status, 403);
  const note = await request(`/api/jobs/${jobA}`, { cookie: workerCookie, method: 'PUT', body: { notes: 'Updated from crew' } });
  assert.equal(note.status, 200); assert.equal((await note.json()).portal_token, undefined);
  const item = q.run("INSERT INTO job_checklist_items (job_id, text) VALUES (?, 'Test item')", jobA).lastInsertRowid;
  assert.equal((await request(`/api/checklist-items/${item}`, { cookie: workerCookie, method: 'PUT', body: { done: true } })).status, 200);
  const clockIn = await request('/api/clock-in', { cookie: workerCookie, method: 'POST', body: { job_id: jobA } });
  assert.equal(clockIn.status, 200); assert.equal((await clockIn.json()).worker_id, workerA);
  assert.equal((await request('/api/clock-out', { cookie: workerCookie, method: 'POST', body: {} })).status, 200);
  assert.equal((await request('/api/clock-in', { cookie: ownerCookie, method: 'POST', body: { worker_id: workerB, job_id: jobA } })).status, 200);
  assert.equal((await request('/api/clock-out', { cookie: ownerCookie, method: 'POST', body: { worker_id: workerB } })).status, 200);
});

test('legacy photo URLs require sessions and customer photo URLs enforce matching ownership', async () => {
  const photo = storePhoto(jobA, png, 'before', 'Owner', ownerAccess);
  assert.equal(statSync(path.join(UPLOADS_DIR, photo.filename)).mode & 0o777, 0o600);
  const url = `/uploads/${photo.filename}`;
  assert.equal((await request(url)).status, 401);
  for (const cookie of [ownerCookie, workerCookie]) {
    const response = await request(url, { cookie });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal((await response.arrayBuffer()).byteLength, 8);
  }
  const other = storePhoto(jobB, png, 'before', 'Owner', ownerAccess);
  assert.equal((await request(`/uploads/${other.filename}`, { cookie: workerCookie })).status, 404);
  assert.equal((await request(`/api/portal-data/${tokenA}/photos/${photo.id}`)).status, 200);
  assert.equal((await request(`/api/portal-data/${tokenB}/photos/${photo.id}`)).status, 404);
  assert.equal((await request(`/api/portal-data/${tokenB}/photos/${photo.id}`, { cookie: ownerCookie })).status, 404);
  const data = await (await request(`/api/portal-data/${tokenA}`)).json();
  assert.ok(data.jobs[0].photos[0].url.includes(tokenA));
  const deniedUpload = await request(`/api/portal-data/${tokenA}/photos`, { method: 'POST', body: { data: png, job_id: jobB } });
  assert.equal(deniedUpload.status, 400);
  const workerUpload = await request(`/api/jobs/${jobA}/photos`, { cookie: workerCookie, method: 'POST', body: { data: png, uploaded_by: 'forged owner' } });
  assert.equal(workerUpload.status, 200); assert.equal((await workerUpload.json()).uploaded_by, 'Worker A');
  const outside = path.join(scratch, 'outside.png'); writeFileSync(outside, 'outside');
  symlinkSync(outside, path.join(UPLOADS_DIR, 'symlink.png'));
  const bad = q.run("INSERT INTO photos (job_id, filename) VALUES (?, 'symlink.png')", jobA).lastInsertRowid;
  assert.equal((await request('/uploads/symlink.png', { cookie: ownerCookie })).status, 404);
  q.run('DELETE FROM photos WHERE id = ?', bad); unlinkSync(path.join(UPLOADS_DIR, 'symlink.png'));
});

test('cumulative count and byte limits apply to jobs, customers and global storage; deletion frees space', async () => {
  const job = q.run("INSERT INTO jobs (customer_id, title) VALUES (?, 'Quota job')", customerA).lastInsertRowid;
  process.env.OFO_PHOTO_JOB_COUNT = '2';
  const upload = () => request(`/api/portal-data/${tokenA}/photos`, { method: 'POST', body: { data: png, job_id: job } });
  const results = await Promise.all([upload(), upload(), upload()]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 200, 413]);
  const photo = q.get('SELECT * FROM photos WHERE job_id = ? ORDER BY id LIMIT 1', job);
  assert.equal((await request(`/api/photos/${photo.id}`, { cookie: ownerCookie, method: 'DELETE' })).status, 200);
  assert.ok(!readdirSync(UPLOADS_DIR).includes(photo.filename));
  assert.equal((await upload()).status, 200);
  delete process.env.OFO_PHOTO_JOB_COUNT;
  for (const [setting, value] of [['JOB_BYTES', '8'], ['CUSTOMER_BYTES', '8'], ['GLOBAL_BYTES', '8'], ['CUSTOMER_COUNT', '1'], ['GLOBAL_COUNT', '1'], ['RESERVE_BYTES', String(Number.MAX_SAFE_INTEGER)]]) {
    const before = q.get('SELECT count(*) n FROM photos').n, filesBefore = readdirSync(UPLOADS_DIR).length;
    process.env[`OFO_PHOTO_${setting}`] = value;
    try { assert.equal((await upload()).status, setting === 'RESERVE_BYTES' ? 507 : 413, setting); }
    finally { delete process.env[`OFO_PHOTO_${setting}`]; }
    assert.equal(q.get('SELECT count(*) n FROM photos').n, before);
    assert.equal(readdirSync(UPLOADS_DIR).length, filesBefore);
  }
});

test('failed metadata writes remove new files and retained orphan files consume global budget', () => {
  const filesBefore = readdirSync(UPLOADS_DIR);
  const realRun = q.run;
  q.run = (sql, ...args) => { if (sql.startsWith('INSERT INTO photos')) throw new Error('Synthetic metadata failure'); return realRun(sql, ...args); };
  try { assert.throws(() => storePhoto(jobA, png, 'before', 'Synthetic', ownerAccess), /Synthetic metadata failure/); }
  finally { q.run = realRun; }
  assert.deepEqual(readdirSync(UPLOADS_DIR), filesBefore);
  writeFileSync(path.join(UPLOADS_DIR, 'orphan.png'), Buffer.alloc(512));
  process.env.OFO_PHOTO_GLOBAL_BYTES = '512';
  try { assert.throws(() => storePhoto(jobB, png, 'before', 'Synthetic', ownerAccess), /storage limit/); }
  finally { delete process.env.OFO_PHOTO_GLOBAL_BYTES; unlinkSync(path.join(UPLOADS_DIR, 'orphan.png')); }
});

test('job deletion reclaims its photos, while blocked deletion preserves both job and bytes', async () => {
  const id = q.run("INSERT INTO jobs (title, customer_id) VALUES ('Delete fixture', ?)", customerA).lastInsertRowid;
  const photo = storePhoto(id, png, 'before', 'Owner', ownerAccess);
  assert.equal((await request(`/api/jobs/${id}`, { cookie: ownerCookie, method: 'DELETE' })).status, 200);
  assert.equal(q.get('SELECT count(*) n FROM photos WHERE job_id = ?', id).n, 0);
  assert.ok(!readdirSync(UPLOADS_DIR).includes(photo.filename));
  const retained = storePhoto(jobA, png, 'before', 'Owner', ownerAccess);
  assert.equal((await request(`/api/jobs/${jobA}`, { cookie: ownerCookie, method: 'DELETE' })).status, 500);
  assert.ok(q.get('SELECT id FROM jobs WHERE id = ?', jobA));
  assert.ok(readdirSync(UPLOADS_DIR).includes(retained.filename));
});

test('deactivation, PIN rotation, expiry and logout revoke session authority', async () => {
  q.run('UPDATE workers SET active = 0 WHERE id = ?', workerA);
  assert.equal((await request('/api/jobs', { cookie: workerCookie })).status, 401);
  q.run('UPDATE workers SET active = 1, pin = ? WHERE id = ?', 'new-pin-value', workerA);
  assert.equal((await request('/api/jobs', { cookie: workerCookie })).status, 401);
  workerCookie = await login({ worker_id: workerA, pin: 'new-pin-value' }, true);
  q.run("UPDATE auth_sessions SET expires_at = 0 WHERE role = 'worker'");
  assert.equal((await request('/api/jobs', { cookie: workerCookie })).status, 401);
  assert.equal((await request('/api/auth/logout', { cookie: ownerCookie, method: 'POST', body: {} })).status, 200);
  assert.equal((await request('/api/customers', { cookie: ownerCookie })).status, 401);
});

test('unconfigured owner access fails closed and sign-in guessing is rate limited', async () => {
  const password = process.env.OFO_OWNER_PASSWORD;
  delete process.env.OFO_OWNER_PASSWORD;
  try {
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { password } })).status, 503);
    assert.equal((await request('/api/customers', { cookie: ownerCookie })).status, 401);
  } finally { process.env.OFO_OWNER_PASSWORD = password; }
  const unconfiguredWorker = q.run("INSERT INTO workers (name) VALUES ('No PIN configured')").lastInsertRowid;
  assert.equal((await request('/api/worker-login', { method: 'POST', body: { worker_id: unconfiguredWorker, pin: '' } })).status, 401);
  const responses = [];
  for (let i = 0; i < 12; i++) responses.push(await request('/api/worker-login', { method: 'POST', body: { worker_id: workerB, pin: 'incorrect' } }));
  assert.ok(responses.some(x => x.status === 401));
  assert.ok(responses.some(x => x.status === 429));
  assert.ok(responses.every(x => [401, 429].includes(x.status)));
});
