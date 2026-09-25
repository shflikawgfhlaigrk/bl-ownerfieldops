import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import nodemailer from 'nodemailer';
import { emailMessage, sendEmail } from '../email.js';

const env = { SMTP_HOST: 'synthetic.invalid', SMTP_USER: 'sender@example.invalid', SMTP_PASS: 'synthetic-only', SMTP_FROM: 'Service Team <sender@example.invalid>' };
const to = 'recipient@example.invalid';

test('subjects, recipients and sender headers reject CR/LF and other controls before transport creation', async () => {
  let transports = 0;
  const createTransport = () => { transports++; throw new Error('Transport must not be created'); };
  for (const control of ['\r\n', '\r', '\n', '\0', '\u0085', '\u2028']) {
    const injection = `${control}Reply-To: redirected@example.invalid`;
    await assert.rejects(sendEmail(to, 'Reminder' + injection, 'Body', { env, createTransport }), /Invalid email subject/);
    await assert.rejects(sendEmail(to + injection, 'Reminder', 'Body', { env, createTransport }), /Invalid email recipient/);
    await assert.rejects(sendEmail(to, 'Reminder', 'Body', { env: { ...env, SMTP_FROM: env.SMTP_FROM + injection }, createTransport }), /Invalid email sender/);
  }
  assert.equal(transports, 0);
});

test('address validation allows one mailbox and rejects groups, malformed domains and recipient lists', () => {
  for (const value of ['', 'no-address', 'a@example.invalid,b@example.invalid', 'Group: a@example.invalid;', 'x@@example.invalid', '.x@example.invalid', 'x..y@example.invalid', 'x@-bad.invalid', 'x@example..invalid', 'x@example.invalid/path', 'x@example.invalid?query', 'x@example.invalid#fragment', 'x@example.invalid%2fpath']) {
    assert.throws(() => emailMessage(env.SMTP_FROM, value, 'Subject', 'Body'), /Invalid email recipient/, value);
  }
  const message = emailMessage('Équipe <service@example.invalid>', 'Client <first.last+tag@bücher.example>', 'Réparation ✓', 'Bonjour');
  assert.equal(message.from.name, 'Équipe');
  assert.equal(message.to.address, 'first.last+tag@xn--bcher-kva.example');
  assert.deepEqual(message.envelope.to, ['first.last+tag@xn--bcher-kva.example']);
  assert.equal(emailMessage(env.SMTP_FROM, '"x@y"@example.invalid', '', '').to.address, '"x@y"@example.invalid');
});

test('configured mail uses required TLS, bounded timeouts and library message serialization', async () => {
  for (const port of ['587', '465']) {
    let settings;
    const info = await sendEmail(to, 'Réparation ✓', 'Body\nReply-To: stays-in-body@example.invalid\n.\n..', {
      env: { ...env, SMTP_PORT: port },
      createTransport(options) {
        settings = options;
        return nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
      },
    });
    assert.equal(settings.secure, port === '465');
    assert.equal(settings.requireTLS, port !== '465');
    assert.equal(settings.socketTimeout, 15000);
    assert.equal(settings.pool, false);
    assert.equal(settings.disableFileAccess, true);
    assert.equal(settings.disableUrlAccess, true);
    const raw = info.message.toString();
    const headers = raw.split('\r\n\r\n')[0];
    assert.match(headers, /Subject: =\?UTF-8\?/i);
    assert.doesNotMatch(headers, /^Reply-To:/mi);
    assert.match(raw, /\r\n\r\nBody/);
    assert.deepEqual(info.envelope.to, [to]);
  }
});

test('SMTP errors are returned once and the transport is closed without retry', async () => {
  let sends = 0, closed = 0;
  await assert.rejects(sendEmail(to, 'Reminder', 'Body', {
    env, createTransport: () => ({
      async sendMail() { sends++; throw new Error('Synthetic SMTP rejection'); },
      close() { closed++; },
    }),
  }), /Synthetic SMTP rejection/);
  assert.equal(sends, 1);
  assert.equal(closed, 1);
});

test('real Nodemailer SMTP DATA escapes first-dot and internal-dot lines against a local fake server', async () => {
  const messages = [], commands = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '', inData = false, lines = [];
    socket.write('220 synthetic test SMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') { messages.push(lines); lines = []; inData = false; socket.write('250 synthetic message accepted\r\n'); }
          else lines.push(line);
        } else {
          commands.push(line);
          if (line.startsWith('EHLO')) socket.write('250 synthetic test server\r\n');
          else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 OK\r\n');
          else if (line === 'DATA') { inData = true; socket.write('354 End with dot\r\n'); }
          else if (line === 'QUIT') socket.end('221 Bye\r\n');
          else socket.write('500 unexpected command\r\n');
        }
      }
    });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const info = await sendEmail(to, 'Dot test', '.\r\n.leading\n.\n..\nLast line', {
      env,
      createTransport(options) {
        assert.equal(options.requireTLS, true);
        // Only this synthetic test transport permits plaintext on loopback.
        return nodemailer.createTransport({ ...options, host: '127.0.0.1', port: server.address().port,
          auth: undefined, secure: false, requireTLS: false, ignoreTLS: true });
      },
    });
    assert.deepEqual(info.accepted, [to]);
    assert.equal(messages.length, 1);
    const lines = messages[0];
    assert.deepEqual(lines.slice(lines.indexOf('') + 1), ['..', '..leading', '..', '...', 'Last line']);
    assert.equal(commands.filter(x => x === 'DATA').length, 1);
    assert.equal(commands.filter(x => x.startsWith('RCPT TO:')).length, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
