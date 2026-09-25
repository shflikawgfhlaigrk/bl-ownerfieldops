// App shell: sidebar navigation + hash router.
import { renderDashboard } from './pages/dashboard.js';
import { renderCustomers, renderCustomerDetail } from './pages/customers.js';
import { renderLeads } from './pages/leads.js';
import { renderQuotes, renderQuoteDetail } from './pages/quotes.js';
import { renderSchedule, renderJobDetail } from './pages/schedule.js';
import { renderWorkerApp } from './pages/worker.js';
import { renderInvoices, renderInvoiceDetail } from './pages/invoices.js';
import { renderGrowth } from './pages/growth.js';
import { get, post, esc } from './api.js';
// These optional page modules are absent in this checkout. Load them only when
// selected, so their existing absence does not prevent sign-in or other pages.
const renderReports = async (...args) => (await import('./pages/reports.js')).renderReports(...args);
const renderSettings = async (...args) => (await import('./pages/settings.js')).renderSettings(...args);

const NAV = [
  { section: 'Run the day' },
  { path: '/', icon: '🏠', label: 'Dashboard' },
  { path: '/schedule', icon: '📅', label: 'Schedule' },
  { path: '/worker', icon: '🧰', label: 'Worker View' },
  { section: 'Sales' },
  { path: '/leads', icon: '🎯', label: 'Leads' },
  { path: '/quotes', icon: '📝', label: 'Quotes' },
  { path: '/prospects', icon: '🏢', label: 'Commercial Prospects' },
  { section: 'Customers & money' },
  { path: '/customers', icon: '👥', label: 'Customers' },
  { path: '/invoices', icon: '💵', label: 'Invoices' },
  { section: 'Grow' },
  { path: '/reviews', icon: '⭐', label: 'Reviews' },
  { path: '/referrals', icon: '🤝', label: 'Referrals' },
  { path: '/automations', icon: '⚡', label: 'Automations' },
  { section: 'Manage' },
  { path: '/reports', icon: '📊', label: 'Reports' },
  { path: '/settings', icon: '⚙️', label: 'Settings & Workers' },
];

const ROUTES = [
  [/^\/$/, renderDashboard],
  [/^\/customers$/, renderCustomers],
  [/^\/customers\/(\d+)$/, renderCustomerDetail],
  [/^\/leads$/, renderLeads],
  [/^\/quotes$/, renderQuotes],
  [/^\/quotes\/(\d+)$/, renderQuoteDetail],
  [/^\/schedule$/, renderSchedule],
  [/^\/jobs\/(\d+)$/, renderJobDetail],
  [/^\/worker/, renderWorkerApp],
  [/^\/invoices$/, renderInvoices],
  [/^\/invoices\/(\d+)$/, renderInvoiceDetail],
  [/^\/(reviews|referrals|prospects|automations)$/, renderGrowth],
  [/^\/reports$/, renderReports],
  [/^\/settings/, renderSettings],
];

function currentPath() {
  return (location.hash.replace(/^#/, '') || '/').split('?')[0];
}

function renderNav() {
  const path = currentPath();
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML =
    `<a class="logo" href="#/">Owner<span>FieldOps</span></a>` +
    NAV.map((item) => {
      if (item.section) return `<div class="nav-section">${item.section}</div>`;
      const active = item.path === '/' ? path === '/' : path.startsWith(item.path);
      return `<a class="nav-link ${active ? 'active' : ''}" href="#${item.path}">
        <span class="icon">${item.icon}</span>${item.label}</a>`;
    }).join('');
  sidebar.classList.remove('open');
}

async function route() {
  const path = currentPath();
  const session = await get('/auth/session');
  if (!session.authenticated) { location.replace('/login.html'); return; }
  if (session.role === 'worker' && !path.startsWith('/worker')) { location.hash = '#/worker'; return; }
  document.body.classList.toggle('worker-mode', path.startsWith('/worker'));
  renderNav();
  const logout = document.createElement('button');
  logout.className = 'btn secondary'; logout.textContent = 'Sign out';
  logout.onclick = async () => { await post('/auth/logout', {}); location.replace('/login.html'); };
  document.getElementById('sidebar').appendChild(logout);
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  window.scrollTo(0, 0);
  for (const [re, handler] of ROUTES) {
    const m = path.match(re);
    if (m) {
      try {
        await handler(main, ...m.slice(1));
      } catch (err) {
        console.error(err);
        main.innerHTML = `<div class="card"><div class="empty"><span class="big">😕</span>
          Something went wrong: ${esc(err.message || err)}<br><br>
          <button class="btn secondary" onclick="location.reload()">Reload</button></div></div>`;
      }
      return;
    }
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);
document.getElementById('menuBtn').addEventListener('click', () =>
  document.getElementById('sidebar').classList.toggle('open'));
document.addEventListener('click', (e) => {
  const sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target.id !== 'menuBtn') {
    sidebar.classList.remove('open');
  }
});

route();
