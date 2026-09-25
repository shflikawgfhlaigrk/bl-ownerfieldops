// Small shared route utilities.
export const wrap = (fn) => (req, res) =>
  Promise.resolve().then(() => fn(req, res)).catch((err) => {
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
  let s = String(v ?? '');
  // Keep actual numbers numeric, but never treat user text (including signed
  // numbers and phone strings) as a spreadsheet formula. Prefix before CSV
  // quoting so whitespace, controls and embedded delimiters cannot bypass it.
  if (typeof v !== 'number' && /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','));
  return [header, ...lines].join('\n');
}

// Hard ceiling on how much pasted CSV we will scan (~10M chars is far more than
// any real import; it keeps the parse loop bounded no matter what is posted).
const MAX_CSV_CHARS = 10_000_000;

// Very small CSV parser (handles quoted fields with commas/newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '');
  const len = Math.min(s.length, MAX_CSV_CHARS);
  for (let i = 0; i < len; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      row.push(field); rows.push(row); row = []; field = '';
      if (ch === '\r' && s[i + 1] === '\n') i++;
    }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
