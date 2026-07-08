// OwnerFieldOps database — built-in node:sqlite, one file in ./data.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOADS_DIR = path.join(ROOT, 'uploads');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new DatabaseSync(
  process.env.OFO_DB_PATH || path.join(DATA_DIR, 'ownerfieldops.db')
);

db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

// ---- schema (idempotent) ----
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  zip TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  referred_by INTEGER REFERENCES customers(id),
  portal_token TEXT UNIQUE,
  sms_opt_out INTEGER NOT NULL DEFAULT 0,
  email_opt_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT DEFAULT 'Main',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  zip TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note',     -- note | call | job | quote | invoice | message | system
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  source TEXT DEFAULT '',
  service_type TEXT DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'new',     -- new|contacted|estimate_scheduled|quote_sent|won|scheduled|lost
  value_estimate REAL DEFAULT 0,
  next_action TEXT DEFAULT '',
  next_action_date TEXT DEFAULT '',
  owner TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  lost_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id),
  customer_id INTEGER REFERENCES customers(id),
  title TEXT NOT NULL DEFAULT '',
  service_type TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',  -- draft|sent|approved|declined|expired
  notes TEXT DEFAULT '',
  discount REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  expires_on TEXT DEFAULT '',
  sent_at TEXT,
  approved_at TEXT,
  approval_name TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'labor',    -- labor | material | fee
  description TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  pin TEXT NOT NULL DEFAULT '',
  hourly_rate REAL NOT NULL DEFAULT 0,
  color TEXT DEFAULT '#2f6fed',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  service_type TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS checklist_template_items (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'required',  -- required | optional | photo
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  quote_id INTEGER REFERENCES quotes(id),
  title TEXT NOT NULL DEFAULT '',
  service_type TEXT DEFAULT '',
  date TEXT DEFAULT '',                  -- YYYY-MM-DD
  time_start TEXT DEFAULT '',            -- HH:MM
  time_end TEXT DEFAULT '',
  address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|in_progress|complete|canceled
  notes TEXT DEFAULT '',
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_workers (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, worker_id)
);

CREATE TABLE IF NOT EXISTS job_checklist_items (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'required',
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  job_id INTEGER REFERENCES jobs(id),
  clock_in TEXT NOT NULL DEFAULT (datetime('now')),
  clock_out TEXT,
  gps_in TEXT DEFAULT '',
  gps_out TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'before',   -- before | after | other
  filename TEXT NOT NULL,
  uploaded_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  job_id INTEGER REFERENCES jobs(id),
  quote_id INTEGER REFERENCES quotes(id),
  status TEXT NOT NULL DEFAULT 'draft',  -- draft|sent|paid|overdue|void
  issue_date TEXT NOT NULL DEFAULT (date('now')),
  due_date TEXT DEFAULT '',
  tax_rate REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  payment_link TEXT DEFAULT '',
  paid_at TEXT,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS review_requests (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  job_id INTEGER REFERENCES jobs(id),
  channel TEXT NOT NULL DEFAULT 'sms',   -- sms | email
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', -- queued|sent|dry_run|skipped|error
  error TEXT DEFAULT '',
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  referrer_id INTEGER REFERENCES customers(id),
  referred_id INTEGER REFERENCES customers(id),
  reward_amount REAL NOT NULL DEFAULT 0,
  reward_paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY,
  company TEXT NOT NULL DEFAULT '',
  contact TEXT DEFAULT '',
  title TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  website TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',    -- new|contacted|interested|customer|not_interested
  source TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  last_contacted TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,                 -- new_lead|quote_sent|job_reminder|job_completed|invoice_overdue|review_request
  channel TEXT NOT NULL DEFAULT 'sms',   -- sms | email
  delay_hours REAL NOT NULL DEFAULT 0,
  template TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS send_log (
  id INTEGER PRIMARY KEY,
  automation_id INTEGER REFERENCES automations(id),
  trigger TEXT DEFAULT '',
  ref_table TEXT DEFAULT '',             -- what fired it: leads|quotes|jobs|invoices|review_requests
  ref_id INTEGER,
  customer_id INTEGER REFERENCES customers(id),
  channel TEXT NOT NULL DEFAULT 'sms',
  to_addr TEXT DEFAULT '',
  body TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'dry_run',-- dry_run|sent|error|skipped_opt_out|skipped_no_contact
  error TEXT DEFAULT '',
  retries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT 'in',  -- in (from customer) | out (from business)
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(date);
CREATE INDEX IF NOT EXISTS idx_time_worker ON time_entries(worker_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_activity_customer ON activity(customer_id);
`);

// ---- default settings + starter checklist templates ----
const setCount = db.prepare(`SELECT COUNT(*) c FROM settings`).get().c;
if (setCount === 0) {
  const ins = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
  ins.run('business_name', 'My Service Business');
  ins.run('business_phone', '');
  ins.run('business_email', '');
  ins.run('business_address', '');
  ins.run('default_tax_rate', '0');
  ins.run('default_hourly_rate', '50');
  ins.run('review_link', '');
  ins.run('dry_run', '1'); // messages are logged, not sent, until the owner turns this off
  ins.run('invoice_terms_days', '14');
  ins.run('invoice_footer', 'Thank you for your business!');
}

const tplCount = db.prepare(`SELECT COUNT(*) c FROM checklist_templates`).get().c;
if (tplCount === 0) {
  const t = db.prepare(`INSERT INTO checklist_templates (name, service_type) VALUES (?, ?)`);
  const i = db.prepare(`INSERT INTO checklist_template_items (template_id, text, requirement, sort) VALUES (?, ?, ?, ?)`);
  const gen = t.run('Standard Job', '').lastInsertRowid;
  [
    ['Take before photos', 'photo'],
    ['Confirm scope with customer', 'required'],
    ['Complete the work', 'required'],
    ['Clean up the work area', 'required'],
    ['Take after photos', 'photo'],
    ['Walk through with customer', 'optional'],
  ].forEach(([text, req], idx) => i.run(gen, text, req, idx));
}

// ---- helpers ----
export const q = {
  get: (sql, ...args) => db.prepare(sql).get(...args),
  all: (sql, ...args) => db.prepare(sql).all(...args),
  run: (sql, ...args) => db.prepare(sql).run(...args),
};

export function getSetting(key, fallback = '') {
  const row = q.get(`SELECT value FROM settings WHERE key = ?`, key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  q.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, String(value ?? '')
  );
}

export function logActivity(customerId, kind, body) {
  if (!customerId) return;
  q.run(`INSERT INTO activity (customer_id, kind, body) VALUES (?, ?, ?)`, customerId, kind, body);
}

export function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
