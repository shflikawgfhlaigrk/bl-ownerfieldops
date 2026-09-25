const role = document.getElementById('role');
const form = document.getElementById('login');
function fields() {
  document.getElementById('ownerField').hidden = role.value === 'worker';
  document.getElementById('workerFields').hidden = role.value !== 'worker';
}
if (new URLSearchParams(location.search).has('worker')) role.value = 'worker';
role.addEventListener('change', fields);
fields();
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('submit'), error = document.getElementById('error');
  error.textContent = ''; button.disabled = true;
  const worker = role.value === 'worker';
  try {
    const response = await fetch(worker ? '/api/worker-login' : '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(worker ? { worker_id: document.getElementById('workerId').value, pin: document.getElementById('pin').value } : { password: document.getElementById('password').value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign-in failed.');
    location.replace(worker ? '/#/worker' : '/#/');
  } catch (err) { error.textContent = err.message; }
  finally { button.disabled = false; }
});
