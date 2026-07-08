// Lead pipeline — kanban board with plain-language stages.
import { get, post, put, del, esc, money, fmtDate } from '../api.js';
import { toast, toastError, openModal, confirmDialog, input, textarea, select, readForm, emptyState } from '../ui.js';

const STAGES = [
  ['new', 'New Lead'], ['contacted', 'Contacted'], ['estimate_scheduled', 'Estimate Scheduled'],
  ['quote_sent', 'Quote Sent'], ['won', 'Won'], ['scheduled', 'Scheduled'], ['lost', 'Lost'],
];
const STAGE_LABEL = Object.fromEntries(STAGES);

export async function renderLeads(main) {
  const leads = await get('/leads');

  const card = (l) => {
    const idx = STAGES.findIndex(([k]) => k === l.stage);
    const next = STAGES[idx + 1];
    const prev = STAGES[idx - 1];
    return `
    <div class="kanban-card" data-id="${l.id}">
      <div class="name">${esc(l.name)}</div>
      <div class="meta">${esc(l.service_type || 'Service TBD')}${l.source ? ' · ' + esc(l.source) : ''}</div>
      ${l.value_estimate ? `<div class="value">~${money(l.value_estimate)}</div>` : ''}
      ${l.next_action ? `<div class="meta">👉 ${esc(l.next_action)}${l.next_action_date ? ' by ' + fmtDate(l.next_action_date) : ''}</div>` : ''}
      <div class="stage-move" onclick="event.stopPropagation()">
        ${prev ? `<button data-move="${l.id}:${prev[0]}">← ${esc(prev[1])}</button>` : ''}
        ${next && l.stage !== 'lost' ? `<button data-move="${l.id}:${next[0]}">${esc(next[1])} →</button>` : ''}
        ${l.stage !== 'lost' && l.stage !== 'won' && l.stage !== 'scheduled' ? `<button data-move="${l.id}:lost" style="flex:0 0 44px">Lost</button>` : ''}
      </div>
    </div>`;
  };

  const totalOpen = leads.filter(l => !['won', 'scheduled', 'lost'].includes(l.stage))
    .reduce((s, l) => s + (l.value_estimate || 0), 0);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Leads</h1>
        <div class="sub">${money(totalOpen)} of potential work in the pipeline. Move each lead along until it's Won.</div></div>
      <button class="btn" id="addLead">+ New Lead</button>
    </div>
    ${leads.length ? `<div class="kanban">
      ${STAGES.map(([key, label]) => {
        const inStage = leads.filter(l => l.stage === key);
        return `<div class="kanban-col">
          <h3>${esc(label)} <span>${inStage.length}</span></h3>
          ${inStage.map(card).join('')}
        </div>`;
      }).join('')}
    </div>` : `<div class="card">${emptyState('🎯', 'No leads yet.', 'Every phone call, website form, or referral goes here so nothing slips through.')}</div>`}`;

  main.querySelectorAll('.kanban-card').forEach((el) => {
    el.addEventListener('click', () => {
      const lead = leads.find(l => l.id === Number(el.dataset.id));
      leadForm(lead, () => renderLeads(main));
    });
  });
  main.querySelectorAll('[data-move]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const [id, stage] = btn.dataset.move.split(':');
      try {
        if (stage === 'lost') {
          const reason = prompt('Why was this lead lost? (optional)') || '';
          await put(`/leads/${id}`, { stage, lost_reason: reason });
        } else {
          await put(`/leads/${id}`, { stage });
          if (stage === 'won') toast('Lead won! 🎉 A customer record was created automatically.');
        }
        renderLeads(main);
      } catch (e) { toastError(e); }
    });
  });
  main.querySelector('#addLead').onclick = () => leadForm(null, () => renderLeads(main));
}

function leadForm(lead, onSaved) {
  const l = lead || {};
  const { root, close } = openModal(`
    <h2>${l.id ? 'Edit lead' : 'New lead'}</h2>
    ${input('name', 'Name *', l.name || '')}
    <div class="form-row">
      ${input('phone', 'Phone', l.phone || '')}
      ${input('email', 'Email', l.email || '', { type: 'email' })}
    </div>
    ${input('address', 'Address', l.address || '')}
    <div class="form-row">
      ${select('source', 'Where did they come from?', ['', 'Referral', 'Google', 'Facebook', 'Nextdoor', 'Yard sign', 'Truck/van', 'Repeat customer', 'Door knock', 'Other'], l.source || '')}
      ${input('service_type', 'What do they need?', l.service_type || '', { placeholder: 'e.g. Lawn care, Gutter cleaning' })}
    </div>
    <div class="form-row">
      ${input('value_estimate', 'Rough job value ($)', l.value_estimate || '', { type: 'number', step: '1' })}
      ${select('stage', 'Stage', STAGES.map(([k, v]) => [k, v]), l.stage || 'new')}
    </div>
    <div class="form-row">
      ${input('next_action', 'Next step', l.next_action || '', { placeholder: 'e.g. Call back, Visit for estimate' })}
      ${input('next_action_date', 'By when', l.next_action_date || '', { type: 'date' })}
    </div>
    ${input('owner', 'Who owns this lead?', l.owner || '', { placeholder: 'e.g. Mike' })}
    ${textarea('notes', 'Notes', l.notes || '')}
    <div class="modal-actions">
      ${l.id ? '<button class="btn danger" id="delLead">Delete</button>' : ''}
      <button class="btn secondary" data-close>Cancel</button>
      <button class="btn" id="saveLead">Save</button>
    </div>`);
  root.querySelector('#saveLead').onclick = async () => {
    const f = readForm(root);
    if (!f.name.trim()) return toast('Please enter a name', true);
    try {
      if (l.id) await put(`/leads/${l.id}`, f); else await post('/leads', f);
      close(); toast('Lead saved'); onSaved?.();
    } catch (e) { toastError(e); }
  };
  root.querySelector('#delLead')?.addEventListener('click', async () => {
    if (await confirmDialog(`Delete lead "${l.name}"? This can't be undone.`)) {
      try { await del(`/leads/${l.id}`); close(); toast('Lead deleted'); onSaved?.(); }
      catch (e) { toastError(e); }
    }
  });
}
