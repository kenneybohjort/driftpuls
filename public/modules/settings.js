// Modul: Integrationer (FrameFlow, Webhooks, Nodregister, Användare & 2FA, Revisionslogg, Backup & Systemstatus)

function updateNodeDatalist() {
  const dl = $('nodeList');
  if (!dl || !appSettings || !Array.isArray(appSettings.nodes)) return;
  dl.innerHTML = appSettings.nodes.map((n) => `<option value="${esc(n.name)}">${esc(n.name)} (${n.domain === 'fjarrvarme' ? 'Fjärrvärme' : 'Stadsnät'}${n.customers ? `, ~${n.customers} kunder` : ''})</option>`).join('');
}

async function loadSettingsData() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      appSettings = data;
      updateNodeDatalist();
    }
  } catch {}
}

function showSettingsTab(tab) {
  document.querySelectorAll('[data-action="settingsTab"]').forEach((b) => b.setAttribute('aria-selected', b.dataset.arg === tab));
  $('stab-ff').classList.toggle('hidden', tab !== 'ff');
  $('stab-nodes').classList.toggle('hidden', tab !== 'nodes');
  $('stab-users')?.classList.toggle('hidden', tab !== 'users');
  $('stab-system')?.classList.toggle('hidden', tab !== 'system');
  $('stab-audit')?.classList.toggle('hidden', tab !== 'audit');
  const saveBtn = $('saveSettingsBtn');
  if (saveBtn) {
    const hideSave = tab === 'users' || tab === 'system' || tab === 'audit' || currentUserRole !== 'admin';
    saveBtn.classList.toggle('hidden', hideSave);
  }
  if (tab === 'users') loadUsers();
  if (tab === 'system') loadSystemInfo();
  if (tab === 'audit') loadAuditLog();
}

function renderNodesEditor(nodes) {
  const box = $('nodesList');
  if (!box) return;
  const list = Array.isArray(nodes) ? nodes : [];
  box.innerHTML = list.map((n, idx) => {
    const critList = Array.isArray(n.critical)
      ? n.critical
      : String(n.critical || '').split(',').map((s) => s.trim()).filter(Boolean);
    const crits = new Set(critList);
    const matchStr = Array.isArray(n.keywords) ? n.keywords.join(', ') : (n.match || '');
    return `
    <div class="node-row bg-inset border border-line p-2.5 rounded-xl grid grid-cols-1 sm:grid-cols-12 gap-2 items-center text-xs" data-idx="${idx}">
      <div class="sm:col-span-2">
        <input type="text" class="field text-xs node-name" value="${esc(n.name || '')}" placeholder="t.ex. Arbrå">
      </div>
      <div class="sm:col-span-2">
        <select class="field text-xs node-domain">
          <option value="stadsnat" ${n.domain !== 'fjarrvarme' ? 'selected' : ''}>Stadsnät</option>
          <option value="fjarrvarme" ${n.domain === 'fjarrvarme' ? 'selected' : ''}>Fjärrvärme</option>
        </select>
      </div>
      <div class="sm:col-span-3">
        <input type="text" class="field font-mono text-xs node-keywords" value="${esc(matchStr)}" placeholder="arbra, nod-arbra">
      </div>
      <div class="sm:col-span-1">
        <input type="number" min="0" max="100000" class="field font-mono text-xs node-customers" value="${esc(n.customers ?? 0)}" placeholder="Kunder" title="Totalt antal kunder i noden">
      </div>
      <div class="sm:col-span-1">
        <input type="number" min="1" max="100" class="field font-mono text-xs node-dist" value="${esc(n.distCount ?? 1)}" placeholder="1" title="Antal dist-switchar i fiberboden (1 dist-switch rymmer max 24 acc-switchar)">
      </div>
      <div class="sm:col-span-1">
        <input type="number" min="1" max="500" class="field font-mono text-xs node-acc" value="${esc(n.accCount ?? 24)}" placeholder="24" title="Antal faktiskt inkopplade access-switchar i fiberboden (1 acc-switch rymmer max 24 kunder)">
      </div>
      <div class="sm:col-span-2 flex items-center justify-between gap-1">
        <div class="flex flex-wrap gap-1 text-[10px]">
          <label class="px-1.5 py-0.5 rounded bg-card border border-line cursor-pointer" title="Vård & omsorg"><input type="checkbox" value="care" class="node-crit accent-brand" ${crits.has('care') ? 'checked' : ''}> Vård</label>
          <label class="px-1.5 py-0.5 rounded bg-card border border-line cursor-pointer" title="Blåljus / 112"><input type="checkbox" value="112" class="node-crit accent-brand" ${crits.has('112') ? 'checked' : ''}> 112</label>
          <label class="px-1.5 py-0.5 rounded bg-card border border-line cursor-pointer" title="Kommunal ledning"><input type="checkbox" value="municipal" class="node-crit accent-brand" ${crits.has('municipal') ? 'checked' : ''}> Kom</label>
          <label class="px-1.5 py-0.5 rounded bg-card border border-line cursor-pointer" title="Energi / VA"><input type="checkbox" value="energy" class="node-crit accent-brand" ${crits.has('energy') ? 'checked' : ''}> Energi</label>
        </div>
        <button type="button" data-del-node="${idx}" class="text-muted hover:text-danger font-bold px-1.5 text-sm" title="Ta bort nod">&times;</button>
      </div>
    </div>`;
  }).join('');
}

function collectNodesFromEditor() {
  const rows = [...document.querySelectorAll('#nodesList .node-row')];
  return rows.map((r, i) => {
    const accCount = Math.max(1, parseInt(r.querySelector('.node-acc')?.value, 10) || 24);
    const rawDist = Math.max(1, parseInt(r.querySelector('.node-dist')?.value, 10) || 1);
    const distCount = Math.max(rawDist, Math.ceil(accCount / 24));
    return {
      id: `node-${i + 1}`,
      name: r.querySelector('.node-name').value.trim(),
      domain: r.querySelector('.node-domain').value,
      match: r.querySelector('.node-keywords').value.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean).join(', '),
      customers: Math.max(0, parseInt(r.querySelector('.node-customers').value, 10) || 0),
      distCount,
      accCount,
      critical: [...r.querySelectorAll('.node-crit:checked')].map((cb) => cb.value).join(', '),
    };
  }).filter((n) => n.name);
}

function populateSettingsDialog() {
  if (!appSettings) return;
  const ff = appSettings.frameflow || {};
  $('ffPushEnabled').checked = ff.pushEnabled !== false;
  $('ffWebhookUrl').value = ff.webhookUrl || `${location.origin}/api/ingest/frameflow`;
  $('ffIngestToken').value = ff.ingestToken || '';
  $('ffPullEnabled').checked = Boolean(ff.pullEnabled);
  $('ffApiUrl').value = ff.apiUrl || '';
  $('ffApiKey').value = ff.apiKey || '';
  $('ffPollInterval').value = ff.pollIntervalSec || 60;
  $('ffPushStatus').textContent = ff.lastPushAt ? `Senaste Push mottagen: ${fmtTs(ff.lastPushAt)}` : 'Ingen Push mottagen ännu.';
  $('ffPollStatus').textContent = ff.lastPollAt
    ? `Senaste API-polling: ${fmtTs(ff.lastPollAt)} (${ff.lastPollMsg || (ff.lastPollOk ? 'OK' : 'Fel')})`
    : 'Ingen API-polling har körts ännu.';

  const nf = appSettings.notifications || {};
  if ($('notifEnabled')) $('notifEnabled').checked = Boolean(nf.enabled);
  if ($('notifWebhookUrl')) $('notifWebhookUrl').value = nf.webhookUrl || '';
  if ($('notifOnAlert')) $('notifOnAlert').checked = nf.onFrameFlowAlert !== false;
  if ($('notifOnPublish')) $('notifOnPublish').checked = Boolean(nf.onPublish);
  if ($('notifStatus')) {
    $('notifStatus').textContent = nf.lastSentAt
      ? `Senaste notis: ${fmtTs(nf.lastSentAt)} (${nf.lastSentMsg || (nf.lastSentOk ? 'OK' : 'Fel')})`
      : 'Ingen utgående notis har skickats ännu.';
  }

  renderNodesEditor(appSettings.nodes || []);
}

async function openSettings() {
  $('settingsMsg').textContent = '';
  await loadSettingsData();
  populateSettingsDialog();
  const activeTab = document.querySelector('[data-action="settingsTab"][aria-selected="true"]')?.dataset.arg || 'ff';
  showSettingsTab(activeTab);
  $('settingsDlg').showModal();
}

async function saveSettings() {
  const btn = $('saveSettingsBtn');
  btn.disabled = true;
  try {
    const payload = {
      frameflow: {
        pushEnabled: $('ffPushEnabled').checked,
        pullEnabled: $('ffPullEnabled').checked,
        apiUrl: $('ffApiUrl').value.trim(),
        apiKey: $('ffApiKey').value,
        pollIntervalSec: Number($('ffPollInterval').value) || 60,
      },
      notifications: {
        enabled: $('notifEnabled') ? $('notifEnabled').checked : false,
        webhookUrl: $('notifWebhookUrl') ? $('notifWebhookUrl').value.trim() : '',
        onFrameFlowAlert: $('notifOnAlert') ? $('notifOnAlert').checked : true,
        onPublish: $('notifOnPublish') ? $('notifOnPublish').checked : false,
      },
      nodes: collectNodesFromEditor(),
    };
    const res = await api('/api/settings', payload);
    appSettings = res;
    updateNodeDatalist();
    populateSettingsDialog();
    $('settingsMsg').textContent = '✓ Inställningar och nodregister sparade!';
    toast('Inställningar sparade!');
  } catch (e) {
    toast(`Kunde inte spara inställningar: ${e.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

async function rotateToken() {
  try {
    const res = await api('/api/settings/rotate-token', {});
    $('ffIngestToken').value = res.ingestToken;
    if (appSettings && appSettings.frameflow) appSettings.frameflow.ingestToken = res.ingestToken;
    toast('Ny Webhook Bearer-token genererad!');
  } catch (e) {
    toast(`Kunde inte rotera token: ${e.message}`, false);
  }
}

async function testFrameFlow() {
  const statusEl = $('ffPollStatus');
  statusEl.textContent = 'Testar anslutning mot FrameFlow API...';
  try {
    const res = await api('/api/frameflow/test', {
      apiUrl: $('ffApiUrl').value.trim(),
      apiKey: $('ffApiKey').value,
    });
    statusEl.textContent = `✅ Anslutning OK! (${res.latencyMs || 0} ms, ${res.itemCount || 0} objekt lästa)`;
    toast('FrameFlow API-anslutning fungerar!');
  } catch (e) {
    statusEl.textContent = `❌ Fel: ${e.message}`;
    toast(`API-test misslyckades: ${e.message}`, false);
  }
}

async function testNotification() {
  const statusEl = $('notifStatus');
  const url = $('notifWebhookUrl')?.value.trim();
  if (!url) {
    toast('Ange en utgående Webhook-URL först.', false);
    return;
  }
  statusEl.textContent = 'Skickar testnotis...';
  try {
    const res = await api('/api/notifications/test', { webhookUrl: url });
    statusEl.textContent = `✅ Testnotis skickad (${res.msg || 'HTTP 200'})`;
    toast('Testnotis skickad till webhook!');
  } catch (e) {
    statusEl.textContent = `❌ Fel: ${e.message}`;
    toast(`Kunde inte skicka testnotis: ${e.message}`, false);
  }
}

// ---------- Användarhantering, Behörighet & 2FA (TOTP) ----------
function renderMyTotpState() {
  const badge = $('myTotpBadge');
  const setupBtn = $('setupTotpBtn');
  const setupBox = $('totpSetupBox');
  const disableBox = $('totpDisableBox');
  if (!badge) return;
  if (myTotpEnabled) {
    badge.textContent = '🔐 Aktiv';
    badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30';
    if (setupBtn) setupBtn.classList.add('hidden');
    if (setupBox) setupBox.classList.add('hidden');
    if (disableBox) disableBox.classList.remove('hidden');
  } else {
    badge.textContent = 'Inaktiv';
    badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-semibold bg-card border border-line text-muted';
    if (setupBtn) setupBtn.classList.remove('hidden');
    if (disableBox) disableBox.classList.add('hidden');
  }
}

async function setupMyTotp() {
  const msg = $('myTotpMsg');
  if (msg) msg.textContent = '';
  try {
    const res = await api('/api/users/totp/setup', {});
    $('totpSecretValue').value = res.secret || '';
    $('totpUriValue').value = res.otpauthUrl || '';
    $('totpVerifyCode').value = '';
    $('totpSetupBox').classList.remove('hidden');
    $('totpVerifyCode').focus();
  } catch (e) {
    if (msg) msg.textContent = `❌ ${e.message}`;
    toast(e.message, false);
  }
}

async function enableMyTotp() {
  const token = ($('totpVerifyCode')?.value || '').trim();
  const msg = $('myTotpMsg');
  if (msg) msg.textContent = '';
  if (!/^\d{6}$/.test(token)) {
    toast('Ange den 6-siffriga koden från din autentiseringsapp.', false);
    return;
  }
  try {
    await api('/api/users/totp/enable', { token });
    myTotpEnabled = true;
    $('totpSetupBox').classList.add('hidden');
    if (msg) msg.textContent = '✓ Tvåfaktorsautentisering (2FA) är nu aktiverat på ditt konto!';
    toast('2FA aktiverat!');
    renderMyTotpState();
    loadUsers();
  } catch (e) {
    if (msg) msg.textContent = `❌ ${e.message}`;
    toast(e.message, false);
  }
}

async function disableMyTotp() {
  const currentPassword = $('totpDisablePw')?.value || '';
  const msg = $('myTotpMsg');
  if (msg) msg.textContent = '';
  if (!currentPassword) {
    toast('Ange ditt nuvarande lösenord för att stänga av 2FA.', false);
    return;
  }
  try {
    await api('/api/users/totp/disable', { currentPassword });
    myTotpEnabled = false;
    $('totpDisablePw').value = '';
    if (msg) msg.textContent = '✓ 2FA har inaktiverats på ditt konto.';
    toast('2FA inaktiverat.');
    renderMyTotpState();
    loadUsers();
  } catch (e) {
    if (msg) msg.textContent = `❌ ${e.message}`;
    toast(e.message, false);
  }
}

async function loadUsers() {
  const box = $('usersList');
  if (!box) return;
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.currentUser) currentUser = data.currentUser;
    if (data.currentRole) currentUserRole = data.currentRole;
    const list = data.users || [];
    const meRec = list.find((u) => u.username === currentUser);
    if (meRec) myTotpEnabled = Boolean(meRec.totpEnabled);
    renderMyTotpState();

    const adminSection = $('adminUsersSection');
    if (adminSection) {
      adminSection.classList.toggle('hidden', currentUserRole !== 'admin');
    }

    const adminCount = list.filter((u) => u.role !== 'tekniker').length;
    box.innerHTML = list.map((u) => {
      const isMe = u.username === currentUser;
      const isTech = u.role === 'tekniker';
      const isLastAdmin = !isTech && adminCount <= 1;
      const canDel = list.length > 1 && !isLastAdmin;
      const roleBadge = isTech
        ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/15 text-sky-600 dark:text-sky-400 font-semibold">Tekniker</span>'
        : '<span class="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold">Admin</span>';
      const totpBadge = u.totpEnabled
        ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-semibold" title="Tvåfaktorsautentisering aktivt">🔐 2FA</span>'
        : '';
      return `
      <div class="bg-card border border-line p-2.5 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono font-bold text-fg">👤 ${esc(u.username)}</span>
          ${roleBadge}
          ${totpBadge}
          ${isMe ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-brand/15 text-accent font-semibold">Inloggad (du)</span>' : ''}
          ${u.created ? `<span class="text-[10px] text-faint">Uppdaterad: ${esc(fmtTs(u.created))}</span>` : ''}
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <select data-role-for="${esc(u.username)}" class="field text-xs !py-1 !px-2 !w-28" ${isLastAdmin ? 'disabled title="Sista admin-kontot kan inte nedgraderas"' : ''}>
            <option value="admin" ${!isTech ? 'selected' : ''}>Admin</option>
            <option value="tekniker" ${isTech ? 'selected' : ''}>Tekniker</option>
          </select>
          <input type="password" data-pw-for="${esc(u.username)}" placeholder="Nytt lösenord (minst 12 tkn)" class="field text-xs !py-1 !px-2 !w-40">
          <button type="button" data-reset-pw="${esc(u.username)}" class="btn text-accent">Sätt lösenord</button>
          ${u.totpEnabled ? `<button type="button" data-reset-totp="${esc(u.username)}" class="btn text-amber-600 dark:text-amber-400" title="Nollställ 2FA för kontot">Nollställ 2FA</button>` : ''}
          ${canDel ? `<button type="button" data-del-user="${esc(u.username)}" class="btn text-danger" title="Ta bort konto">Ta bort</button>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-danger">Kunde inte hämta konton: ${esc(e.message)}</p>`;
  }
}

async function changeMyPassword() {
  const cur = $('myCurrentPw').value;
  const nw = $('myNewPw').value;
  const nw2 = $('myNewPw2').value;
  const msg = $('myPwMsg');
  msg.textContent = '';
  if (!cur || !nw) {
    toast('Fyll i både nuvarande och nytt lösenord.', false);
    return;
  }
  if (nw.length < 12) {
    toast('Det nya lösenordet måste vara minst 12 tecken.', false);
    return;
  }
  if (nw !== nw2) {
    toast('De nya lösenorden matchar inte.', false);
    return;
  }
  try {
    await api('/api/users/password', { currentPassword: cur, newPassword: nw });
    $('myCurrentPw').value = '';
    $('myNewPw').value = '';
    $('myNewPw2').value = '';
    msg.textContent = '✓ Ditt lösenord har uppdaterats!';
    toast('Lösenordet är bytt!');
    loadUsers();
  } catch (e) {
    msg.textContent = `❌ ${e.message}`;
    toast(e.message, false);
  }
}

async function addUser() {
  const username = $('newUsername').value.trim();
  const password = $('newUserPw').value;
  const role = $('newUserRole')?.value || 'tekniker';
  const msg = $('userAdminMsg');
  msg.textContent = '';
  if (!username || !password) {
    toast('Ange både användarnamn och startlösenord.', false);
    return;
  }
  try {
    await api('/api/users/add', { username, password, role });
    $('newUsername').value = '';
    $('newUserPw').value = '';
    msg.textContent = `✓ Kontot "${username}" (${role}) har skapats!`;
    toast(`Användare "${username}" skapad!`);
    loadUsers();
  } catch (e) {
    msg.textContent = `❌ ${e.message}`;
    toast(e.message, false);
  }
}

// ---------- Revisionslogg (Audit Log Viewer) ----------
let auditItemsCache = [];

const AUDIT_LABELS = {
  login: ['Inloggning OK', 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'],
  login_failed: ['Misslyckad inloggning', 'bg-red-500/15 text-red-600 dark:text-red-400'],
  login_totp_failed: ['Felaktig 2FA-kod', 'bg-red-500/15 text-red-600 dark:text-red-400'],
  logout: ['Utloggning', 'bg-card text-muted border border-line'],
  password_changed: ['Eget lösenord bytt', 'bg-sky-500/15 text-sky-600 dark:text-sky-400'],
  password_change_failed: ['Misslyckat lösenordsbyte', 'bg-red-500/15 text-red-600 dark:text-red-400'],
  totp_setup_started: ['2FA-konfiguration startad', 'bg-sky-500/15 text-sky-600 dark:text-sky-400'],
  totp_enabled: ['2FA aktiverat', 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'],
  totp_disabled: ['2FA inaktiverat', 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  create: ['Ärende skapat & publicerat', 'bg-brand/15 text-accent'],
  update: ['Ärende uppdaterat', 'bg-brand/15 text-accent'],
  close: ['Ärende avslutat & arkiverat', 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'],
  reopen: ['Ärende återöppnat', 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  delete_incident: ['Pågående ärende raderat', 'bg-red-500/15 text-red-600 dark:text-red-400'],
  delete_archive: ['Avslutat ärende raderat ur arkiv', 'bg-red-500/15 text-red-600 dark:text-red-400'],
  nis2_update: ['NIS2-komplettering i arkiv', 'bg-sky-500/15 text-sky-600 dark:text-sky-400'],
  auto_archive_planned: ['Planerat arbete auto-arkiverat', 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'],
  user_added: ['Användare skapad', 'bg-brand/15 text-accent'],
  user_role_updated: ['Roll ändrad', 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  user_removed: ['Användare borttagen', 'bg-red-500/15 text-red-600 dark:text-red-400'],
  user_password_reset: ['Lösenord återställt av admin', 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  user_totp_reset: ['2FA nollställt av admin', 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  settings_update: ['Inställningar sparade', 'bg-sky-500/15 text-sky-600 dark:text-sky-400'],
  rotate_ingest_token: ['Webhook-token roterad', 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  frameflow_push: ['FrameFlow Push-larm', 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  frameflow_poll: ['FrameFlow API-polling', 'bg-sky-500/15 text-sky-600 dark:text-sky-400'],
  frameflow_simulate: ['Simulerat larm', 'bg-card text-muted border border-line'],
  frameflow_webhook_locked: ['Webhook spärrad (brute-force)', 'bg-red-500/15 text-red-600 dark:text-red-400'],
  backup_exported: ['Backup exporterad', 'bg-sky-500/15 text-sky-600 dark:text-sky-400'],
  backup_restored: ['Backup återställd', 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  notification_test: ['Testnotis skickad', 'bg-sky-500/15 text-sky-600 dark:text-sky-400'],
};

async function loadAuditLog() {
  const box = $('auditList');
  const sum = $('auditSummary');
  if (!box) return;
  const q = ($('auditSearch')?.value || '').trim();
  const category = $('auditCategory')?.value || 'all';
  try {
    const params = new URLSearchParams({ limit: '250', category });
    if (q) params.set('q', q);
    const res = await fetch(`/api/audit?${params}`);
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    auditItemsCache = data.entries || data.items || [];
    if (sum) {
      sum.textContent = `Visar ${auditItemsCache.length} av ${data.totalMatched ?? auditItemsCache.length} matchande händelser (totalt ${data.totalScanned ?? auditItemsCache.length} i loggen)`;
    }
    renderAuditLog(auditItemsCache);
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-danger">Kunde inte läsa revisionslogg: ${esc(e.message)}</p>`;
  }
}

function renderAuditLog(items) {
  const box = $('auditList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<p class="text-xs text-faint py-4 text-center">Inga logghändelser matchar filtret.</p>';
    return;
  }
  box.innerHTML = items.map((entry) => {
    const evKey = entry.action || entry.event || 'händelse';
    const [label, badgeCls] = AUDIT_LABELS[evKey] || [evKey, 'bg-card text-fg2 border border-line'];
    const { ts, action, event, by, user, ip, category, ...rest } = entry;
    const actor = by || user || '';
    const targetUser = by && user && by !== user ? `mål: ${user}` : '';
    const details = [
      targetUser,
      ...Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`),
    ].filter(Boolean).join(' · ');
    return `
    <div class="bg-card border border-line rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      <div class="flex flex-wrap items-center gap-2 min-w-0">
        <span class="font-mono text-[11px] text-faint shrink-0">${esc(fmtTs(ts))}</span>
        <span class="px-2 py-0.5 rounded-md text-[10px] font-semibold shrink-0 ${badgeCls}">${esc(label)}</span>
        ${actor ? `<span class="font-mono font-semibold text-fg shrink-0">👤 ${esc(actor)}</span>` : ''}
        ${details ? `<span class="text-muted truncate max-w-md" title="${esc(details)}">${esc(details)}</span>` : ''}
      </div>
      <div class="flex items-center gap-2 text-[10px] font-mono text-faint shrink-0">
        <span>${esc(evKey)}</span>
        ${ip ? `<span>· IP ${esc(ip)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function exportAudit() {
  const blob = new Blob([JSON.stringify(auditItemsCache, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `revisionslogg-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Revisionslogg exporterad (.json)');
}

// ---------- Backup & Systeminfo ----------
const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

async function loadSystemInfo() {
  const box = $('systemInfoBox');
  if (!box) return;
  try {
    const res = await fetch('/api/system-info');
    const d = await res.json();
    if (!res.ok || !d.success) throw new Error(d.error || `HTTP ${res.status}`);
    const upHrs = (Number(d.uptimeSeconds ?? d.uptimeSec ?? 0) / 3600).toFixed(1);
    const items = [
      ['Node.js-version', d.nodeVersion || '?'],
      ['App-version', d.appVersion || UI_VERSION],
      ['Upptid (admin)', `${upHrs} tim`],
      ['Användarkonton', `${d.counts?.users ?? 0} st`],
      ['Aktiva ärenden', `${d.counts?.activeIncidents ?? 0} st`],
      ['NIS2-rapporter (.md)', `${d.counts?.nis2Reports ?? d.counts?.reports ?? 0} st`],
      ['Arkiv (arkiv.jsonl)', fmtBytes(d.sizes?.arkivBytes ?? d.storage?.archiveBytes)],
      ['Auditlogg (roteras >5MB)', fmtBytes(d.sizes?.auditBytes ?? d.storage?.auditBytes)],
    ];
    box.innerHTML = items.map(([k, v]) => `
      <div class="p-2.5 rounded-xl bg-card border border-line">
        <span class="text-faint block text-[10px]">${esc(k)}</span>
        <span class="font-mono font-bold text-fg text-xs">${esc(v)}</span>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-danger col-span-4">Kunde inte hämta systemstatus: ${esc(e.message)}</p>`;
  }
}

function downloadBackup() {
  const a = document.createElement('a');
  a.href = '/api/backup/export';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast('Laddar ner komplett säkerhetskopia (.json)...');
}

let pendingRestorePayload = null;

async function previewRestoreFile() {
  const input = $('restoreBackupFile');
  const prevBox = $('restorePreview');
  const msg = $('restoreBackupMsg');
  if (!input || !prevBox || !msg) return;
  pendingRestorePayload = null;
  msg.textContent = '';

  const file = input.files?.[0];
  if (!file) {
    prevBox.classList.add('hidden');
    prevBox.textContent = '';
    return;
  }
  try {
    const raw = await file.text();
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') throw new Error('Ogiltigt JSON-format');
    const incCount = Array.isArray(json.incidents) ? json.incidents.length : 0;
    const arcCount = Array.isArray(json.archive) ? json.archive.length : 0;
    const nodCount = Array.isArray(json.settings?.nodes) ? json.settings.nodes.length : 0;
    const expAt = json.exportedAt ? fmtTs(json.exportedAt) : 'Okänd tidpunkt';
    prevBox.textContent = `📦 Förhandsvisning (${file.name}): Exporterad ${expAt} | Aktiva ärenden: ${incCount} st | Arkiverade ärenden: ${arcCount} st | Noder: ${nodCount} st`;
    prevBox.classList.remove('hidden');
    pendingRestorePayload = json;
  } catch (err) {
    prevBox.classList.add('hidden');
    msg.textContent = `❌ Kunde inte läsa backup-fil: ${err.message}`;
  }
}

async function restoreBackup() {
  const input = $('restoreBackupFile');
  const msg = $('restoreBackupMsg');
  if (!pendingRestorePayload && input?.files?.[0]) {
    await previewRestoreFile();
  }
  if (!pendingRestorePayload) {
    toast('Välj en giltig backup-fil (.json) först.', false);
    return;
  }
  const incCount = Array.isArray(pendingRestorePayload.incidents) ? pendingRestorePayload.incidents.length : 0;
  const arcCount = Array.isArray(pendingRestorePayload.archive) ? pendingRestorePayload.archive.length : 0;
  if (!confirm(`Vill du återställa vald säkerhetskopia (${incCount} aktiva ärenden, ${arcCount} arkiverade ärenden)?\n\nEn automatisk säkerhetskopia av nuvarande data sparas först till data/pre-restore-backup.json.`)) {
    return;
  }
  try {
    const res = await api('/api/backup/restore', pendingRestorePayload);
    const r = res.restored || {};
    if (msg) {
      msg.textContent = `✓ Återställde ${r.incidents ?? 0} aktiva ärenden, ${r.archive ?? 0} arkiverade ärenden och inställningar!`;
    }
    toast('Säkerhetskopia återställd och NIS2-rapporter återskapade!');
    if (input) input.value = '';
    if ($('restorePreview')) $('restorePreview').classList.add('hidden');
    pendingRestorePayload = null;
    await loadSettingsData();
    populateSettingsDialog();
    await loadSystemInfo();
    await fetchIncidents();
    await fetchArchive();
    await fetchAlerts();
  } catch (err) {
    if (msg) msg.textContent = `❌ Återställning misslyckades: ${err.message}`;
    toast(`Kunde inte återställa backup: ${err.message}`, false);
  }
}
