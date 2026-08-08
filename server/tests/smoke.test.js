// Smoke test: the server boots against a scratch database and serves the real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 48211;

test('server boots, serves the UI, and 404s unknown API routes', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'ofo-test-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      OFO_DB_PATH: path.join(scratch, 'test.db'),
    },
    stdio: 'ignore',
  });

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/`);
        up = res.ok;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(up, `server did not come up on :${PORT}`);

    const page = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<!doctype html|<html/i);

    const api = await fetch(`http://127.0.0.1:${PORT}/api/definitely-not-a-route`);
    assert.equal(api.status, 404);
    const body = await api.json();
    assert.equal(body.error, 'Not found');
  } finally {
    child.kill('SIGTERM');
  }
});
