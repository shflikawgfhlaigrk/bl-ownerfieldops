// Worker View — phone-friendly screen for the crew: today's jobs, clock in/out
// with GPS stamp, checklist, photos, notes, mark complete. PIN login,
// remembered on the device.
import { get, post, put, esc, fmtTime, fmtDate, fmtDateTime, todayStr, hoursBetween, getGps, fileToDataUrl } from '../api.js';
import { toast, toastError, badge, emptyState, confirmDialog } from '../ui.js';

const LS_KEY = 'ofo_worker';

const savedWorker = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
};

export async function renderWorkerApp(main) {
  const me = savedWorker();
  if (!me) return renderLogin(main);

  let status;
  try {
    status = await get(`/clock-status/${me.id}`);
  } catch {
    localStorage.removeItem(LS_KEY);
    return renderLogin(main);
  }

  const today = todayStr();
  const jobs = await get(`/jobs?worker_id=${me.id}&from=${today}`);
  const todayJobs = jobs.filter(j => j.date === today && j.status !== 'canceled');
  const upcoming = jobs.filter(j => j.date > today && j.status === 'scheduled').slice(0, 5);

  main.innerHTML = `
    <div class="worker-topbar">
      <div class="hello">Hi, ${esc(me.name.split(' ')[0])} 👋</div>
      <button class="btn secondary small" id="logout">Switch worker</button>
    </div>

    <div class="clock-banner ${status.clocked_in ? 'working' : ''}">
      <div class="status">${status.clocked_in
        ? `You're ON the clock${status.entry.job_title ? ' — ' + esc(status.entry.job_title) : ''}`
        : `You're off the clock`}</div>
      <div class="time">${status.clocked_in
        ? hoursBetween(status.entry.clock_in).toFixed(1) + ' hours so far'
        : new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      ${status.clocked_in
        ? `<button class="btn big" style="background:#fff;color:#157a40;width:100%" id="clockOut">⏹ Clock Out</button>`
        : `<button class="btn big" style="background:#fff;color:var(--brand-dark);width:100%" id="clockIn">▶ Clock In</button>`}
    </div>

    <h2 style="font-size:16px;margin:6px 2px 10px">Today's jobs (${todayJobs.length})</h2>
    ${todayJobs.length ? todayJobs.map(j => workerJobCard(j)).join('')
      : `<div class="card">${emptyState('🌤️', 'No jobs assigned to you today.')}</div>`}

    ${upcoming.length ? `
      <h2 style="font-size:16px;margin:18px 2px 10px">Coming up</h2>
      ${upcoming.map(j => `
        <div class="card" style="margin-bottom:8px">
          <b>${esc(j.title)}</b> ${badge(j.status)}
          <div class="sub">${fmtDate(j.date)}${j.time_start ? ' · ' + fmtTime(j.time_start) : ''} · ${esc(j.customer_name || '')}</div>
        </div>`).join('')}` : ''}`;

  main.querySelector('#logout').onclick = () => { localStorage.removeItem(LS_KEY); renderWorkerApp(main); };

  main.querySelector('#clockIn')?.addEventListener('click', async () => {
    const btn = main.querySelector('#clockIn');
    btn.disabled = true; btn.textContent = 'Getting your location…';
    const gps = await getGps();
    try {
      // if exactly one job today, attach the clock-in to it automatically
      const jobId = todayJobs.length === 1 ? todayJobs[0].id : null;
      await post('/clock-in', { worker_id: me.id, job_id: jobId, gps });
      toast(gps ? 'Clocked in (location saved)' : 'Clocked in');
      renderWorkerApp(main);
    } catch (e) { toastError(e); renderWorkerApp(main); }
  });

  main.querySelector('#clockOut')?.addEventListener('click', async () => {
    const btn = main.querySelector('#clockOut');
    btn.disabled = true; btn.textContent = 'Getting your location…';
    const gps = await getGps();
    try {
      await post('/clock-out', { worker_id: me.id, gps });
      toast('Clocked out — nice work today 💪');
      renderWorkerApp(main);
    } catch (e) { toastError(e); renderWorkerApp(main); }
  });

  main.querySelectorAll('[data-open-job]').forEach(el =>
    el.addEventListener('click', () => renderWorkerJob(main, Number(el.dataset.openJob), me)));
}

function workerJobCard(j) {
  return `
    <div class="card" style="margin-bottom:10px;cursor:pointer" data-open-job="${j.id}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <b>${j.time_start ? fmtTime(j.time_start) : 'Anytime'} — ${esc(j.title)}</b>
          <div class="sub">${esc(j.customer_name || '')}</div>
          ${j.address ? `<div class="sub">📍 ${esc(j.address)}</div>` : ''}
        </div>
        <div style="text-align:right">${badge(j.status)}
          ${j.checklist_total ? `<div class="sub">✅ ${j.checklist_done}/${j.checklist_total}</div>` : ''}</div>
      </div>
    </div>`;
}

async function renderWorkerJob(main, jobId, me) {
  const j = await get(`/jobs/${jobId}`);
  const status = await get(`/clock-status/${me.id}`);
  const onThisJob = status.clocked_in && status.entry.job_id === j.id;
  const before = j.photos.filter(p => p.kind === 'before');
  const after = j.photos.filter(p => p.kind === 'after');

  main.innerHTML = `
    <div class="worker-topbar">
      <button class="btn secondary small" id="backBtn">← My jobs</button>
      ${badge(j.status)}
    </div>

    <div class="card" style="margin-bottom:12px">
      <h2 style="font-size:18px;margin:0 0 4px">${esc(j.title)}</h2>
      <div class="sub">${esc(j.customer_name || '')}${j.customer_phone ? ` · <a href="tel:${esc(j.customer_phone)}">📞 Call</a>` : ''}</div>
      <div class="sub">${fmtDate(j.date)}${j.time_start ? ' · ' + fmtTime(j.time_start) + (j.time_end ? '–' + fmtTime(j.time_end) : '') : ''}</div>
      ${j.address ? `
        <div style="margin-top:8px" class="btn-row">
          <a class="btn secondary small" target="_blank" href="https://maps.apple.com/?daddr=${encodeURIComponent(j.address)}">🧭 Directions</a>
          <a class="btn secondary small" target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(j.address)}">Google Maps</a>
        </div>
        <div class="sub" style="margin-top:6px">📍 ${esc(j.address)}</div>` : ''}
      ${j.notes ? `<div style="margin-top:10px;background:#fdf6ea;border-radius:8px;padding:10px">🗒 ${esc(j.notes)}</div>` : ''}
    </div>

    ${j.status !== 'complete' ? `
      <div class="card" style="margin-bottom:12px">
        ${onThisJob
          ? `<button class="btn big success" style="width:100%" id="jobClockOut">⏹ Clock Out (${hoursBetween(status.entry.clock_in).toFixed(1)}h so far)</button>`
          : status.clocked_in
            ? `<div class="sub" style="margin-bottom:8px">You're clocked in${status.entry.job_title ? ' on ' + esc(status.entry.job_title) : ''}. Clock out there first to start this one.</div>`
            : `<button class="btn big" style="width:100%" id="jobClockIn">▶ Clock In on this job</button>`}
      </div>` : ''}

    <div class="card" style="margin-bottom:12px">
      <h2>✅ Checklist</h2>
      ${j.checklist.length ? j.checklist.map(item => `
        <div class="checklist-item ${item.done ? 'done' : ''}">
          <input type="checkbox" data-check="${item.id}" ${item.done ? 'checked' : ''} ${j.status === 'complete' ? 'disabled' : ''}>
          <span class="txt">${esc(item.text)}</span>
          <span class="req">${item.requirement === 'photo' ? '📷' : item.requirement === 'optional' ? '' : '⚠️'}</span>
        </div>`).join('') : '<div class="sub">No checklist for this job.</div>'}
    </div>

    <div class="card" style="margin-bottom:12px">
      <h2>📷 Before photos (${before.length})</h2>
      ${before.length ? `<div class="photo-grid" style="margin-bottom:10px">${before.map(p =>
        `<a class="ph" href="/uploads/${esc(p.filename)}" target="_blank"><img src="/uploads/${esc(p.filename)}"></a>`).join('')}</div>` : ''}
      <label class="btn secondary" style="width:100%">📷 Take / add BEFORE photo
        <input type="file" accept="image/*" capture="environment" data-photokind="before" hidden></label>
    </div>

    <div class="card" style="margin-bottom:12px">
      <h2>📷 After photos (${after.length})</h2>
      ${after.length ? `<div class="photo-grid" style="margin-bottom:10px">${after.map(p =>
        `<a class="ph" href="/uploads/${esc(p.filename)}" target="_blank"><img src="/uploads/${esc(p.filename)}"></a>`).join('')}</div>` : ''}
      <label class="btn secondary" style="width:100%">📷 Take / add AFTER photo
        <input type="file" accept="image/*" capture="environment" data-photokind="after" hidden></label>
    </div>

    <div class="card" style="margin-bottom:12px">
      <h2>🗒 Add a job note</h2>
      <textarea id="jobNote" placeholder="Anything the boss should know? (gate locked, extra work needed, materials used…)"></textarea>
      <button class="btn secondary" style="margin-top:8px" id="saveNote">Save note</button>
    </div>

    ${j.status !== 'complete' ? `<button class="btn big success" style="width:100%" id="markDone">✓ Mark Job Complete</button>`
      : `<div class="card" style="text-align:center;background:#eefaf2">🎉 This job is complete. Nice work!</div>`}`;

  main.querySelector('#backBtn').onclick = () => renderWorkerApp(main);

  main.querySelectorAll('[data-check]').forEach((el) =>
    el.addEventListener('change', async () => {
      try { await put(`/checklist-items/${el.dataset.check}`, { done: el.checked }); }
      catch (e) { toastError(e); }
      renderWorkerJob(main, jobId, me);
    }));

  main.querySelectorAll('[data-photokind]').forEach((el) =>
    el.addEventListener('change', async () => {
      const file = el.files[0];
      if (!file) return;
      toast('Uploading photo…');
      try {
        await post(`/jobs/${jobId}/photos`, { data: await fileToDataUrl(file), kind: el.dataset.photokind, uploaded_by: me.name });
        toast('Photo saved');
        renderWorkerJob(main, jobId, me);
      } catch (e) { toastError(e); }
    }));

  main.querySelector('#jobClockIn')?.addEventListener('click', async () => {
    const gps = await getGps();
    try { await post('/clock-in', { worker_id: me.id, job_id: jobId, gps }); toast('Clocked in'); renderWorkerJob(main, jobId, me); }
    catch (e) { toastError(e); }
  });
  main.querySelector('#jobClockOut')?.addEventListener('click', async () => {
    const gps = await getGps();
    try { await post('/clock-out', { worker_id: me.id, gps }); toast('Clocked out'); renderWorkerJob(main, jobId, me); }
    catch (e) { toastError(e); }
  });

  main.querySelector('#saveNote')?.addEventListener('click', async () => {
    const note = main.querySelector('#jobNote').value.trim();
    if (!note) return;
    try {
      await put(`/jobs/${jobId}`, { notes: (j.notes ? j.notes + '\n' : '') + `[${me.name}] ${note}` });
      toast('Note saved'); renderWorkerJob(main, jobId, me);
    } catch (e) { toastError(e); }
  });

  main.querySelector('#markDone')?.addEventListener('click', async () => {
    const missing = j.checklist.filter(c => !c.done && c.requirement !== 'optional');
    if (missing.length && !(await confirmDialog(`${missing.length} required item(s) not checked off yet. Finish anyway?`, 'Finish anyway'))) return;
    if (status.clocked_in && status.entry.job_id === j.id) {
      const gps = await getGps();
      await post('/clock-out', { worker_id: me.id, gps }).catch(() => {});
    }
    try { await put(`/jobs/${jobId}`, { status: 'complete' }); toast('Job complete! 🎉'); renderWorkerJob(main, jobId, me); }
    catch (e) { toastError(e); }
  });
}

async function renderLogin(main) {
  const workers = await get('/workers');
  const active = workers.filter(w => w.active);
  main.innerHTML = `
    <div style="max-width:380px;margin:8vh auto 0">
      <div class="card">
        <h2 style="font-size:19px">🧰 Worker sign in</h2>
        ${active.length ? `
          <label class="field"><span>Who are you?</span>
            <select id="wSel">${active.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Your PIN</span>
            <input id="wPin" type="tel" inputmode="numeric" maxlength="8" placeholder="4-digit PIN" autocomplete="off"></label>
          <button class="btn big" style="width:100%" id="wGo">Sign in</button>
          <div class="sub" style="margin-top:10px">Don't know your PIN? Ask the owner — it's on your worker card under Settings & Workers.</div>`
          : `<div class="empty"><span class="big">👷</span>No workers set up yet.<br>
             The owner adds workers (and their PINs) under <b>Settings & Workers</b>.</div>
             <a class="btn secondary" style="width:100%" href="#/settings">Go to Settings</a>`}
      </div>
    </div>`;
  main.querySelector('#wGo')?.addEventListener('click', async () => {
    try {
      const me = await post('/worker-login', {
        worker_id: main.querySelector('#wSel').value,
        pin: main.querySelector('#wPin').value.trim(),
      });
      localStorage.setItem(LS_KEY, JSON.stringify(me));
      renderWorkerApp(main);
    } catch (e) { toastError(e); }
  });
  main.querySelector('#wPin')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') main.querySelector('#wGo').click();
  });
}
