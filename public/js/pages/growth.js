// Reviews, Referrals, Commercial Prospects, and Automations (+ send log).
import { get, post, put, del, esc, money, fmtDate, fmtDateTime, downloadUrl } from '../api.js';
import { toast, toastError, openModal, confirmDialog, input, textarea, select, checkbox, readForm, badge, emptyState } from '../ui.js';

export async function renderGrowth(main, section) {
  if (section === 'reviews') return renderReviews(main);
  if (section === 'referrals') return renderReferrals(main);
  if (section === 'prospects') return renderProspects(main);
  if (section === 'automations') return renderAutomations(main);
}

// ---------- Reviews ----------
async function renderReviews(main) {
  const rows = await get('/review-requests');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Reviews</h1><div class="sub">Happy customers say yes when you ask. Ask every time.</div></div>
      <button class="btn" id="newReview">+ Ask for a review</button>
    </div>
    <div class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>Customer</th><th>Job</th><th>How</th><th>Status</th><th>When</th><th></th></tr>
        ${rows.map(r => `
          <tr>
            <td><b>${esc(r.customer_name || '—')}</b></td>
            <td>${esc(r.job_title || '—')}</td>
            <td>${r.channel === 'sms' ? '💬 Text' : '✉️ Email'}</td>
            <td>${badge(r.status)}${r.error ? `<div class="sub">${esc(r.error)}</div>` : ''}</td>
            <td class="sub">${fmtDateTime(r.sent_at || r.created_at)}</td>
            <td style="white-space:nowrap">
              ${['queued', 'error', 'dry_run'].includes(r.status) ? `<button class="btn small" data-send="${r.id}">Send now</button>` : ''}
              ${r.status === 'queued' ? `<button class="btn small secondary" data-skip="${r.id}">Skip</button>` : ''}
              ${['sent'].includes(r.status) ? `<button class="btn small secondary" data-send="${r.id}">Resend</button>` : ''}
            </td>
          </tr>`).join('')}
      </table></div>` : emptyState('⭐', 'No review requests yet.', 'Complete a job, then hit "Ask for a review" — or set up the automation to do it for you.')}
    </div>`;

  main.querySelectorAll('[data-send]').forEach(btn =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await post(`/review-requests/${btn.dataset.send}/send`);
        toast(r.status === 'sent' ? 'Review request sent!' : r.status === 'dry_run'
          ? 'Logged as a dry run — connect SMS/email in Settings (and turn off Dry Run) to really send.'
          : `Result: ${r.status}`);
        renderReviews(main);
      } catch (e) { toastError(e); renderReviews(main); }
    }));
  main.querySelectorAll('[data-skip]').forEach(btn =>
    btn.addEventListener('click', async () => {
      try { await post(`/review-requests/${btn.dataset.skip}/skip`); renderReviews(main); } catch (e) { toastError(e); }
    }));

  main.querySelector('#newReview').onclick = async () => {
    const customers = await get('/customers');
    if (!customers.length) return toast('Add a customer first', true);
    const { root, close } = openModal(`
      <h2>Ask for a review</h2>
      ${select('customer_id', 'Customer', customers.map(c => [c.id, c.name]))}
      ${select('channel', 'Send by', [['sms', 'Text message'], ['email', 'Email']])}
      ${textarea('message', 'Message (leave blank for the standard one)', '')}
      <div class="modal-actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="mk">Queue it</button>
      </div>`);
    root.querySelector('#mk').onclick = async () => {
      try { await post('/review-requests', readForm(root)); close(); toast('Queued'); renderReviews(main); }
      catch (e) { toastError(e); }
    };
  };
}

// ---------- Referrals ----------
async function renderReferrals(main) {
  const [rows, customers] = await Promise.all([get('/referrals'), get('/customers')]);
  const owed = rows.filter(r => !r.reward_paid).reduce((s, r) => s + r.reward_amount, 0);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Referrals</h1>
        <div class="sub">${owed > 0 ? `You owe <b>${money(owed)}</b> in referral rewards.` : 'Track who sends you work and what you owe them.'}</div></div>
      <button class="btn" id="newRef">+ Log a referral</button>
    </div>
    <div class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>Who referred</th><th>New customer</th><th>Their revenue</th><th>Reward</th><th>Paid?</th><th></th></tr>
        ${rows.map(r => `
          <tr>
            <td><b>${esc(r.referrer_name || '—')}</b></td>
            <td>${esc(r.referred_name || '—')}</td>
            <td>${money(r.referred_revenue)}</td>
            <td>${money(r.reward_amount)}</td>
            <td>${r.reward_paid ? '<span class="badge green">Paid</span>' : '<span class="badge amber">Owed</span>'}</td>
            <td style="white-space:nowrap">
              ${!r.reward_paid && r.reward_amount > 0 ? `<button class="btn small success" data-paid="${r.id}">Mark paid</button>` : ''}
              <button class="btn small secondary" data-edit="${r.id}">Edit</button>
            </td>
          </tr>`).join('')}
      </table></div>` : emptyState('🤝', 'No referrals logged yet.', 'When a customer sends you a new one, log it here so the reward never gets forgotten.')}
    </div>`;

  const form = (r) => {
    const { root, close } = openModal(`
      <h2>${r?.id ? 'Edit referral' : 'Log a referral'}</h2>
      ${select('referrer_id', 'Who referred them?', customers.map(c => [c.id, c.name]), r?.referrer_id || '')}
      ${select('referred_id', 'New customer', [['', '— not a customer yet —'], ...customers.map(c => [c.id, c.name])], r?.referred_id || '')}
      ${input('reward_amount', 'Reward you\\'ll give ($)', r?.reward_amount ?? 25, { type: 'number', step: '1' })}
      ${checkbox('reward_paid', 'Reward already paid', !!r?.reward_paid)}
      ${textarea('notes', 'Notes', r?.notes || '')}
      <div class="modal-actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="mk">Save</button>
      </div>`);
    root.querySelector('#mk').onclick = async () => {
      const f = readForm(root);
      try {
        if (r?.id) await put(`/referrals/${r.id}`, f); else await post('/referrals', f);
        close(); toast('Saved'); renderReferrals(main);
      } catch (e) { toastError(e); }
    };
  };

  main.querySelector('#newRef').onclick = () => customers.length ? form(null) : toast('Add customers first', true);
  main.querySelectorAll('[data-paid]').forEach(btn =>
    btn.addEventListener('click', async () => {
      try { await put(`/referrals/${btn.dataset.paid}`, { reward_paid: 1 }); toast('Marked paid'); renderReferrals(main); }
      catch (e) { toastError(e); }
    }));
  main.querySelectorAll('[data-edit]').forEach(btn =>
    btn.addEventListener('click', () => form(rows.find(r => r.id === Number(btn.dataset.edit)))));
}

// ---------- Commercial prospects ----------
const PROSPECT_STATUS = [['new', 'New'], ['contacted', 'Contacted'], ['interested', 'Interested'], ['customer', 'Became a customer'], ['not_interested', 'Not interested']];

async function renderProspects(main) {
  const draw = async (search = '') => {
    const rows = await get('/prospects?search=' + encodeURIComponent(search));
    document.getElementById('prospectArea').innerHTML = rows.length ? `
      <div class="table-wrap"><table>
        <tr><th>Company</th><th>Contact</th><th>Phone / email</th><th>Industry</th><th>City</th><th>Status</th><th>Last contacted</th></tr>
        ${rows.map(p => `
          <tr class="click" data-edit="${p.id}">
            <td><b>${esc(p.company)}</b>${p.website ? `<div class="sub">${esc(p.website)}</div>` : ''}</td>
            <td>${esc(p.contact)}${p.title ? `<div class="sub">${esc(p.title)}</div>` : ''}</td>
            <td>${esc(p.phone)}${p.email ? `<div class="sub">${esc(p.email)}</div>` : ''}</td>
            <td>${esc(p.industry)}</td>
            <td>${esc([p.city, p.state].filter(Boolean).join(', '))}</td>
            <td>${badge(p.status)}</td>
            <td>${p.last_contacted ? fmtDate(p.last_contacted) : '—'}</td>
          </tr>`).join('')}
      </table></div>`
      : emptyState('🏢', 'No commercial prospects yet.', 'Build a list of local businesses to pitch — import a CSV or add them one by one.');
    document.querySelectorAll('#prospectArea [data-edit]').forEach(el =>
      el.addEventListener('click', () => form(rows.find(p => p.id === Number(el.dataset.edit)))));
  };

  const form = (p) => {
    const { root, close } = openModal(`
      <h2>${p?.id ? 'Edit prospect' : 'Add a prospect'}</h2>
      ${input('company', 'Company *', p?.company || '')}
      <div class="form-row">
        ${input('contact', 'Contact person', p?.contact || '')}
        ${input('title', 'Their title', p?.title || '')}
      </div>
      <div class="form-row">
        ${input('phone', 'Phone', p?.phone || '')}
        ${input('email', 'Email', p?.email || '', { type: 'email' })}
      </div>
      <div class="form-row">
        ${input('website', 'Website', p?.website || '')}
        ${input('industry', 'Industry', p?.industry || '', { placeholder: 'e.g. Property management' })}
      </div>
      <div class="form-row thirds">
        ${input('city', 'City', p?.city || '')}
        ${input('state', 'State', p?.state || '')}
        ${input('last_contacted', 'Last contacted', p?.last_contacted || '', { type: 'date' })}
      </div>
      <div class="form-row">
        ${select('status', 'Status', PROSPECT_STATUS, p?.status || 'new')}
        ${input('source', 'Source', p?.source || '')}
      </div>
      ${textarea('notes', 'Notes', p?.notes || '')}
      <div class="modal-actions">
        ${p?.id ? '<button class="btn danger" id="delP">Delete</button>' : ''}
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="mk">Save</button>
      </div>`);
    root.querySelector('#mk').onclick = async () => {
      const f = readForm(root);
      if (!f.company.trim()) return toast('Company name is required', true);
      try {
        if (p?.id) await put(`/prospects/${p.id}`, f); else await post('/prospects', f);
        close(); toast('Saved'); draw(main.querySelector('#pSearch').value);
      } catch (e) { toastError(e); }
    };
    root.querySelector('#delP')?.addEventListener('click', async () => {
      if (await confirmDialog(`Delete ${p.company}?`)) {
        try { await del(`/prospects/${p.id}`); close(); draw(); } catch (e) { toastError(e); }
      }
    });
  };

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Commercial Prospects</h1><div class="sub">Local businesses worth pitching for recurring contracts.</div></div>
      <div class="btn-row">
        <button class="btn secondary" id="importCsv">📥 Import CSV</button>
        <button class="btn secondary" id="exportCsv">📤 Export CSV</button>
        <button class="btn" id="addProspect">+ Add Prospect</button>
      </div>
    </div>
    <div class="card">
      <input id="pSearch" placeholder="Search company, contact, industry, city…" style="margin-bottom:12px">
      <div id="prospectArea"></div>
    </div>`;

  await draw();
  let t;
  main.querySelector('#pSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => draw(e.target.value), 250); });
  main.querySelector('#addProspect').onclick = () => form(null);
  main.querySelector('#exportCsv').onclick = () => downloadUrl('/api/prospects.csv');
  main.querySelector('#importCsv').onclick = () => {
    const { root, close } = openModal(`
      <h2>Import prospects from CSV</h2>
      <div class="sub" style="margin-bottom:10px">First row must be headers. Recognized: company, contact, title, phone, email, website, industry, city, state, status, source, notes, last_contacted. Rows with a duplicate email are skipped.</div>
      <label class="field"><span>Pick a .csv file</span><input type="file" id="csvFile" accept=".csv,text/csv"></label>
      <div class="modal-actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="doImport">Import</button>
      </div>`);
    root.querySelector('#doImport').onclick = async () => {
      const file = root.querySelector('#csvFile').files[0];
      if (!file) return toast('Pick a file first', true);
      try {
        const text = await file.text();
        const r = await post('/prospects/import', { csv: text });
        close(); toast(`Imported ${r.imported} prospects${r.skipped ? `, skipped ${r.skipped}` : ''}`);
        draw();
      } catch (e) { toastError(e); }
    };
  };
}

// ---------- Automations ----------
const TRIGGERS = [
  ['new_lead', 'New lead comes in → follow up'],
  ['quote_sent', 'Quote sent → nudge them'],
  ['job_reminder', 'Job is tomorrow → remind customer'],
  ['job_completed', 'Job completed → thank you'],
  ['invoice_overdue', 'Invoice overdue → payment reminder'],
  ['review_request', 'Review request queued → send it'],
];
const TRIGGER_LABEL = Object.fromEntries(TRIGGERS);

const STARTERS = {
  new_lead: `Hi {first_name}, thanks for reaching out to {business}! When's a good time to talk about your {service} project?`,
  quote_sent: `Hi {first_name}, just checking in on the quote we sent for "{quote_title}". Any questions? Happy to walk through it. — {business}`,
  job_reminder: `Reminder from {business}: we're scheduled at your place tomorrow ({job_date}{job_time} start). Reply if anything changed!`,
  job_completed: `Thanks for choosing {business}, {first_name}! If anything isn't perfect, just reply here and we'll make it right.`,
  invoice_overdue: `Hi {first_name}, friendly reminder that invoice {invoice_number} was due {due_date}. Pay here: {payment_link} — {business}`,
  review_request: `Hi {first_name}! Thanks for choosing {business}. Would you mind leaving us a quick review? It really helps: {review_link}`,
};

async function renderAutomations(main) {
  const [{ automations, channels }, sendLog] = await Promise.all([get('/automations'), get('/send-log')]);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Automations</h1><div class="sub">Messages that send themselves so you don't have to remember.</div></div>
      <div class="btn-row">
        <button class="btn secondary" id="runNow">▶ Run now</button>
        <button class="btn" id="addAuto">+ New Automation</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px;background:${channels.dry_run ? '#fdf6ea' : '#eefaf2'}">
      ${channels.dry_run
        ? `🧪 <b>Dry Run is ON</b> — automations write to the log below but nothing is actually sent. Turn it off in <a href="#/settings">Settings</a> when you're ready.`
        : `✅ <b>Live sending is ON.</b>`}
      &nbsp; Text messages: ${channels.sms_connected ? '<span class="badge green">connected</span>' : '<span class="badge gray">not connected</span>'}
      &nbsp; Email: ${channels.email_connected ? '<span class="badge green">connected</span>' : '<span class="badge gray">not connected</span>'}
    </div>

    <div class="card" style="margin-bottom:14px">
      <h2>Your automations</h2>
      ${automations.length ? automations.map(a => `
        <div class="list-item">
          <div>
            <b>${esc(a.name)}</b> ${a.active ? '<span class="badge green">on</span>' : '<span class="badge gray">off</span>'}
            <div class="sub">${esc(TRIGGER_LABEL[a.trigger] || a.trigger)} · by ${a.channel === 'sms' ? 'text' : 'email'}${a.delay_hours ? ` · waits ${a.delay_hours}h` : ''}</div>
          </div>
          <div class="btn-row">
            <button class="btn small secondary" data-toggle="${a.id}">${a.active ? 'Turn off' : 'Turn on'}</button>
            <button class="btn small secondary" data-edit="${a.id}">Edit</button>
          </div>
        </div>`).join('')
        : emptyState('⚡', 'No automations yet.', 'Start with a review request or an overdue-invoice reminder — the templates are pre-written.')}
    </div>

    <div class="card">
      <h2>📬 Send log (what actually went out)</h2>
      ${sendLog.length ? `<div class="table-wrap"><table>
        <tr><th>When</th><th>To</th><th>What</th><th>Status</th><th></th></tr>
        ${sendLog.slice(0, 50).map(s => `
          <tr>
            <td class="sub" style="white-space:nowrap">${fmtDateTime(s.created_at)}</td>
            <td>${esc(s.customer_name || s.to_addr || '—')}<div class="sub">${s.channel === 'sms' ? '💬' : '✉️'} ${esc(s.to_addr)}</div></td>
            <td class="sub" style="max-width:340px">${esc(s.body).slice(0, 120)}${s.body.length > 120 ? '…' : ''}</td>
            <td>${badge(s.status)}${s.error ? `<div class="sub">${esc(s.error).slice(0, 80)}</div>` : ''}</td>
            <td>${s.status === 'error' ? `<button class="btn small secondary" data-retry="${s.id}">Retry</button>` : ''}</td>
          </tr>`).join('')}
      </table></div>` : '<div class="sub">Nothing sent (or dry-run) yet.</div>'}
    </div>`;

  const form = (a) => {
    const { root, close } = openModal(`
      <h2>${a?.id ? 'Edit automation' : 'New automation'}</h2>
      ${input('name', 'Name it', a?.name || '', { placeholder: 'e.g. Review request after every job' })}
      ${select('trigger', 'When should it fire?', TRIGGERS, a?.trigger || 'review_request')}
      <div class="form-row">
        ${select('channel', 'Send by', [['sms', 'Text message'], ['email', 'Email']], a?.channel || 'sms')}
        ${input('delay_hours', 'Wait this many hours first', a?.delay_hours ?? 0, { type: 'number', step: '0.5' })}
      </div>
      ${textarea('template', 'Message', a?.template || STARTERS.review_request)}
      <div class="sub" style="margin-bottom:10px">You can use: {first_name} {name} {business} {review_link} {service} {quote_title} {job_date} {job_time} {invoice_number} {due_date} {payment_link}</div>
      ${checkbox('active', 'Turn it on', a ? !!a.active : true)}
      <div class="modal-actions">
        ${a?.id ? '<button class="btn danger" id="delA">Delete</button>' : ''}
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="mk">Save</button>
      </div>`);
    // swap in the matching starter template when the trigger changes (only if untouched)
    const trigSel = root.querySelector('select[name=trigger]');
    const tplBox = root.querySelector('textarea[name=template]');
    trigSel.addEventListener('change', () => {
      if (!a?.id && (Object.values(STARTERS).includes(tplBox.value) || !tplBox.value.trim())) {
        tplBox.value = STARTERS[trigSel.value] || '';
      }
    });
    root.querySelector('#mk').onclick = async () => {
      const f = readForm(root);
      if (!f.name.trim() || !f.template.trim()) return toast('Name and message are required', true);
      try {
        if (a?.id) await put(`/automations/${a.id}`, f); else await post('/automations', f);
        close(); toast('Automation saved'); renderAutomations(main);
      } catch (e) { toastError(e); }
    };
    root.querySelector('#delA')?.addEventListener('click', async () => {
      if (await confirmDialog(`Delete "${a.name}"?`)) {
        try { await del(`/automations/${a.id}`); close(); renderAutomations(main); } catch (e) { toastError(e); }
      }
    });
  };

  main.querySelector('#addAuto').onclick = () => form(null);
  main.querySelectorAll('[data-edit]').forEach(btn =>
    btn.addEventListener('click', () => form(automations.find(a => a.id === Number(btn.dataset.edit)))));
  main.querySelectorAll('[data-toggle]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const a = automations.find(x => x.id === Number(btn.dataset.toggle));
      try { await put(`/automations/${a.id}`, { active: a.active ? 0 : 1 }); renderAutomations(main); }
      catch (e) { toastError(e); }
    }));
  main.querySelector('#runNow').onclick = async () => {
    try { const r = await post('/automations/run-now'); toast(`Done — ${r.fired} message(s) processed. Check the send log.`); renderAutomations(main); }
    catch (e) { toastError(e); }
  };
  main.querySelectorAll('[data-retry]').forEach(btn =>
    btn.addEventListener('click', async () => {
      try { await post(`/send-log/${btn.dataset.retry}/retry`); toast('Retried'); renderAutomations(main); }
      catch (e) { toastError(e); }
    }));
}
