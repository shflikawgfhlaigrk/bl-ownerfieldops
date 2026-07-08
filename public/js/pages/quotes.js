// Quotes — list, quote builder with line items, and the estimate calculator.
import { get, post, put, del, esc, money, fmtDate, todayStr } from '../api.js';
import { toast, toastError, openModal, confirmDialog, input, textarea, select, readForm, badge, emptyState } from '../ui.js';

export async function renderQuotes(main) {
  const quotes = await get('/quotes');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Quotes</h1><div class="sub">Price the work, send it, get a yes.</div></div>
      <div class="btn-row">
        <button class="btn secondary" id="calcBtn">🧮 Estimate Calculator</button>
        <button class="btn" id="newQuote">+ New Quote</button>
      </div>
    </div>
    <div class="card">
      ${quotes.length ? `<div class="table-wrap"><table>
        <tr><th>Quote</th><th>For</th><th>Status</th><th>Expires</th><th style="text-align:right">Total</th></tr>
        ${quotes.map(quote => `
          <tr class="click" onclick="location.hash='#/quotes/${quote.id}'">
            <td><b>${esc(quote.title || 'Quote #' + quote.id)}</b>
              ${quote.service_type ? `<div class="sub">${esc(quote.service_type)}</div>` : ''}</td>
            <td>${esc(quote.customer_name || quote.lead_name || '—')}</td>
            <td>${badge(quote.status)}</td>
            <td>${quote.expires_on ? fmtDate(quote.expires_on) : '—'}</td>
            <td style="text-align:right"><b>${money(quote.total)}</b></td>
          </tr>`).join('')}
      </table></div>` : emptyState('📝', 'No quotes yet.', 'Start with the Estimate Calculator or hit + New Quote.')}
    </div>`;
  main.querySelector('#newQuote').onclick = () => quoteForm(null, (saved) => { location.hash = `#/quotes/${saved.id}`; });
  main.querySelector('#calcBtn').onclick = () => estimateCalculator();
}

async function pickerOptions() {
  const [customers, leads] = await Promise.all([get('/customers'), get('/leads')]);
  return {
    customers: [['', '— none —'], ...customers.map(c => [c.id, c.name])],
    leads: [['', '— none —'], ...leads.filter(l => !['lost'].includes(l.stage)).map(l => [l.id, l.name])],
  };
}

export async function quoteForm(quote, onSaved, prefillItems) {
  const q = quote || {};
  const opts = await pickerOptions();
  const { root, close } = openModal(`
    <h2>${q.id ? 'Edit quote' : 'New quote'}</h2>
    ${input('title', 'Quote title *', q.title || '', { placeholder: 'e.g. Backyard cleanup — Smith residence' })}
    <div class="form-row">
      ${select('customer_id', 'Customer', opts.customers, q.customer_id || '')}
      ${select('lead_id', 'Or lead', opts.leads, q.lead_id || '')}
    </div>
    <div class="form-row">
      ${input('service_type', 'Service type', q.service_type || '')}
      ${input('expires_on', 'Good until', q.expires_on || '', { type: 'date' })}
    </div>
    ${textarea('notes', 'Notes for the customer', q.notes || '')}
    <div class="modal-actions">
      <button class="btn secondary" data-close>Cancel</button>
      <button class="btn" id="saveQuote">${q.id ? 'Save' : 'Create quote'}</button>
    </div>`);
  root.querySelector('#saveQuote').onclick = async () => {
    const f = readForm(root);
    if (!f.title.trim()) return toast('Give the quote a title', true);
    if (prefillItems) f.items = prefillItems;
    try {
      const saved = q.id ? await put(`/quotes/${q.id}`, f) : await post('/quotes', f);
      close(); toast('Quote saved'); onSaved?.(saved);
    } catch (e) { toastError(e); }
  };
}

// ---------- Quote detail: line items editor ----------
export async function renderQuoteDetail(main, id) {
  const quote = await get(`/quotes/${id}`);
  let items = quote.items.map(it => ({ ...it }));

  const KIND = [['labor', 'Labor'], ['material', 'Materials'], ['fee', 'Fee (travel, disposal…)']];

  const draw = () => {
    const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
    const discount = Number(main.querySelector('#qDiscount')?.value ?? quote.discount) || 0;
    const taxRate = Number(main.querySelector('#qTax')?.value ?? quote.tax_rate) || 0;
    const afterDiscount = Math.max(0, subtotal - discount);
    const total = afterDiscount * (1 + taxRate / 100);

    main.innerHTML = `
      <div class="page-head">
        <div>
          <a href="#/quotes">← All quotes</a>
          <h1>${esc(quote.title || 'Quote #' + quote.id)} ${badge(quote.status)}</h1>
          <div class="sub">For ${esc(quote.customer_name || quote.lead_name || '—')}
            ${quote.expires_on ? ' · good until ' + fmtDate(quote.expires_on) : ''}</div>
        </div>
        <div class="btn-row">
          ${quote.status === 'draft' ? `<button class="btn" id="markSent">📤 Mark as Sent</button>` : ''}
          ${quote.status === 'sent' ? `<button class="btn success" id="markApproved">✓ Mark Approved</button>` : ''}
          ${quote.status === 'approved' ? `
            <button class="btn" id="makeJob">📅 Schedule the job</button>
            <button class="btn secondary" id="makeInvoice">💵 Turn into invoice</button>` : ''}
          <button class="btn secondary" id="editQuote">Edit details</button>
        </div>
      </div>

      ${quote.portal_token && quote.status === 'sent' ? `
        <div class="card" style="margin-bottom:14px;background:#f2f6ff">
          💡 The customer can view & approve this quote at their portal link:
          <b>${location.origin}/portal/${esc(quote.portal_token)}</b>
          <button class="btn small secondary" id="copyPortalQ" style="margin-left:8px">Copy</button>
        </div>` : ''}

      <div class="card">
        <h2>What's included</h2>
        <div class="table-wrap"><table id="itemsTable">
          <tr><th style="width:130px">Type</th><th>Description</th><th style="width:80px">Qty</th><th style="width:110px">Price each</th><th style="width:100px;text-align:right">Amount</th><th style="width:40px"></th></tr>
          ${items.map((it, i) => `
            <tr>
              <td><select data-i="${i}" data-k="kind">${KIND.map(([v, t]) => `<option value="${v}" ${it.kind === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
              <td><input data-i="${i}" data-k="description" value="${esc(it.description)}" placeholder="Describe the work or item"></td>
              <td><input data-i="${i}" data-k="qty" type="number" step="0.25" value="${it.qty}"></td>
              <td><input data-i="${i}" data-k="unit_price" type="number" step="0.01" value="${it.unit_price}"></td>
              <td style="text-align:right"><b>${money((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</b></td>
              <td><button class="btn small danger" data-del="${i}">✕</button></td>
            </tr>`).join('')}
        </table></div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn secondary small" id="addItem">+ Add line</button>
          <button class="btn secondary small" id="calcInto">🧮 Add from calculator</button>
        </div>

        <div style="display:flex;justify-content:flex-end;margin-top:16px">
          <div style="min-width:280px">
            <div class="list-item"><span>Subtotal</span><b>${money(subtotal)}</b></div>
            <div class="list-item"><span>Discount ($)</span>
              <input id="qDiscount" type="number" step="0.01" value="${discount}" style="width:110px;text-align:right"></div>
            <div class="list-item"><span>Tax (%)</span>
              <input id="qTax" type="number" step="0.01" value="${taxRate}" style="width:110px;text-align:right"></div>
            <div class="list-item" style="font-size:18px"><span><b>Total</b></span><b>${money(total)}</b></div>
          </div>
        </div>
        <div class="modal-actions" style="justify-content:flex-end">
          <button class="btn" id="saveItems">Save changes</button>
        </div>
      </div>
      ${quote.notes ? `<div class="card" style="margin-top:14px"><h2>Notes</h2>${esc(quote.notes)}</div>` : ''}`;

    // wire item edits
    main.querySelectorAll('[data-k]').forEach((el) => {
      el.addEventListener('change', () => {
        items[Number(el.dataset.i)][el.dataset.k] = el.type === 'number' ? Number(el.value) : el.value;
        draw();
      });
    });
    main.querySelectorAll('[data-del]').forEach((el) => {
      el.addEventListener('click', () => { items.splice(Number(el.dataset.del), 1); draw(); });
    });
    main.querySelector('#addItem').onclick = () => { items.push({ kind: 'labor', description: '', qty: 1, unit_price: 0 }); draw(); };
    main.querySelector('#calcInto').onclick = () => estimateCalculator((calcItems) => { items.push(...calcItems); draw(); });
    main.querySelector('#qDiscount').addEventListener('change', draw);
    main.querySelector('#qTax').addEventListener('change', draw);

    const save = async (extra = {}) => put(`/quotes/${quote.id}`, {
      items,
      discount: Number(main.querySelector('#qDiscount').value) || 0,
      tax_rate: Number(main.querySelector('#qTax').value) || 0,
      ...extra,
    });

    main.querySelector('#saveItems').onclick = async () => {
      try { await save(); toast('Quote saved'); renderQuoteDetail(main, id); } catch (e) { toastError(e); }
    };
    main.querySelector('#markSent')?.addEventListener('click', async () => {
      try { await save({ status: 'sent' }); toast('Marked as sent — share the portal link with the customer'); renderQuoteDetail(main, id); }
      catch (e) { toastError(e); }
    });
    main.querySelector('#markApproved')?.addEventListener('click', async () => {
      try { await save({ status: 'approved' }); toast('Approved! 🎉'); renderQuoteDetail(main, id); } catch (e) { toastError(e); }
    });
    main.querySelector('#makeJob')?.addEventListener('click', () => {
      location.hash = `#/schedule?quote=${quote.id}`;
    });
    main.querySelector('#makeInvoice')?.addEventListener('click', async () => {
      try { const inv = await post(`/invoices/from-quote/${quote.id}`); toast(`Invoice ${inv.number} created`); location.hash = `#/invoices/${inv.id}`; }
      catch (e) { toastError(e); }
    });
    main.querySelector('#copyPortalQ')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(`${location.origin}/portal/${quote.portal_token}`); toast('Portal link copied'); }
      catch { prompt('Copy:', `${location.origin}/portal/${quote.portal_token}`); }
    });
    main.querySelector('#editQuote').onclick = () => quoteForm(quote, () => renderQuoteDetail(main, id));
  };
  draw();
}

// ---------- Estimate calculator ----------
export function estimateCalculator(onUse) {
  const { root, close } = openModal(`
    <h2>🧮 Estimate Calculator</h2>
    <div class="form-row thirds">
      ${input('hours', 'Labor hours', '4', { type: 'number', step: '0.5' })}
      ${input('workers', 'Workers', '1', { type: 'number', step: '1' })}
      ${input('rate', 'Rate per hour ($)', '50', { type: 'number', step: '1' })}
    </div>
    <div class="form-row thirds">
      ${input('materials', 'Materials cost ($)', '0', { type: 'number', step: '0.01' })}
      ${input('travel', 'Travel fee ($)', '0', { type: 'number', step: '0.01' })}
      ${input('markup', 'Markup on materials (%)', '20', { type: 'number', step: '1' })}
    </div>
    ${input('tax', 'Tax (%)', '0', { type: 'number', step: '0.01' })}
    <div class="card" style="background:#f2f6ff;margin-top:4px" id="calcOut"></div>
    <div class="modal-actions">
      <button class="btn secondary" data-close>Close</button>
      ${onUse ? '<button class="btn" id="useCalc">Use these numbers</button>' : '<button class="btn" id="calcToQuote">Save as a new quote</button>'}
    </div>`);

  const compute = () => {
    const f = readForm(root);
    const labor = (Number(f.hours) || 0) * (Number(f.workers) || 0) * (Number(f.rate) || 0);
    const materials = (Number(f.materials) || 0) * (1 + (Number(f.markup) || 0) / 100);
    const travel = Number(f.travel) || 0;
    const subtotal = labor + materials + travel;
    const total = subtotal * (1 + (Number(f.tax) || 0) / 100);
    root.querySelector('#calcOut').innerHTML = `
      <div class="list-item"><span>Labor (${f.hours}h × ${f.workers} worker${f.workers == 1 ? '' : 's'} × ${money(f.rate)}/h)</span><b>${money(labor)}</b></div>
      <div class="list-item"><span>Materials with ${f.markup}% markup</span><b>${money(materials)}</b></div>
      <div class="list-item"><span>Travel fee</span><b>${money(travel)}</b></div>
      <div class="list-item" style="font-size:17px"><span><b>Suggested price (with tax)</b></span><b>${money(total)}</b></div>`;
    return { f, labor, materials, travel, tax: Number(f.tax) || 0 };
  };
  root.querySelectorAll('input').forEach((el) => el.addEventListener('input', compute));
  const result = compute();

  const buildItems = () => {
    const { f, labor, materials, travel } = compute();
    const items = [];
    if (labor > 0) items.push({ kind: 'labor', description: `Labor — ${f.hours} hrs × ${f.workers} worker(s)`, qty: 1, unit_price: +labor.toFixed(2) });
    if (materials > 0) items.push({ kind: 'material', description: 'Materials', qty: 1, unit_price: +materials.toFixed(2) });
    if (travel > 0) items.push({ kind: 'fee', description: 'Travel fee', qty: 1, unit_price: +travel.toFixed(2) });
    return items;
  };

  root.querySelector('#useCalc')?.addEventListener('click', () => { onUse(buildItems()); close(); });
  root.querySelector('#calcToQuote')?.addEventListener('click', async () => {
    const items = buildItems();
    const { f } = compute();
    close();
    quoteForm({ tax_rate: f.tax }, (saved) => { location.hash = `#/quotes/${saved.id}`; }, items);
  });
}
