// Small shared route utilities.
export const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(err.status || 500).json({ error: String(err.message || err) });
  });

export function pick(body, fields, defaults = {}) {
  const out = { ...defaults };
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

export function required(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || String(body[f]).trim() === '') {
      const err = new Error(`Missing required field: ${f}`);
      err.status = 400;
      throw err;
    }
  }
}

export function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','));
  return [header, ...lines].join('\n');
}

// Very small CSV parser (handles quoted fields with commas/newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
