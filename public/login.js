const f = document.getElementById('loginForm');
const err = document.getElementById('err');
const btn = document.getElementById('btn');
const totpBox = document.getElementById('totpBox');
const totpInput = document.getElementById('totp');

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  try {
    const payload = {
      username: f.username.value,
      password: f.password.value,
    };
    if (totpInput && totpInput.value.trim()) {
      payload.totp = totpInput.value.trim();
    }
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.success) { location.href = '/'; return; }
    if (d.requireTotp) {
      if (totpBox) totpBox.classList.remove('hidden');
      if (totpInput) {
        totpInput.value = '';
        totpInput.focus();
      }
      err.textContent = d.error || d.message || 'Ange 6-siffrig 2FA-kod.';
      btn.textContent = 'Verifiera 2FA & Logga in';
      return;
    }
    err.textContent = d.error || `Fel ${res.status}`;
    f.password.value = '';
  } catch {
    err.textContent = 'Kunde inte nå servern.';
  } finally {
    btn.disabled = false;
  }
});
