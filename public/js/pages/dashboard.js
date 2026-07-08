// Owner dashboard — today at a glance.
import { get, esc, money, fmtTime, fmtDateTime, hoursBetween } from '../api.js';
import { badge, emptyState } from '../ui.js';

export async function renderDashboard(main) {
  const d = await get('/dashboard');

  const jobRow = (j) => `
    <div class="list-item click" onclick="location.hash='#/jobs/${j.id}'">
      <div>
        <div><b>${j.time_start ? fmtTime(j.time_start) : 'Anytime'}</b> — ${esc(j.title)}</div>
        <div class="sub">${esc(j.customer_name || 'No customer')}${j.address ? ' · ' + esc(j.address) : ''}
          ${j.workers?.length ? ' · ' + j.workers.map(w => esc(w.name)).join(', ') : ''}</div>
      </div>
      ${badge(j.status)}
    </div>`;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'} 👋</h1>
        <div class="sub">${esc(d.business_name)} — here's your day.</div>
      </div>
      <div class="btn-row">
        <a class="btn secondary" href="#/leads">+ New Lead</a>
        <a class="btn" href="#/schedule">+ Schedule a Job</a>
      </div>
    </div>

    <div class="grid cols-4" style="margin-bottom:14px">
      <div class="card stat"><div class="label">Money collected this month</div>
        <div class="value money">${money(d.revenue_month)}</div></div>
      <div class="card stat"><div class="label">Waiting to be paid</div>
        <div class="value ${d.unpaid_total > 0 ? 'warn' : ''}">${money(d.unpaid_total)}</div>
        <div class="sub">${d.unpaid_invoices.length} invoice${d.unpaid_invoices.length === 1 ? '' : 's'}</div></div>
      <div class="card stat"><div class="label">New leads to follow up</div>
        <div class="value">${d.new_lead_count}</div></div>
      <div class="card stat"><div class="label">Review requests waiting</div>
        <div class="value">${d.pending_reviews}</div>
        ${d.unread_messages ? `<div class="sub">💬 ${d.unread_messages} unread customer message${d.unread_messages === 1 ? '' : 's'}</div>` : ''}</div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h2>📅 Today's jobs</h2>
        ${d.todays_jobs.length ? d.todays_jobs.map(jobRow).join('') : emptyState('🌤️', 'Nothing scheduled today.', 'Enjoy it, or go close some leads!')}
        <div style="margin-top:10px"><a class="more" href="#/schedule">Open the full schedule →</a></div>
      </div>

      <div class="card">
        <h2>⏱️ Who's on the clock</h2>
        ${d.clocked_in_now.length ? d.clocked_in_now.map(w => `
          <div class="list-item">
            <div><b>${esc(w.name)}</b>
              <div class="sub">${w.job_title ? 'On: ' + esc(w.job_title) : 'No job attached'} · since ${fmtDateTime(w.clock_in)}</div></div>
            <span class="badge green">${hoursBetween(w.clock_in).toFixed(1)}h</span>
          </div>`).join('') : emptyState('💤', 'No one is clocked in right now.')}
        <h2 style="margin-top:16px">This week's hours</h2>
        ${d.worker_hours_week.length ? d.worker_hours_week.map(w => `
          <div class="list-item"><div>${esc(w.name)}</div><b>${w.hours}h</b></div>`).join('')
          : `<div class="sub">No hours logged yet this week.</div>`}
      </div>

      <div class="card">
        <h2>🎯 New leads</h2>
        ${d.new_leads.length ? d.new_leads.map(l => `
          <div class="list-item click" onclick="location.hash='#/leads'">
            <div><b>${esc(l.name)}</b>
              <div class="sub">${esc(l.service_type || 'Service TBD')}${l.source ? ' · from ' + esc(l.source) : ''}</div></div>
            ${l.value_estimate ? `<span class="badge green">~${money(l.value_estimate)}</span>` : ''}
          </div>`).join('') : emptyState('🎣', 'No new leads waiting.', 'New leads land here automatically.')}
        <div style="margin-top:10px"><a class="more" href="#/leads">Open the pipeline →</a></div>
      </div>

      <div class="card">
        <h2>📝 Open quotes</h2>
        ${d.open_quotes.length ? d.open_quotes.map(quote => `
          <div class="list-item click" onclick="location.hash='#/quotes/${quote.id}'">
            <div><b>${esc(quote.title || 'Quote #' + quote.id)}</b>
              <div class="sub">${esc(quote.who || '')}</div></div>
            <div style="text-align:right">${badge(quote.status)}<div class="sub">${money(quote.subtotal)}</div></div>
          </div>`).join('') : emptyState('✍️', 'No open quotes.', 'Create one from a lead or a customer.')}
        <div style="margin-top:10px"><a class="more" href="#/quotes">All quotes →</a></div>
      </div>

      <div class="card" style="grid-column:1/-1">
        <h2>💵 Unpaid invoices</h2>
        ${d.unpaid_invoices.length ? `<div class="table-wrap"><table>
          <tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Status</th><th style="text-align:right">Amount</th></tr>
          ${d.unpaid_invoices.map(i => `
            <tr class="click" onclick="location.hash='#/invoices/${i.id}'">
              <td><b>${esc(i.number)}</b></td><td>${esc(i.customer_name || '')}</td>
              <td>${esc(i.due_date || '')}</td><td>${badge(i.status)}</td>
              <td style="text-align:right"><b>${money(i.total)}</b></td></tr>`).join('')}
        </table></div>` : emptyState('🎉', 'Everything is paid up!')}
      </div>
    </div>`;
}
