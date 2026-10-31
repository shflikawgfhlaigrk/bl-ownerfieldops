import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

// Exercise the real entrypoint with empty temporary data and no mail credentials.
test('server serves empty data and rejects malformed JSON', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ownerfieldops-test-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: new URL('../../', import.meta.url),
    env: { PATH: process.env.PATH, PORT: String(port), OFO_DB_PATH: path.join(dir, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let startupTimer;
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  try {
    await new Promise((resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error(`server startup timed out: ${logs}`)), 5000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('is running')) resolve(); });
      child.once('exit', code => reject(new Error(`server exited ${code}: ${logs}`)));
    });
    clearTimeout(startupTimer);
    const base = `http://127.0.0.1:${port}`;
    const customers = await fetch(`${base}/api/customers`);
    assert.equal(customers.status, 200);
    assert.deepEqual(await customers.json(), []);
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/customers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })).status, 400);
  } finally {
    clearTimeout(startupTimer);
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
