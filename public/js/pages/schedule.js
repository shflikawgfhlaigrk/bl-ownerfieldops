// Job scheduler — week view + job form with conflict warnings, and the job detail page.
import { get, post, put, del, esc, money, fmtTime, fmtDate, fmtDateTime, todayStr, hoursBetween } from '../api.js';
import { toast, toastError, openModal, confirmDialog, input, textarea, select, readForm, badge, emptyState } from '../ui.js';

let weekOffset = 0;

function weekDates(offset) {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

export async function renderSchedule(main) {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const dates = weekDates(weekOffset);
  const [jobs, workers] = await Promise.all([
    get(`/jobs?from=${dates[0]}&to=${dates[6]}`),
    get('/workers'),
  ]);
  const unscheduled = await get('/jobs?status=scheduled').then(all => all.filter(j => !j.date));

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Schedule</h1><div class="sub">Week of ${fmtDate(dates[0])}</div></div>
      <div class="btn-row">
        <button class="btn secondary" id="prevWeek">←</button>
        <button class="btn secondary" id="thisWeek">Today</button>
        <button class="btn secondary" id="nextWeek">→</button>
        <button class="btn" id="newJob">+ Schedule a Job</button>
      </div>
    </div>

    <div class="week-grid">
      ${dates.map((date, i) => {
        const dayJobs = jobs.filter(j => j.date === date);
        return `<div class="day-col ${date === todayStr() ? 'today' : ''}">
          <div class="day-name">${dayNames[i]} <b>${Number(date.slice(8))}</b></div>
          ${dayJobs.map(j => `
            <div class="job-chip ${j.status}" data-job="${j.id}">
              <b>${j.time_start ? fmtTime(j.time_start) : ''}</b> ${esc(j.title)}
              <div class="who">${esc(j.customer_name || '')}${j.workers.length ? ' · ' + j.workers.map(w => esc(w.name.split(' ')[0])).join(', ') : ''}</div>
            </div>`).join('')}
        </div>`;
      }).join('')}
    </div>

    ${unscheduled.length ? `<div class="card" style="margin-top:14px">
      <h2>📥 Jobs without a date yet</h2>
      ${unscheduled.map(j => `
        <div class="list-item click" data-job="${j.id}">
          <div><b>${esc(j.title)}</b><div class="sub">${esc(j.customer_name || '')}</div></div>
          <span class="badge amber">Needs a date</span>
        </div>`).join('')}
    </div>` : ''}`;

  main.querySelector('#prevWeek').onclick = () => { weekOffset--; renderSchedule(main); };
  main.querySelector('#nextWeek').onclick = () => { weekOffset++; renderSchedule(main); };
  main.querySelector('#thisWeek').onclick = () => { weekOffset = 0; renderSchedule(main); };
  main.querySelectorAll('[data-job]').forEach((el) =>
    el.addEventListener('click', () => { location.hash = `#/jobs/${el.dataset.job}`; }));
  main.querySelector('#newJob').onclick = () => jobForm({ workers }, () => renderSchedule(main));

  // deep links: #/schedule?customer=5 or ?quote=3 open the form prefilled
  if (params.get('customer') || params.get('quote')) {
    history.replaceState(null, '', '#/schedule');
    jobForm({ workers, customer_id: params.get('customer'), quote_id: params.get('quote') }, () => renderSchedule(main));
  }
}

export async function jobForm(ctx, onSaved, existing) {
  const j = existing || {};
  const [customers, templates, workers] = await Promise.all([
    get('/customers'), get('/checklist-templates'), ctx.workers ? Promise.resolve(ctx.workers) : get('/workers'),
  ]);
  let quote = null;
  if (ctx.quote_id) {
    quote = await get(`/quotes/${ctx.quote_id}`).catch(() => null);
  }
  const activeWorkers = workers.filter(w => w.active);
  const assigned = new Set((j.workers || []).map(w => w.id));

  const { root, close } = openModal(`
    <h2>${j.id ? 'Edit job' : 'Schedule a job'}</h2>
    ${input('title', 'Job name *', j.title || quote?.title || '', { placeholder: 'e.g. Gutter cleaning — Smith' })}
    <div class="form-row">
      ${select('customer_id', 'Customer', [['', '— pick a customer —'], ...customers.map(c => [c.id, c.name])],
        j.customer_id || ctx.customer_id || quote?.customer_id || '')}
      ${input('service_type', 'Service type', j.service_type || quote?.service_type || '')}
    </div>
    <div class="form-row thirds">
      ${input('date', 'Date', j.date || '', { type: 'date' })}
      ${input('time_start', 'Start', j.time_start || '', { type: 'time' })}
      ${input('time_end', 'End', j.time_end || '', { type: 'time' })}
    </div>
    ${input('address', 'Job address (leave blank to use the customer\'s)', j.address || '')}
    <label class="field"><span>Who's doing the work?</span>
      <div id="workerChecks">
        ${activeWorkers.length ? activeWorkers.map(w => `
          <label class="check"><input type="checkbox" data-worker="${w.id}" ${assigned.has(w.id) ? 'checked' : ''}>
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(w.color)}"></span> ${esc(w.name)}</label>`).join('')
          : '<div class="sub">No workers yet — add them under Settings & Workers. You can still schedule the job.</div>'}
      </div>
    </label>
    ${!j.id ? select('checklist_template_id', 'Checklist', [['', 'No checklist'], ...templates.map(t => [t.id, t.name])], templates[0]?.id || '') : ''}
    ${textarea('notes', 'Notes for the crew', j.notes || '')}
    <div id="conflictArea"></div>
    <div class="modal-actions">
      <button class="btn secondary" data-close>Cancel</button>
      <button class="btn" id="saveJob">${j.id ? 'Save' : 'Schedule it'}</button>
    </div>`);

  const selectedWorkers = () =>
    [...root.querySelectorAll('[data-worker]:checked')].map(el => Number(el.dataset.worker));

  const checkConflicts = async () => {
    const f = readForm(root);
    if (!f.date) return;
    try {
      const conflicts = await post('/jobs/check-conflicts', {
        date: f.date, time_start: f.time_start, time_end: f.time_end,
        worker_ids: selectedWorkers(), exclude_job_id: j.id,
      });
      root.querySelector('#conflictArea').innerHTML = conflicts.length ? `
        <div class="card" style="background:#fdf0dd;border-color:#f0d5a8;margin-bottom:6px">
          ⚠️ <b>Heads up:</b> ${conflicts.map(c =>
            `${esc(c.worker_name)} is already on “${esc(c.title)}” (${fmtTime(c.time_start) || 'no time'}–${fmtTime(c.time_end) || ''})`).join('; ')}.
          You can still save — just know they're double-booked.
        </div>` : '';
    } catch { /* non-blocking */ }
  };
  root.querySelectorAll('input[name=date],input[name=time_start],input[name=time_end],[data-worker]')
    .forEach(el => el.addEventListener('change', checkConflicts));

  root.querySelector('#saveJob').onclick = async () => {
    const f = readForm(root);
    if (!f.title.trim()) return toast('Give the job a name', true);
    const body = { ...f, worker_ids: selectedWorkers(), quote_id: j.quote_id || ctx.quote_id || null };
    try {
      const saved = j.id ? await put(`/jobs/${j.id}`, body) : await post('/jobs', body);
      close();
      if (saved.conflicts?.length) toast('Job saved — note: a worker is double-booked that day', true);
      else toast('Job scheduled');
      onSaved?.(saved);
    } catch (e) { toastError(e); }
  };
}

// ---------- Job detail ----------
export async function renderJobDetail(main, id) {
  const j = await get(`/jobs/${id}`);
  const mapsUrl = j.address ? `https://maps.apple.com/?q=${encodeURIComponent(j.address)}` : null;

  const doneCount = j.checklist.filter(c => c.done).length;
  main.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/schedule">← Schedule</a>
        <h1>${esc(j.title)} ${badge(j.status)}</h1>
        <div class="sub">
          ${j.customer_name ? `<a href="#/customers/${j.customer_id}">${esc(j.customer_name)}</a> · ` : ''}
          ${j.date ? fmtDate(j.date) : 'No date yet'}${j.time_start ? ' · ' + fmtTime(j.time_start) + (j.time_end ? '–' + fmtTime(j.time_end) : '') : ''}
        </div>
        ${j.address ? `<div class="sub">📍 ${esc(j.address)} ${mapsUrl ? `— <a href="${mapsUrl}" target="_blank">directions</a>` : ''}</div>` : ''}
      </div>
      <div class="btn-row">
        ${j.status !== 'complete' && j.status !== 'canceled' ? `<button class="btn success" id="completeJob">✓ Mark Complete</button>` : ''}
        ${j.status === 'complete' ? `
          <button class="btn" id="invoiceJob">💵 Create invoice</button>
          <button class="btn secondary" id="reviewJob">⭐ Ask for a review</button>` : ''}
        <button class="btn secondary" id="editJob">Edit</button>
        <button class="btn danger" id="deleteJob">Delete</button>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h2>✅ Checklist ${j.checklist.length ? `(${doneCount}/${j.checklist.length})` : ''}</h2>
        ${j.checklist.length ? j.checklist.map(item => `
          <div class="checklist-item ${item.done ? 'done' : ''}">
            <input type="checkbox" data-check="${item.id}" ${item.done ? 'checked' : ''}>
            <span class="txt">${esc(item.text)}</span>
            <span class="req">${item.requirement === 'photo' ? '<span class="badge blue">📷 photo</span>'
              : item.requirement === 'optional' ? '<span class="badge gray">optional</span>'
              : '<span class="badge amber">required</span>'}</span>
          </div>`).join('') : emptyState('📋', 'No checklist on this job.')}
        <h2 style="margin-top:16px">👷 Crew</h2>
        ${j.workers.length ? j.workers.map(w => `<span class="badge blue">${esc(w.name)}</span> `).join('')
          : '<div class="sub">No one assigned yet.</div>'}
        ${j.notes ? `<h2 style="margin-top:16px">🗒 Notes</h2><div>${esc(j.notes)}</div>` : ''}
      </div>

      <div class="card">
        <h2>⏱ Time on this job</h2>
        ${j.time_entries.length ? `<div class="table-wrap"><table>
          <tr><th>Worker</th><th>In</th><th>Out</th><th style="text-align:right">Hours</th></tr>
          ${j.time_entries.map(t => `
            <tr><td>${esc(t.worker_name)}</td><td>${fmtDateTime(t.clock_in)}</td>
              <td>${t.clock_out ? fmtDateTime(t.clock_out) : '<span class="badge green">on the clock</span>'}</td>
              <td style="text-align:right">${hoursBetween(t.clock_in, t.clock_out).toFixed(2)}</td></tr>`).join('')}
        </table></div>
        <div class="sub" style="margin-top:6px">Total: <b>${j.time_entries.reduce((s, t) => s + hoursBetween(t.clock_in, t.clock_out), 0).toFixed(2)} hours</b></div>`
          : '<div class="sub">No time logged yet. Workers clock in from the Worker View.</div>'}
      </div>

      <div class="card" style="grid-column:1/-1">
        <h2>📷 Photos</h2>
        <div class="btn-row" style="margin-bottom:12px">
          <label class="btn secondary small">📷 Add BEFORE photo<input type="file" accept="image/*" data-photokind="before" hidden></label>
          <label class="btn secondary small">📷 Add AFTER photo<input type="file" accept="image/*" data-photokind="after" hidden></label>
        </div>
        ${j.photos.length ? `<div class="photo-grid">
          ${j.photos.map(p => `
            <div class="ph">
              <a href="/uploads/${esc(p.filename)}" target="_blank"><img src="/uploads/${esc(p.filename)}" loading="lazy"></a>
              <span class="tag">${esc(p.kind)}${p.uploaded_by ? ' · ' + esc(p.uploaded_by) : ''}</span>
            </div>`).join('')}
        </div>` : '<div class="sub">No photos yet. Before/after photos build trust — and protect you.</div>'}
      </div>
    </div>`;

  main.querySelectorAll('[data-check]').forEach((el) => {
    el.addEventListener('change', async () => {
      try { await put(`/checklist-items/${el.dataset.check}`, { done: el.checked }); renderJobDetail(main, id); }
      catch (e) { toastError(e); }
    });
  });
  main.querySelectorAll('[data-photokind]').forEach((el) => {
    el.addEventListener('change', async () => {
      const file = el.files[0];
      if (!file) return;
      const { fileToDataUrl } = await import('../api.js');
      try {
        toast('Uploading photo…');
        await post(`/jobs/${id}/photos`, { data: await fileToDataUrl(file), kind: el.dataset.photokind, uploaded_by: 'Owner' });
        renderJobDetail(main, id);
      } catch (e) { toastError(e); }
    });
  });

  main.querySelector('#completeJob')?.addEventListener('click', async () => {
    const missing = j.checklist.filter(c => !c.done && c.requirement !== 'optional');
    if (missing.length && !(await confirmDialog(
      `${missing.length} required checklist item(s) aren't done yet. Complete the job anyway?`, 'Complete anyway'))) return;
    try {
      await put(`/jobs/${id}`, { status: 'complete' });
      toast('Job complete! 🎉 You can invoice it and ask for a review.');
      renderJobDetail(main, id);
    } catch (e) { toastError(e); }
  });
  main.querySelector('#invoiceJob')?.addEventListener('click', async () => {
    try { const inv = await post(`/invoices/from-job/${id}`); toast(`Invoice ${inv.number} created`); location.hash = `#/invoices/${inv.id}`; }
    catch (e) { toastError(e); }
  });
  main.querySelector('#reviewJob')?.addEventListener('click', async () => {
    if (!j.customer_id) return toast('Attach a customer to this job first', true);
    try { await post('/review-requests', { customer_id: j.customer_id, job_id: j.id }); toast('Review request queued — see the Reviews page'); }
    catch (e) { toastError(e); }
  });
  main.querySelector('#editJob').onclick = () => jobForm({}, () => renderJobDetail(main, id), j);
  main.querySelector('#deleteJob').onclick = async () => {
    if (await confirmDialog(`Delete job "${j.title}"? Time entries and photos on it will be removed.`)) {
      try { await del(`/jobs/${id}`); toast('Job deleted'); location.hash = '#/schedule'; } catch (e) { toastError(e); }
    }
  };
}
