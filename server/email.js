import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import { domainToASCII } from 'node:url';

function header(value, label) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value)) {
    throw new Error(`Invalid email ${label}`);
  }
  return value;
}

function mailbox(value, label) {
  const parsed = addressparser(header(value, label));
  if (parsed.length !== 1 || parsed[0].group || !parsed[0].address) throw new Error(`Invalid email ${label}`);
  const { address, name } = parsed[0];
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const rawDomain = address.slice(at + 1);
  // IDNA uses URL host parsing; reject URL delimiters before conversion so a
  // malformed mailbox cannot be silently shortened to a different address.
  if (/[\/\\:@?#%\[\]\s]/u.test(rawDomain)) throw new Error(`Invalid email ${label}`);
  const domain = domainToASCII(rawDomain);
  // One concrete mailbox, with a valid ASCII local part (dot-atom or quoted)
  // and DNS domain. Unicode display names and IDN domains remain supported.
  const atom = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const quoted = /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])+"$/;
  if (at < 1 || local.length > 64 || (!atom.test(local) && !quoted.test(local)) ||
      !domain || domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      Buffer.byteLength(`${local}@${domain}`) > 254) throw new Error(`Invalid email ${label}`);
  return { name: name || '', address: `${local}@${domain}` };
}

// Validation precedes transport creation, including for a configured sender.
export function emailMessage(from, to, subject, body) {
  const sender = mailbox(from, 'sender');
  const recipient = mailbox(to, 'recipient');
  return {
    from: sender,
    to: recipient,
    envelope: { from: sender.address, to: [recipient.address] },
    subject: header(subject, 'subject'),
    text: String(body ?? ''),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export async function sendEmail(to, subject, body, { env = process.env, createTransport = nodemailer.createTransport } = {}) {
  const message = emailMessage(env.SMTP_FROM || env.SMTP_USER, to, subject, body);
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP port');
  const transport = createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
    pool: false,
  });
  try {
    return await transport.sendMail(message);
  } finally {
    transport.close();
  }
}
