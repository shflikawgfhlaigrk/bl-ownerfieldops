// CRM — customer list + full customer record.
import { get, post, put, del, esc, money, fmtDateTime, fmtDate } from '../api.js';
import { toast, toastError, openModal, confirmDialog, input, textarea, select, checkbox, readForm, badge, emptyState } from '../ui.js';

export async function renderCustomers(main) {
  const draw = async (search = '') => {
    const rows = await get('/customers?search=' + encodeURIComponent(search));
    document.getElementById('custTableArea').innerHTML = rows.length ? `
      <div class="table-wrap"><table>
        <tr><th>Name</th><th>Phone</th><th>Address</th><th>Jobs</th><th style="text-align:right">Lifetime value</th></tr>
        ${rows.map(c => `
          <tr class="click" onclick="location.hash='#/customers/${c.id}'">
            <td><b>${esc(c.name)}</b>${c.unread ? ' <span class="badge red">💬 ' + c.unread + '</span>' : ''}
              ${c.company ? `<div class="sub">${esc(c.company)}</div>` : ''}
              ${c.tags ? `<div class="sub">🏷 ${esc(c.tags)}</div>` : ''}</td>
            <td>${esc(c.phone)}</td>
            <td>${esc([c.address, c.city].filter(Boolean).join(', '))}</td>
            <td>${c.job_count}</td>
            <td style="text-align:right"><b>${money(c.lifetime_value)}</b></td>
          </tr>`).join('')}
      </table></div>`
      : emptyState('👥', search ? 'No customers match that search.' : 'No customers yet.', 'Add your first customer or win a lead — won leads become customers automatically.');
  };

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Customers</h1><div class="sub">Everyone you do work for, in one place.</div></div>
      <button class="btn" id="addCustomer">+ Add Customer</button>
    </div>
    <div class="card">
      <input id="custSearch" placeholder="Search by name, phone, address, or tag…" style="margin-bottom:12px">
      <div id="custTableArea"></div>
    </div>`;

  await draw();
  let t;
  main.querySelector('#custSearch').addEventListener('input', (e) => {
    clearTimeout(t); t = setTimeout(() => draw(e.target.value), 250);
  });
  main.querySelector('#addCustomer').onclick = () => customerForm(null, () => draw());
}

export function customerForm(customer, onSaved) {
  const c = customer || {};
  const { root, close } = openModal(`
    <h2>${c.id ? 'Edit customer' : 'Add a customer'}</h2>
    ${input('name', 'Name *', c.name || '')}
    <div class="form-row">
      ${input('company', 'Company (optional)', c.company || '')}
      ${input('phone', 'Phone', c.phone || '')}
    </div>
    ${input('email', 'Email', c.email || '', { type: 'email' })}
    ${input('address', 'Street address', c.address || '')}
    <div class="form-row thirds">
      ${input('city', 'City', c.city || '')}
      ${input('state', 'State', c.state || '')}
      ${input('zip', 'ZIP', c.zip || '')}
    </div>
    ${input('tags', 'Tags (comma separated)', c.tags || '', { placeholder: 'vip, weekly, gate-code-1234' })}
    ${textarea('notes', 'Notes', c.notes || '')}
    ${checkbox('sms_opt_out', 'Do NOT text this customer', !!c.sms_opt_out)}
    ${checkbox('email_opt_out', 'Do NOT email this customer', !!c.email_opt_out)}
    <div class="modal-actions">
      <button class="btn secondary" data-close>Cancel</button>
      <button class="btn" id="saveCust">Save</button>
    </div>`);
  root.querySelector('#saveCust').onclick = async () => {
    const f = readForm(root);
    if (!f.name.trim()) return toast('Please enter a name', true);
    try {
      const saved = c.id ? await put(`/customers/${c.id}`, f) : await post('/customers', f);
      close(); toast('Customer saved'); onSaved?.(saved);
    } catch (e) { toastError(e); }
  };
}

export async function renderCustomerDetail(main, id) {
  const c = await get(`/customers/${id}`);
  const portalLink = `${location.origin}/portal/${c.portal_token}`;

  const activityIcons = { note: '📝', call: '📞', job: '🧰', quote: '📄', invoice: '💵', message: '💬', system: '⚙️' };

  main.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/customers">← All customers</a>
        <h1>${esc(c.name)}</h1>
        <div class="sub">${esc([c.company, c.phone, c.email].filter(Boolean).join(' · '))}</div>
        <div class="sub">${esc([c.address, c.city, c.state, c.zip].filter(Boolean).join(', '))}</div>
        ${c.tags ? `<div style="margin-top:6px">${c.tags.split(',').map(t => `<span class="badge gray">${esc(t.trim())}</span>`).join(' ')}</div>` : ''}
      </div>
      <div class="btn-row">
        <button class="btn secondary" id="copyPortal">🔗 Copy portal link</button>
        <button class="btn secondary" id="editCust">Edit</button>
        <button class="btn" id="newJobBtn">+ Schedule job</button>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h2>🧰 Jobs</h2>
        ${c.jobs.length ? c.jobs.slice(0, 10).map(j => `
          <div class="list-item click" onclick="location.hash='#/jobs/${j.id}'">
            <div><b>${esc(j.title)}</b><div class="sub">${fmtDate(j.date) || 'Unscheduled'}</div></div>
            ${badge(j.status)}
          </div>`).join('') : emptyState('🧰', 'No jobs yet for this customer.')}
      </div>

      <div class="card">
        <h2>📄 Quotes & 💵 Invoices</h2>
        ${c.quotes.length || c.invoices.length ? `
          ${c.quotes.map(quote => `
            <div class="list-item click" onclick="location.hash='#/quotes/${quote.id}'">
              <div>📄 <b>${esc(quote.title || 'Quote #' + quote.id)}</b></div>${badge(quote.status)}
            </div>`).join('')}
          ${c.invoices.map(i => `
            <div class="list-item click" onclick="location.hash='#/invoices/${i.id}'">
              <div>💵 <b>${esc(i.number)}</b><div class="sub">${money(i.subtotal)}</div></div>${badge(i.status)}
            </div>`).join('')}`
          : emptyState('📄', 'No quotes or invoices yet.')}
      </div>

      <div class="card">
        <h2>💬 Messages ${c.messages.some(m => m.direction === 'in' && !m.read) ? '<span class="badge red">new</span>' : ''}</h2>
        <div style="max-height:260px;overflow-y:auto" id="msgList">
          ${c.messages.length ? c.messages.map(m => `
            <div style="margin-bottom:8px;display:flex;${m.direction === 'out' ? 'justify-content:flex-end' : ''}">
              <div style="max-width:80%;padding:8px 12px;border-radius:12px;font-size:14px;
                ${m.direction === 'out' ? 'background:var(--brand);color:#fff' : 'background:#eef1f7'}">
                ${esc(m.body)}<div style="font-size:11px;opacity:.7;margin-top:2px">${fmtDateTime(m.created_at)}</div>
              </div>
            </div>`).join('') : '<div class="sub">No messages yet. Customers can message you from their portal link.</div>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input id="msgInput" placeholder="Type a reply…">
          <button class="btn" id="msgSend">Send</button>
        </div>
      </div>

      <div class="card">
        <h2>📒 Activity & notes</h2>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input id="noteInput" placeholder="Add a note (call summary, gate code, preference…)">
          <button class="btn secondary" id="noteAdd">Add</button>
        </div>
        <div class="timeline">
          ${c.activity.length ? c.activity.map(a => `
            <div class="tl-item">
              <div>${activityIcons[a.kind] || '•'} ${esc(a.body)}</div>
              <div class="when">${fmtDateTime(a.created_at)}</div>
            </div>`).join('') : '<div class="sub">Nothing here yet.</div>'}
        </div>
      </div>

      ${c.photos.length ? `<div class="card" style="grid-column:1/-1">
        <h2>📷 Photos from jobs</h2>
        <div class="photo-grid">
          ${c.photos.map(p => `
            <a class="ph" href="/uploads/${esc(p.filename)}" target="_blank">
              <img src="/uploads/${esc(p.filename)}" loading="lazy" alt="${p.kind}">
              <span class="tag">${esc(p.kind)}</span>
            </a>`).join('')}
        </div>
      </div>` : ''}
    </div>`;

  // mark inbound messages read
  if (c.messages.some(m => m.direction === 'in' && !m.read)) post(`/customers/${id}/messages/read`).catch(() => {});
  const msgList = main.querySelector('#msgList');
  if (msgList) msgList.scrollTop = msgList.scrollHeight;

  main.querySelector('#copyPortal').onclick = async () => {
    try { await navigator.clipboard.writeText(portalLink); toast('Portal link copied — text or email it to the customer'); }
    catch { prompt('Copy this portal link:', portalLink); }
  };
  main.querySelector('#editCust').onclick = () => customerForm(c, () => renderCustomerDetail(main, id));
  main.querySelector('#newJobBtn').onclick = () => { location.hash = `#/schedule?customer=${id}`; };

  main.querySelector('#msgSend').onclick = async () => {
    const val = main.querySelector('#msgInput').value.trim();
    if (!val) return;
    try { await post(`/customers/${id}/messages`, { body: val }); renderCustomerDetail(main, id); }
    catch (e) { toastError(e); }
  };
  main.querySelector('#noteAdd').onclick = async () => {
    const val = main.querySelector('#noteInput').value.trim();
    if (!val) return;
    try { await post(`/customers/${id}/notes`, { body: val }); toast('Note added'); renderCustomerDetail(main, id); }
    catch (e) { toastError(e); }
  };
}
