// Invoices — list, detail editor, payment links, print view.
import { get, post, put, del, esc, money, fmtDate } from '../api.js';
import { toast, toastError, openModal, confirmDialog, input, select, readForm, badge, emptyState } from '../ui.js';

export async function renderInvoices(main) {
  const invoices = await get('/invoices');
  const owed = invoices.filter(i => ['sent', 'overdue'].includes(i.status)).reduce((s, i) => s + i.total, 0);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Invoices</h1>
        <div class="sub">${owed > 0 ? `<b>${money(owed)}</b> is out there waiting to be collected.` : 'All caught up.'}</div></div>
      <button class="btn" id="newInvoice">+ New Invoice</button>
    </div>
    <div class="card">
      ${invoices.length ? `<div class="table-wrap"><table>
        <tr><th>Invoice</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th style="text-align:right">Amount</th></tr>
        ${invoices.map(i => `
          <tr class="click" onclick="location.hash='#/invoices/${i.id}'">
            <td><b>${esc(i.number)}</b></td>
            <td>${esc(i.customer_name || '—')}</td>
            <td>${fmtDate(i.issue_date)}</td>
            <td>${fmtDate(i.due_date)}</td>
            <td>${badge(i.status)}</td>
            <td style="text-align:right"><b>${money(i.total)}</b></td>
          </tr>`).join('')}
      </table></div>` : emptyState('💵', 'No invoices yet.', 'Finish a job or approve a quote, then turn it into an invoice in one click.')}
    </div>`;

  main.querySelector('#newInvoice').onclick = async () => {
    const customers = await get('/customers');
    const { root, close } = openModal(`
      <h2>New invoice</h2>
      ${select('customer_id', 'Customer', [['', '— pick a customer —'], ...customers.map(c => [c.id, c.name])])}
      ${input('due_date', 'Due date', '', { type: 'date' })}
      <div class="modal-actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn" id="mk">Create</button>
      </div>`);
    root.querySelector('#mk').onclick = async () => {
      const f = readForm(root);
      try {
        const inv = await post('/invoices', { ...f, items: [{ description: 'Service', qty: 1, unit_price: 0 }] });
        close(); location.hash = `#/invoices/${inv.id}`;
      } catch (e) { toastError(e); }
    };
  };
}

export async function renderInvoiceDetail(main, id) {
  const inv = await get(`/invoices/${id}`);
  let items = inv.items.map(it => ({ ...it }));

  const draw = () => {
    const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
    const discount = Number(main.querySelector('#iDiscount')?.value ?? inv.discount) || 0;
    const taxRate = Number(main.querySelector('#iTax')?.value ?? inv.tax_rate) || 0;
    const total = Math.max(0, subtotal - discount) * (1 + taxRate / 100);

    main.innerHTML = `
      <div class="page-head">
        <div>
          <a href="#/invoices">← All invoices</a>
          <h1>${esc(inv.number)} ${badge(inv.status)}</h1>
          <div class="sub">${inv.customer_name ? `<a href="#/customers/${inv.customer_id}">${esc(inv.customer_name)}</a>` : 'No customer'} ·
            issued ${fmtDate(inv.issue_date)} · due ${fmtDate(inv.due_date) || '—'}</div>
        </div>
        <div class="btn-row">
          ${inv.status === 'draft' ? `<button class="btn" id="markSent">📤 Mark as Sent</button>` : ''}
          ${['sent', 'overdue'].includes(inv.status) ? `<button class="btn success" id="markPaid">✓ Mark as Paid</button>` : ''}
          <a class="btn secondary" href="/invoice/${inv.id}/print" target="_blank">🖨 Print / PDF</a>
        </div>
      </div>

      <div class="card">
        <h2>Line items</h2>
        <div class="table-wrap"><table>
          <tr><th>Description</th><th style="width:90px">Qty</th><th style="width:120px">Price each</th><th style="width:110px;text-align:right">Amount</th><th style="width:40px"></th></tr>
          ${items.map((it, i) => `
            <tr>
              <td><input data-i="${i}" data-k="description" value="${esc(it.description)}"></td>
              <td><input data-i="${i}" data-k="qty" type="number" step="0.25" value="${it.qty}"></td>
              <td><input data-i="${i}" data-k="unit_price" type="number" step="0.01" value="${it.unit_price}"></td>
              <td style="text-align:right"><b>${money((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</b></td>
              <td><button class="btn small danger" data-del="${i}">✕</button></td>
            </tr>`).join('')}
        </table></div>
        <button class="btn secondary small" id="addItem" style="margin-top:10px">+ Add line</button>

        <div style="display:flex;justify-content:flex-end;margin-top:14px">
          <div style="min-width:280px">
            <div class="list-item"><span>Subtotal</span><b>${money(subtotal)}</b></div>
            <div class="list-item"><span>Discount ($)</span>
              <input id="iDiscount" type="number" step="0.01" value="${discount}" style="width:110px;text-align:right"></div>
            <div class="list-item"><span>Tax (%)</span>
              <input id="iTax" type="number" step="0.01" value="${taxRate}" style="width:110px;text-align:right"></div>
            <div class="list-item" style="font-size:18px"><span><b>Total due</b></span><b>${money(total)}</b></div>
          </div>
        </div>

        <label class="field" style="margin-top:8px"><span>Due date</span>
          <input id="iDue" type="date" value="${esc(inv.due_date || '')}" style="max-width:200px"></label>

        <div class="modal-actions" style="justify-content:flex-end">
          <button class="btn" id="saveInv">Save changes</button>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <h2>💳 Payment link</h2>
        <div class="sub" style="margin-bottom:8px">Paste any payment link (Stripe, Square, Venmo, PayPal…) — it shows on the invoice and in the customer portal.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="payLink" value="${esc(inv.payment_link || '')}" placeholder="https://…" style="flex:1;min-width:220px">
          <button class="btn secondary" id="savePayLink">Save link</button>
          <button class="btn" id="stripeLink">⚡ Generate with Stripe</button>
        </div>
      </div>`;

    main.querySelectorAll('[data-k]').forEach((el) =>
      el.addEventListener('change', () => {
        items[Number(el.dataset.i)][el.dataset.k] = el.type === 'number' ? Number(el.value) : el.value;
        draw();
      }));
    main.querySelectorAll('[data-del]').forEach((el) =>
      el.addEventListener('click', () => { items.splice(Number(el.dataset.del), 1); draw(); }));
    main.querySelector('#addItem').onclick = () => { items.push({ description: '', qty: 1, unit_price: 0 }); draw(); };
    main.querySelector('#iDiscount').addEventListener('change', draw);
    main.querySelector('#iTax').addEventListener('change', draw);

    const save = (extra = {}) => put(`/invoices/${inv.id}`, {
      items,
      discount: Number(main.querySelector('#iDiscount').value) || 0,
      tax_rate: Number(main.querySelector('#iTax').value) || 0,
      due_date: main.querySelector('#iDue').value,
      ...extra,
    });

    main.querySelector('#saveInv').onclick = async () => {
      try { await save(); toast('Invoice saved'); renderInvoiceDetail(main, id); } catch (e) { toastError(e); }
    };
    main.querySelector('#markSent')?.addEventListener('click', async () => {
      try { await save({ status: 'sent' }); toast('Marked as sent'); renderInvoiceDetail(main, id); } catch (e) { toastError(e); }
    });
    main.querySelector('#markPaid')?.addEventListener('click', async () => {
      try { await save({ status: 'paid' }); toast('💰 Paid — congrats!'); renderInvoiceDetail(main, id); } catch (e) { toastError(e); }
    });
    main.querySelector('#savePayLink').onclick = async () => {
      try { await save({ payment_link: main.querySelector('#payLink').value.trim() }); toast('Payment link saved'); }
      catch (e) { toastError(e); }
    };
    main.querySelector('#stripeLink').onclick = async () => {
      try {
        await save(); // persist items first so the link amount is right
        const r = await post(`/invoices/${inv.id}/stripe-link`);
        toast('Stripe payment link created');
        renderInvoiceDetail(main, id);
      } catch (e) { toastError(e); }
    };
  };
  draw();
}
