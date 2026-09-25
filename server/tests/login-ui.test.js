import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const code = readFileSync(new URL('../../public/js/login.js', import.meta.url), 'utf8');
function page(search, result) {
  const ids = ['role', 'login', 'ownerField', 'workerFields', 'password', 'workerId', 'pin', 'submit', 'error'];
  const nodes = Object.fromEntries(ids.map(id => [id, { value: id === 'role' ? 'owner' : '', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } }]));
  const calls = [], redirects = [];
  runInNewContext(code, {
    document: { getElementById: id => nodes[id] }, URLSearchParams,
    location: { search, replace: url => redirects.push(url) },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: result.ok, json: async () => result.body }; },
  });
  return { nodes, calls, redirects, submit: () => nodes.login.handlers.submit({ preventDefault() {} }) };
}

test('owner and worker forms submit credentials and redirect only after successful server sign-in', async () => {
  const owner = page('', { ok: true, body: { role: 'owner' } });
  owner.nodes.password.value = 'synthetic-only';
  await owner.submit();
  assert.equal(owner.calls[0].url, '/api/auth/login');
  assert.deepEqual(JSON.parse(owner.calls[0].options.body), { password: 'synthetic-only' });
  assert.deepEqual(owner.redirects, ['/#/']);
  const worker = page('?worker=1', { ok: true, body: { id: 4 } });
  assert.equal(worker.nodes.ownerField.hidden, true);
  worker.nodes.workerId.value = '4'; worker.nodes.pin.value = '1234';
  await worker.submit();
  assert.equal(worker.calls[0].url, '/api/worker-login');
  assert.deepEqual(JSON.parse(worker.calls[0].options.body), { worker_id: '4', pin: '1234' });
  assert.deepEqual(worker.redirects, ['/#/worker']);
});

test('failed sign-in stays on the form and displays server feedback as text', async () => {
  const attempt = page('', { ok: false, body: { error: '<img src=x onerror=alert(1)>' } });
  await attempt.submit();
  assert.equal(attempt.nodes.error.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(attempt.nodes.error.innerHTML, undefined);
  assert.deepEqual(attempt.redirects, []);
  assert.equal(attempt.nodes.submit.disabled, false);
});
