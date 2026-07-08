// Shared UI: toast, modal, form builder, badges, empty states.
import { esc } from './api.js';

export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'show error' : 'show';
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = ''), isError ? 5000 : 2600);
}

export function toastError(err) {
  toast(err?.message || String(err), true);
}

/** Open a modal. Returns {root, close}. html is the inner content (h2 + body + .modal-actions). */
export function openModal(html) {
  const rootHost = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  rootHost.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  return { root: overlay.querySelector('.modal'), close };
}

export async function confirmDialog(message, actionLabel = 'Delete') {
  return new Promise((resolve) => {
    const { root, close } = openModal(`
      <h2>Are you sure?</h2>
      <p>${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn danger" id="confirmYes">${esc(actionLabel)}</button>
      </div>`);
    root.querySelector('#confirmYes').onclick = () => { close(); resolve(true); };
    root.closest('.modal-overlay').addEventListener('mousedown', (e) => {
      if (e.target === root.closest('.modal-overlay')) resolve(false);
    });
    root.querySelector('[data-close]').addEventListener('click', () => resolve(false));
  });
}

// --- form field helpers (all return HTML strings) ---
export const input = (name, label, value = '', opts = {}) => `
  <label class="field"><span>${esc(label)}</span>
    <input name="${esc(name)}" type="${opts.type || 'text'}" value="${esc(value)}"
      ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}
      ${opts.step ? `step="${opts.step}"` : ''} ${opts.required ? 'required' : ''}>
  </label>`;

export const textarea = (name, label, value = '', placeholder = '') => `
  <label class="field"><span>${esc(label)}</span>
    <textarea name="${esc(name)}" ${placeholder ? `placeholder="${esc(placeholder)}"` : ''}>${esc(value)}</textarea>
  </label>`;

export const select = (name, label, options, value = '') => `
  <label class="field"><span>${esc(label)}</span>
    <select name="${esc(name)}">
      ${options.map(o => {
        const [v, t] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`;
      }).join('')}
    </select>
  </label>`;

export const checkbox = (name, label, checked = false) => `
  <label class="check"><input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;

/** Read all named fields inside a container into an object. */
export function readForm(root) {
  const out = {};
  root.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
    else out[el.name] = el.value;
  });
  return out;
}

export const emptyState = (icon, text, hint = '') => `
  <div class="empty"><span class="big">${icon}</span>${esc(text)}${hint ? `<div class="sub" style="margin-top:4px">${esc(hint)}</div>` : ''}</div>`;

const BADGES = {
  // shared status → [class, plain label]
  new: ['blue', 'New'], contacted: ['gray', 'Contacted'], estimate_scheduled: ['amber', 'Estimate scheduled'],
  quote_sent: ['blue', 'Quote sent'], won: ['green', 'Won'], scheduled: ['blue', 'Scheduled'], lost: ['red', 'Lost'],
  draft: ['gray', 'Draft'], sent: ['blue', 'Sent'], approved: ['green', 'Approved'], declined: ['red', 'Declined'],
  expired: ['amber', 'Expired'], in_progress: ['amber', 'In progress'], complete: ['green', 'Complete'],
  canceled: ['red', 'Canceled'], paid: ['green', 'Paid'], overdue: ['red', 'Overdue'], void: ['gray', 'Void'],
  queued: ['amber', 'Queued'], dry_run: ['gray', 'Dry run'], error: ['red', 'Error'], skipped: ['gray', 'Skipped'],
  skipped_opt_out: ['gray', 'Opted out'], skipped_no_contact: ['amber', 'No contact info'],
  interested: ['amber', 'Interested'], customer: ['green', 'Customer'], not_interested: ['gray', 'Not interested'],
  before: ['blue', 'Before'], after: ['green', 'After'], other: ['gray', 'Photo'],
};
export function badge(status) {
  const [cls, label] = BADGES[status] || ['gray', status];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

export const spinner = `<div class="empty">Loading…</div>`;
