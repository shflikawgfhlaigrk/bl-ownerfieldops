import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, unlinkSync, readdirSync, lstatSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, q, DATA_DIR, UPLOADS_DIR } from './db.js';

const error = (message, status = 400) => Object.assign(new Error(message), { status });
function limit(name, fallback) {
  const value = Number(process.env[`OFO_PHOTO_${name}`] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw error('Photo storage limit is misconfigured.', 503);
  return value;
}

export function photoPath(filename) {
  if (typeof filename !== 'string' || filename !== path.basename(filename) || filename.startsWith('.') || !/\.(png|jpe?g|webp|heic)$/i.test(filename)) throw error('Photo not found.', 404);
  return path.join(UPLOADS_DIR, filename);
}

function inventory() {
  const files = new Map();
  for (const entry of readdirSync(UPLOADS_DIR)) {
    if (entry === '.gitkeep') continue;
    const stat = lstatSync(path.join(UPLOADS_DIR, entry));
    if (!stat.isFile() || stat.isSymbolicLink()) throw error('Photo storage requires review.', 503);
    files.set(entry, stat.size);
  }
  return files;
}

function budget(job, bytes) {
  const files = inventory();
  const rows = q.all('SELECT p.filename, p.job_id, j.customer_id FROM photos p JOIN jobs j ON j.id = p.job_id');
  const check = (count, size, maxCount, maxBytes) => {
    if (count + 1 > maxCount || size + bytes > maxBytes) throw error('Photo storage limit reached. Remove unneeded photos before uploading more.', 413);
  };
  check(new Set([...files.keys(), ...rows.map(row => row.filename)]).size, [...files.values()].reduce((a, b) => a + b, 0), limit('GLOBAL_COUNT', 10000), limit('GLOBAL_BYTES', 10 * 1024 ** 3));
  const scoped = (filter, prefix, count, size) => {
    const relevant = rows.filter(filter);
    check(relevant.length, relevant.reduce((sum, row) => sum + (files.get(row.filename) || 0), 0), limit(`${prefix}_COUNT`, count), limit(`${prefix}_BYTES`, size));
  };
  scoped(row => row.job_id === job.id, 'JOB', 50, 200 * 1024 ** 2);
  if (job.customer_id) scoped(row => row.customer_id === job.customer_id, 'CUSTOMER', 300, 1024 ** 3);
  const reserve = limit('RESERVE_BYTES', 512 * 1024 ** 2);
  for (const directory of new Set([UPLOADS_DIR, DATA_DIR])) {
    const stat = statfsSync(directory);
    if (stat.bavail * stat.bsize - bytes < reserve) throw error('Photo storage is low on free space.', 507);
  }
}

export function storePhoto(jobId, data, kind, uploadedBy, access) {
  const match = typeof data === 'string' && data.match(/^data:image\/(png|jpe?g|webp|heic);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0) throw error('Upload a valid png/jpg/webp/heic image data URL.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64') !== match[2]) throw error('Invalid image encoding.');
  if (bytes.length > limit('FILE_BYTES', 15 * 1024 ** 2)) throw error('Photo too large.', 413);
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const filename = `${randomUUID()}.${extension}`;
  let written = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const job = q.get('SELECT id, customer_id FROM jobs WHERE id = ?', jobId);
    if (!job) throw error('Job not found.', 404);
    const owner = access?.auth?.role === 'owner';
    const worker = access?.auth?.role === 'worker' && q.get('SELECT 1 FROM job_workers WHERE worker_id = ? AND job_id = ?', access.auth.worker.id, job.id);
    if (!(owner || worker || (access?.customerId && access.customerId === job.customer_id))) throw error('Job not found.', 404);
    // SQLite's writer lock covers inventory, budget check, file creation and
    // metadata commit, including other service processes using this database.
    budget(job, bytes.length);
    writeFileSync(photoPath(filename), bytes, { flag: 'wx', mode: 0o600 });
    written = true;
    const result = q.run('INSERT INTO photos (job_id, kind, filename, uploaded_by) VALUES (?, ?, ?, ?)',
      job.id, ['before', 'after', 'other'].includes(kind) ? kind : 'other', filename, String(uploadedBy || ''));
    const row = q.get('SELECT * FROM photos WHERE id = ?', result.lastInsertRowid);
    db.exec('COMMIT');
    return row;
  } catch (err) {
    db.exec('ROLLBACK');
    if (written) unlinkSync(photoPath(filename));
    throw err;
  }
}

export function removePhoto(id) {
  let committed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const photo = q.get('SELECT * FROM photos WHERE id = ?', id);
    if (!photo) throw error('Photo not found.', 404);
    const filename = photoPath(photo.filename);
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw error('Photo storage requires review.', 503);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    // Commit metadata first. A process interruption leaves an orphan file,
    // which remains counted by the global budget and is never downloadable.
    q.run('DELETE FROM photos WHERE id = ?', id);
    db.exec('COMMIT');
    committed = true;
    try { unlinkSync(filename); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  } catch (err) {
    if (!committed) db.exec('ROLLBACK');
    throw err;
  }
}

export function servePhoto(req, res, photo, customerId = null) {
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });
  const job = q.get('SELECT customer_id FROM jobs WHERE id = ?', photo.job_id);
  const owner = req.auth?.role === 'owner';
  const worker = req.auth?.role === 'worker' && q.get('SELECT 1 FROM job_workers WHERE job_id = ? AND worker_id = ?', photo.job_id, req.auth.worker.id);
  const allowed = customerId !== null ? job?.customer_id === customerId : owner || worker;
  if (!job || !allowed) return res.status(404).json({ error: 'Photo not found.' });
  let fd;
  try {
    fd = openSync(photoPath(photo.filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit('FILE_BYTES', 15 * 1024 ** 2)) throw error('Photo not found.', 404);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type(path.extname(photo.filename));
    return res.send(readFileSync(fd));
  } catch (err) {
    if (['ENOENT', 'ELOOP'].includes(err.code) || err.status === 404) return res.status(404).json({ error: 'Photo not found.' });
    throw err;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function removeJob(id) {
  let committed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const paths = q.all('SELECT filename FROM photos WHERE job_id = ?', id).map(row => photoPath(row.filename));
    q.run('DELETE FROM jobs WHERE id = ?', id);
    db.exec('COMMIT');
    committed = true;
    for (const filename of paths) {
      try { unlinkSync(filename); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  } catch (err) {
    if (!committed) db.exec('ROLLBACK');
    throw err;
  }
}
