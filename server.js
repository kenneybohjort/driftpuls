const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  DATA_DIR,
  PUBLIC_DIR,
  PUBLIC_URL,
  PORTAL_PORT,
  dataFile,
  archiveFile,
  auditFile,
  settingsFile,
  REPORTS_DIR,
  audit,
  load,
  save,
  loadSettings,
  saveSettings,
  sendNotification,
  loadAlerts,
  saveAlerts,
  loadArchiveRows,
  invalidateArchiveCache,
  matchNode,
  DOMAINS,
  nowLocal,
  todayLocal,
  isDate,
  isTime,
  text,
  clean,
  diff,
  startKey,
} = require('./lib/store');

const {
  calcDuration,
  sanitizeNis2,
  generateCyberReport,
  renderCyberReportHtml,
} = require('./lib/nis2');

const {
  CSS_V,
  buildPublicUpdates,
  loadRecentlyResolved,
  renderRss,
  renderPortal,
  autoArchiveCompletedPlanned,
  generatePublicSite,
  invalidate,
  portal,
} = require('./lib/portal');

const {
  extractFrameFlowItems,
  processFrameFlowPayload,
  scheduleFrameFlowPoller,
  ffAuthFails,
  ffRateWindow,
  cleanupFrameFlowRateLimits,
} = require('./lib/frameflow');

const {
  parseDeviceRole,
  summarizeDevices,
  computeSwitchImpact,
} = require('./public/topology');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER; // används bara för att skapa första kontot
const ADMIN_PASS = process.env.ADMIN_PASS;
const APP_VERSION = '2026.11.05.2'; // höj vid varje ändring: visas i sidans fot så man ser om server och sida är i takt

// ---------- Säkerhetsheaders (gäller oavsett vad proxyn gör) ----------
const CSP_ADMIN = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const headers = (csp) => (req, res, next) => {
  res.set({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
};

// ---------- Admin-appen (port 3000) ----------
const app = express();
app.disable('x-powered-by');
app.use(headers(CSP_ADMIN));
const TRUSTED_PROXIES = ['loopback', 'linklocal', 'uniquelocal', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];
app.set('trust proxy', process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(',').map((s) => s.trim()) : TRUSTED_PROXIES);

const authz = require('./auth')(DATA_DIR);
authz.bootstrap(ADMIN_USER, ADMIN_PASS);

// CSRF-skydd: POST måste komma från samma origin och vara JSON
const csrf = (req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch {}
    if (!ok) return res.status(403).json({ success: false, error: 'Ogiltig origin' });
  }
  if (!req.is('application/json')) return res.status(415).json({ success: false, error: 'JSON krävs' });
  next();
};

// Versionsnummer på JS-filer (inklusive /public/modules/*.js) så att ändringar syns direkt trots lång cache
const JS_V = (() => {
  try {
    const files = [path.join(__dirname, 'public', 'admin.js')];
    const modDir = path.join(__dirname, 'public', 'modules');
    if (fs.existsSync(modDir)) {
      for (const f of fs.readdirSync(modDir)) {
        if (f.endsWith('.js')) files.push(path.join(modDir, f));
      }
    }
    return Math.floor(Math.max(...files.map((p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0))));
  } catch {
    return 0;
  }
})();

// Sidorna serveras med versionsnummer på skript och CSS, så att webbläsaren aldrig kör en gammal kopia
const readPage = (name) => fs.readFileSync(path.join(__dirname, 'public', name), 'utf8')
  .replace('/assets/tailwind.css', `/assets/tailwind.css?v=${CSS_V}`)
  .replace('/theme.js', `/theme.js?v=${JS_V}`)
  .replace('/topology.js', `/topology.js?v=${JS_V}`)
  .replace(/(\/modules\/[\w-]+\.js)/g, `$1?v=${JS_V}`)
  .replace('/admin.js', `/admin.js?v=${JS_V}`)
  .replace('/login.js', `/login.js?v=${JS_V}`);
const ADMIN_HTML = readPage('index.html');
const LOGIN_HTML = readPage('login.html');

// ---------- Admin: publika delar (före inloggning) ----------
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/drift', portal);
app.get('/status.json', (req, res) => {
  const file = path.join(PUBLIC_DIR, 'status.json');
  if (!fs.existsSync(file)) generatePublicSite();
  res.set('Cache-Control', 'no-cache').type('json').sendFile(file);
});
app.get('/rss.xml', (req, res) => {
  const file = path.join(PUBLIC_DIR, 'rss.xml');
  if (!fs.existsSync(file)) generatePublicSite();
  res.set('Cache-Control', 'no-cache').type('application/rss+xml; charset=utf-8').sendFile(file);
});

// Inkommande Webhook från extern FrameFlow-leverantör (Push med Bearer-token / X-FrameFlow-Token / ?token=)
app.post('/api/ingest/frameflow', express.json({ limit: '100kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();

  // 1. Kontrollera om IP är spärrad p.g.a. upprepade felaktiga tokens
  const failRec = ffAuthFails.get(ip);
  if (failRec && failRec.until > now) {
    return res.status(429).json({ success: false, error: 'För många misslyckade autentiseringsförsök. Vänta 15 minuter.' });
  }

  // 2. Rate-limiting mot larmstormar (max 60 anrop / minut per IP)
  let rateRec = ffRateWindow.get(ip);
  if (!rateRec || now > rateRec.resetAt) {
    rateRec = { count: 0, resetAt: now + 60000 };
  }
  rateRec.count++;
  ffRateWindow.set(ip, rateRec);
  if (rateRec.count > 60) {
    return res.status(429).json({ success: false, error: 'Rate-limit överskriden (max 60 anrop per minut).' });
  }

  const settings = loadSettings();
  if (!settings.frameflow.pushEnabled) {
    return res.status(403).json({ success: false, error: 'Inkommande FrameFlow-webhook är inaktiverad i inställningarna.' });
  }
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const supplied = bearer || String(req.headers['x-frameflow-token'] || req.query.token || '').trim();
  const expected = settings.frameflow.ingestToken;
  const bufA = Buffer.from(supplied);
  const bufB = Buffer.from(expected);
  if (!supplied || bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    const f = ffAuthFails.get(ip) || { count: 0, until: 0, ts: 0 };
    f.ts = now;
    if (++f.count >= 10) {
      f.until = now + 15 * 60e3;
      f.count = 0;
      audit('frameflow_webhook_locked', { ip });
    }
    ffAuthFails.set(ip, f);
    return res.status(401).json({ success: false, error: 'Ogiltig eller saknad webhook-token.' });
  }
  ffAuthFails.delete(ip);

  const stats = processFrameFlowPayload(req.body, 'push');
  settings.frameflow.lastPushAt = new Date().toISOString();
  saveSettings(settings);
  audit('frameflow_push', stats);
  res.json({ success: true, ...stats });
});

const pubFile = (name) => (req, res) => res.sendFile(path.join(__dirname, 'public', name));
app.get('/login', (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(LOGIN_HTML));
app.get('/login.js', pubFile('login.js'));
app.get('/theme.js', pubFile('theme.js'));
app.post('/login', csrf, express.json({ limit: '2kb' }), authz.login);

// ---------- Admin: kräver inloggning ----------
app.use(authz.require);
app.use('/api', csrf);
app.use('/api/backup/restore', express.json({ limit: '5mb' }));
app.use(express.json({ limit: '50kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.get(['/', '/index.html'], (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(ADMIN_HTML));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Kontroll av publik driftportal ----------
let portalStatusCache = { data: null, t: 0 };
async function checkPortalHealth() {
  const candidates = [];
  if (process.env.PORTAL_HEALTH_URL) candidates.push(process.env.PORTAL_HEALTH_URL);
  if (PUBLIC_URL) candidates.push(`${PUBLIC_URL.replace(/\/+$/, '')}/healthz`);
  candidates.push(`http://host.docker.internal:${PORTAL_PORT}/healthz`);
  candidates.push(`http://172.17.0.1:${PORTAL_PORT}/healthz`);
  const uniqueUrls = [...new Set(candidates)];
  let lastError = 'Kunde inte ansluta till driftportalen';
  let lastUrl = uniqueUrls[0];
  let lastStatus = 0;

  for (const url of uniqueUrls) {
    lastUrl = url;
    const start = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
      const latency = Date.now() - start;
      const body = await res.text();
      const ok = res.ok && body.trim() === 'ok';
      lastStatus = res.status;
      if (ok) {
        return {
          online: true,
          healthy: true,
          status: res.status,
          latency,
          url,
          lastChecked: new Date().toISOString()
        };
      }
      lastError = `Status ${res.status}`;
    } catch (err) {
      lastError = err.message || 'Kunde inte ansluta till driftportalen';
    }
  }
  return {
    online: false,
    healthy: false,
    status: lastStatus || undefined,
    error: lastError,
    url: lastUrl,
    lastChecked: new Date().toISOString()
  };
}

async function getPortalStatus() {
  const now = Date.now();
  if (portalStatusCache.data && now - portalStatusCache.t < 10000) {
    return portalStatusCache.data;
  }
  const result = await checkPortalHealth();
  portalStatusCache = { data: result, t: now };
  return result;
}

app.get('/api/me', (req, res) => res.json({
  user: req.adminUser,
  role: req.userRole || authz.users.getRole(req.adminUser),
  totpEnabled: authz.users.hasTotp(req.adminUser),
}));
app.get('/api/portal-status', async (req, res) => {
  const status = await getPortalStatus();
  res.json(status);
});
app.get('/api/poll', async (req, res) => {
  const portalStatus = await getPortalStatus();
  const activeAlerts = loadAlerts().filter((a) => !a.dismissed && !a.linkedIncidentId);
  const allIncidents = load();
  const activeIds = new Set(allIncidents.map((i) => i.id));
  const recentlyResolved = loadRecentlyResolved(24, activeIds);
  res.json({
    success: true,
    version: APP_VERSION,
    incidents: allIncidents,
    recentlyResolved,
    alerts: activeAlerts,
    portalStatus,
  });
});
app.post('/api/logout', authz.logout);
app.get('/api/config', (req, res) => res.json({
  publicUrl: PUBLIC_URL,
  portalPort: PORTAL_PORT,
  version: APP_VERSION
}));
app.get('/api/incidents', (req, res) => res.json(load()));

// ---------- Inställningar, Nodregister & FrameFlow Larminkorg ----------
function formatSettingsResponse(req, s) {
  const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol || 'https';
  const host = req.get('host') || 'localhost:3000';
  const isAdmin = (req.userRole || authz.users.getRole(req.adminUser)) === 'admin';
  return {
    success: true,
    frameflow: {
      pullEnabled: s.frameflow.pullEnabled,
      apiUrl: s.frameflow.apiUrl,
      apiKey: s.frameflow.apiKey ? '••••••••' : '',
      hasApiKey: Boolean(s.frameflow.apiKey),
      pollIntervalSec: s.frameflow.pollIntervalSec,
      pushEnabled: s.frameflow.pushEnabled,
      ingestToken: isAdmin ? s.frameflow.ingestToken : '••••••••',
      webhookUrl: `${proto}://${host}/api/ingest/frameflow`,
      lastPollAt: s.frameflow.lastPollAt,
      lastPollOk: s.frameflow.lastPollOk,
      lastPollMsg: s.frameflow.lastPollMsg,
      lastPushAt: s.frameflow.lastPushAt,
    },
    notifications: {
      enabled: Boolean(s.notifications?.enabled),
      webhookUrl: s.notifications?.webhookUrl || '',
      onFrameFlowAlert: s.notifications?.onFrameFlowAlert !== false,
      onPublish: Boolean(s.notifications?.onPublish),
      lastSentAt: s.notifications?.lastSentAt || null,
      lastSentOk: s.notifications?.lastSentOk ?? null,
      lastSentMsg: s.notifications?.lastSentMsg || '',
    },
    nodes: s.nodes,
  };
}

app.get('/api/settings', (req, res) => {
  res.json(formatSettingsResponse(req, loadSettings()));
});

app.post('/api/settings', authz.requireAdmin, (req, res) => {
  const current = loadSettings();
  const ffIn = req.body?.frameflow || {};
  const apiUrl = text(ffIn.apiUrl, 300);
  if (apiUrl && !/^https?:\/\//i.test(apiUrl)) {
    return res.status(400).json({ success: false, error: 'FrameFlow API-URL måste börja med http:// eller https://' });
  }
  current.frameflow.pullEnabled = Boolean(ffIn.pullEnabled);
  current.frameflow.pushEnabled = ffIn.pushEnabled !== false;
  current.frameflow.apiUrl = apiUrl;
  if (ffIn.apiKey !== undefined && ffIn.apiKey !== '••••••••') {
    current.frameflow.apiKey = text(ffIn.apiKey, 300);
  }
  current.frameflow.pollIntervalSec = Math.max(15, Math.min(3600, parseInt(ffIn.pollIntervalSec, 10) || 60));

  if (req.body?.notifications) {
    const nIn = req.body.notifications;
    const whUrl = text(nIn.webhookUrl, 400);
    if (whUrl && !/^https?:\/\//i.test(whUrl)) {
      return res.status(400).json({ success: false, error: 'Utgående Webhook-URL måste börja med http:// eller https://' });
    }
    current.notifications = {
      ...current.notifications,
      enabled: Boolean(nIn.enabled),
      webhookUrl: whUrl,
      onFrameFlowAlert: (nIn.onFrameFlowAlert ?? nIn.onNewAlert) !== false,
      onPublish: Boolean(nIn.onPublish),
    };
  }

  if (Array.isArray(req.body?.nodes)) {
    const cleanNodes = req.body.nodes.map((n) => {
      const accCount = Math.max(1, Math.min(500, parseInt(n.accCount, 10) || 24));
      const rawDist = Math.max(1, Math.min(100, parseInt(n.distCount, 10) || 1));
      return {
        id: text(n.id, 40) || crypto.randomUUID().slice(0, 8),
        name: text(n.name, 80),
        domain: DOMAINS.includes(n.domain) ? n.domain : 'stadsnat',
        match: text(n.match, 200),
        customers: Math.max(0, Math.min(100000, parseInt(n.customers, 10) || 0)),
        distCount: Math.max(rawDist, Math.ceil(accCount / 24)),
        accCount,
        critical: text(n.critical, 120),
      };
    }).filter((n) => n.name);
    if (cleanNodes.length) current.nodes = cleanNodes;
  }

  saveSettings(current);
  scheduleFrameFlowPoller();
  audit('settings_update', {
    by: req.adminUser,
    pullEnabled: current.frameflow.pullEnabled,
    pushEnabled: current.frameflow.pushEnabled,
    notificationsEnabled: current.notifications.enabled,
    nodesCount: current.nodes.length,
  });
  res.json(formatSettingsResponse(req, current));
});

app.post('/api/notifications/test', async (req, res) => {
  const saved = loadSettings();
  const webhookUrl = text(req.body?.webhookUrl ?? saved.notifications?.webhookUrl, 400);
  if (!webhookUrl || !/^https?:\/\//i.test(webhookUrl)) {
    return res.status(400).json({ success: false, error: 'Ange en giltig utgående Webhook-URL (https://...) först.' });
  }
  const result = await sendNotification(
    '🔔 Testnotis från Driftpuls',
    `Skickad av ${req.adminUser} kl ${nowLocal()} för att verifiera larmutskick.`,
    { event: 'test', by: req.adminUser },
    webhookUrl
  );
  if (!result.sent) {
    return res.json({ success: false, error: result.error || 'Kunde inte skicka testnotis.' });
  }
  audit('notification_test', { by: req.adminUser });
  res.json({ success: true, status: result.status });
});

// ---------- Användarhantering, Roller, 2FA (TOTP) & Lösenordsbyte (GUI) ----------
app.get('/api/users', (req, res) => {
  const role = req.userRole || authz.users.getRole(req.adminUser);
  const allUsers = authz.users.listDetailed();
  res.json({
    success: true,
    currentUser: req.adminUser,
    currentRole: role,
    totpEnabled: authz.users.hasTotp(req.adminUser),
    users: role === 'admin' ? allUsers : allUsers.filter((u) => u.username === req.adminUser),
  });
});

app.post('/api/users/password', (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');
    authz.changeOwnPassword(req, currentPassword, newPassword);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/users/totp/setup', (req, res) => {
  try {
    const { secret, otpauthUrl } = authz.users.setupTotp(req.adminUser);
    audit('totp_setup_started', { by: req.adminUser });
    res.json({ success: true, secret, otpauthUrl });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/users/totp/enable', (req, res) => {
  try {
    const token = String(req.body?.token ?? '');
    authz.users.enableTotp(req.adminUser, token);
    audit('totp_enabled', { by: req.adminUser });
    res.json({ success: true, totpEnabled: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/users/totp/disable', (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword ?? '');
    if (!authz.users.verifyPassword(req.adminUser, currentPassword)) {
      return res.status(400).json({ success: false, error: 'Nuvarande lösenord är felaktigt.' });
    }
    authz.users.disableTotp(req.adminUser);
    audit('totp_disabled', { by: req.adminUser });
    res.json({ success: true, totpEnabled: false });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/users/add', authz.requireAdmin, (req, res) => {
  try {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const role = req.body?.role === 'tekniker' ? 'tekniker' : 'admin';
    authz.users.add(username, password, role);
    audit('user_added', { by: req.adminUser, user: username, role });
    res.json({ success: true, users: authz.users.listDetailed() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/users/role', authz.requireAdmin, (req, res) => {
  try {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const role = req.body?.role === 'tekniker' ? 'tekniker' : 'admin';
    authz.users.setRole(username, role);
    audit('user_role_updated', { by: req.adminUser, user: username, role });
    res.json({ success: true, users: authz.users.listDetailed() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/users/reset-password', authz.requireAdmin, (req, res) => {
  try {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const newPassword = String(req.body?.newPassword ?? '');
    authz.users.passwd(username, newPassword);
    audit('user_password_reset', { by: req.adminUser, user: username });
    res.json({ success: true, users: authz.users.listDetailed() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/users/reset-totp', authz.requireAdmin, (req, res) => {
  try {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    authz.users.disableTotp(username);
    audit('user_totp_reset', { by: req.adminUser, user: username });
    res.json({ success: true, users: authz.users.listDetailed() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/users/remove', authz.requireAdmin, (req, res) => {
  try {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    if (username === String(req.adminUser || '').toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Du kan inte ta bort ditt eget inloggade konto.' });
    }
    authz.users.remove(username);
    audit('user_removed', { by: req.adminUser, user: username });
    res.json({ success: true, users: authz.users.listDetailed() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------- Revisionslogg (audit.jsonl) i GUI ----------
const AUDIT_CATEGORIES = {
  auth: new Set([
    'login', 'login_failed', 'login_totp_failed', 'logout',
    'password_changed', 'password_change_failed',
    'totp_setup_started', 'totp_enabled', 'totp_disabled', 'sessions_pruned',
  ]),
  incidents: new Set([
    'create', 'update', 'close', 'reopen', 'nis2_update', 'auto_archive_planned',
    'delete_incident', 'delete_archive',
  ]),
  admin: new Set([
    'bootstrap_user', 'user_added', 'user_removed', 'user_password_reset',
    'user_role_updated', 'user_totp_reset', 'settings_update', 'rotate_ingest_token',
    'backup_exported', 'backup_restored', 'notification_test',
  ]),
  frameflow: new Set([
    'frameflow_push', 'frameflow_poll', 'frameflow_simulate', 'frameflow_webhook_locked',
  ]),
};

function classifyAuditAction(action) {
  for (const [cat, set] of Object.entries(AUDIT_CATEGORIES)) {
    if (set.has(action)) return cat;
  }
  return 'admin';
}

app.get('/api/audit', (req, res) => {
  const q = String(req.query?.q || '').trim().toLowerCase();
  const category = String(req.query?.category || 'all').trim().toLowerCase();
  const limit = Math.max(1, Math.min(1000, parseInt(req.query?.limit, 10) || 200));

  let rawLines = [];
  try {
    if (fs.existsSync(auditFile)) {
      rawLines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
    }
    if (rawLines.length < limit && fs.existsSync(`${auditFile}.1`)) {
      const older = fs.readFileSync(`${auditFile}.1`, 'utf8').split('\n').filter(Boolean);
      rawLines = [...older, ...rawLines];
    }
  } catch {}

  const parsed = [];
  for (let i = rawLines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(rawLines[i]);
      if (!obj || typeof obj !== 'object') continue;
      const cat = classifyAuditAction(obj.action);
      if (category !== 'all' && cat !== category) continue;
      if (q) {
        const hay = JSON.stringify(obj).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      parsed.push({ ...obj, category: cat });
    } catch {}
  }

  const sliced = parsed.slice(0, limit);
  res.json({
    success: true,
    totalScanned: rawLines.length,
    totalMatched: parsed.length,
    entries: sliced,
    items: sliced,
  });
});

// ---------- Backup & Systemstatus (GUI) ----------
app.get('/api/system-info', (req, res) => {
  const fileStat = (f) => {
    try { return fs.existsSync(f) ? fs.statSync(f).size : 0; } catch { return 0; }
  };
  let archiveCount = 0;
  try {
    if (fs.existsSync(archiveFile)) {
      archiveCount = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean).length;
    }
  } catch {}
  let reportsCount = 0;
  try {
    if (fs.existsSync(REPORTS_DIR)) {
      reportsCount = fs.readdirSync(REPORTS_DIR).filter((n) => n.endsWith('.md')).length;
    }
  } catch {}
  res.json({
    success: true,
    appVersion: APP_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    uptimeSec: Math.floor(process.uptime()),
    counts: {
      activeIncidents: load().length,
      archivedIncidents: archiveCount,
      nis2Reports: reportsCount,
      users: authz.users.list().length,
    },
    sizes: {
      storingarBytes: fileStat(dataFile),
      arkivBytes: fileStat(archiveFile),
      auditBytes: fileStat(auditFile),
      settingsBytes: fileStat(settingsFile),
    },
  });
});

app.get('/api/backup/export', authz.requireAdmin, (req, res) => {
  let archiveRows = [];
  try {
    if (fs.existsSync(archiveFile)) {
      archiveRows = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch {}
  let auditRows = [];
  try {
    if (fs.existsSync(auditFile)) {
      auditRows = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).slice(-500)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch {}
  const settingsCopy = loadSettings();
  if (settingsCopy.frameflow) settingsCopy.frameflow.apiKey = '';
  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: req.adminUser,
    appVersion: APP_VERSION,
    nodeVersion: process.version,
    incidents: load(),
    archive: archiveRows,
    alerts: loadAlerts(),
    settings: settingsCopy,
    auditTail: auditRows,
  };
  audit('backup_exported', { by: req.adminUser, incidents: payload.incidents.length, archive: archiveRows.length });
  const filename = `drift-backup-${todayLocal()}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(payload, null, 2));
});

app.post('/api/backup/restore', authz.requireAdmin, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, error: 'Ogiltig backup-payload (förväntade JSON-objekt).' });
  }
  const hasIncidents = Array.isArray(body.incidents);
  const hasArchive = Array.isArray(body.archive);
  const hasSettings = body.settings && typeof body.settings === 'object';
  const hasAlerts = Array.isArray(body.alerts);

  if (!hasIncidents && !hasArchive && !hasSettings) {
    return res.status(400).json({
      success: false,
      error: 'Filen saknar giltiga fält (incidents, archive eller settings) och verkar inte vara en Drift-backup.',
    });
  }

  // Spara en automatisk säkerhetskopia innan återställning
  try {
    let prevArchive = [];
    if (fs.existsSync(archiveFile)) {
      prevArchive = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    const safetySnapshot = {
      savedAt: new Date().toISOString(),
      savedBeforeRestoreBy: req.adminUser,
      appVersion: APP_VERSION,
      incidents: load(),
      archive: prevArchive,
      alerts: loadAlerts(),
      settings: loadSettings(),
    };
    const safetyFile = path.join(DATA_DIR, 'pre-restore-backup.json');
    fs.writeFileSync(safetyFile, JSON.stringify(safetySnapshot, null, 2));
  } catch (err) {
    console.error('Kunde inte skapa pre-restore-backup.json:', err);
  }

  const restored = { incidents: 0, archive: 0, alerts: 0, settings: false };

  if (hasIncidents) {
    const validIncidents = body.incidents
      .filter((i) => i && typeof i === 'object' && i.area && i.faultType)
      .slice(0, 500)
      .map((i) => ({
        ...i,
        id: /^[\w-]{1,40}$/.test(String(i.id || '')) ? String(i.id) : crypto.randomUUID(),
      }));
    save(validIncidents);
    restored.incidents = validIncidents.length;
  }

  if (hasArchive) {
    const validArchive = body.archive
      .filter((i) => i && typeof i === 'object' && i.area)
      .slice(0, 5000)
      .map((i) => ({
        ...i,
        id: /^[\w-]{1,40}$/.test(String(i.id || '')) ? String(i.id) : crypto.randomUUID(),
        nis2: sanitizeNis2(i.nis2 || {}),
      }));
    const tmp = `${archiveFile}.tmp`;
    fs.writeFileSync(tmp, validArchive.map((r) => JSON.stringify(r)).join('\n') + (validArchive.length ? '\n' : ''));
    fs.renameSync(tmp, archiveFile);
    invalidateArchiveCache();
    restored.archive = validArchive.length;

    // Återskapa Markdown-rapporter för alla arkiverade ärenden
    for (const rec of validArchive) {
      try {
        const md = generateCyberReport(rec);
        fs.writeFileSync(path.join(REPORTS_DIR, `incident-${rec.id}.md`), md, 'utf8');
      } catch {}
    }
  }

  if (hasAlerts) {
    const validAlerts = body.alerts
      .filter((a) => a && typeof a === 'object' && a.id)
      .slice(0, 500);
    saveAlerts(validAlerts);
    restored.alerts = validAlerts.length;
  }

  if (hasSettings) {
    const current = loadSettings();
    const inFf = body.settings.frameflow || {};
    const inNotif = body.settings.notifications || {};
    const merged = {
      ...current,
      frameflow: {
        ...current.frameflow,
        ...inFf,
        apiKey: (inFf.apiKey && inFf.apiKey !== '••••••••') ? text(inFf.apiKey, 300) : current.frameflow.apiKey,
        ingestToken: text(inFf.ingestToken, 120) || current.frameflow.ingestToken,
      },
      notifications: {
        ...current.notifications,
        ...inNotif,
      },
      nodes: Array.isArray(body.settings.nodes) && body.settings.nodes.length
        ? body.settings.nodes.map((n) => ({
            id: text(n.id, 40) || crypto.randomUUID().slice(0, 8),
            name: text(n.name, 80),
            domain: DOMAINS.includes(n.domain) ? n.domain : 'stadsnat',
            match: text(n.match, 200),
            customers: Math.max(0, Math.min(100000, parseInt(n.customers, 10) || 0)),
            distCount: Math.max(1, Math.min(100, parseInt(n.distCount, 10) || 1)),
            accCount: Math.max(1, Math.min(500, parseInt(n.accCount, 10) || 24)),
            critical: text(n.critical, 120),
          })).filter((n) => n.name)
        : current.nodes,
    };
    saveSettings(merged);
    scheduleFrameFlowPoller();
    restored.settings = true;
  }

  invalidate();
  audit('backup_restored', { by: req.adminUser, ...restored });
  res.json({ success: true, restored });
});

app.post('/api/settings/rotate-token', authz.requireAdmin, (req, res) => {
  const current = loadSettings();
  current.frameflow.ingestToken = crypto.randomBytes(24).toString('hex');
  saveSettings(current);
  audit('rotate_ingest_token', { by: req.adminUser });
  res.json({ success: true, ingestToken: current.frameflow.ingestToken });
});

app.get('/api/alerts', (req, res) => {
  const active = loadAlerts().filter((a) => !a.dismissed && !a.linkedIncidentId);
  res.json(active);
});

app.post('/api/alerts/dismiss', (req, res) => {
  const id = String(req.body?.id || '');
  const ids = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map((x) => String(x || ''))) : null;
  const alerts = loadAlerts();
  if (id === 'all') {
    alerts.forEach((a) => { a.dismissed = true; });
  } else if (ids && ids.size > 0) {
    alerts.forEach((a) => { if (ids.has(a.id)) a.dismissed = true; });
  } else {
    const target = alerts.find((a) => a.id === id);
    if (target) target.dismissed = true;
  }
  saveAlerts(alerts);
  res.json({ success: true, alerts: alerts.filter((a) => !a.dismissed && !a.linkedIncidentId) });
});

app.post('/api/frameflow/test', async (req, res) => {
  const saved = loadSettings();
  const apiUrl = text(req.body?.apiUrl ?? saved.frameflow.apiUrl, 300);
  const rawKey = req.body?.apiKey !== undefined && req.body.apiKey !== '••••••••' ? text(req.body.apiKey, 300) : saved.frameflow.apiKey;
  if (!apiUrl || !/^https?:\/\//i.test(apiUrl)) {
    return res.status(400).json({ success: false, error: 'Ange en giltig FrameFlow API-URL (https://...) först.' });
  }
  const start = Date.now();
  try {
    const reqHeaders = { Accept: 'application/json' };
    if (rawKey) {
      reqHeaders.Authorization = rawKey.startsWith('Bearer ') ? rawKey : `Bearer ${rawKey}`;
      reqHeaders['X-API-Key'] = rawKey;
    }
    const resp = await fetch(apiUrl, { headers: reqHeaders, signal: AbortSignal.timeout(6000) });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return res.json({ success: false, error: `Servern svarade med HTTP ${resp.status}`, latencyMs });
    }
    const bodyText = await resp.text();
    let itemCount = 0;
    try {
      const json = JSON.parse(bodyText);
      itemCount = extractFrameFlowItems(json).length;
    } catch {}
    res.json({ success: true, status: resp.status, latencyMs, itemCount });
  } catch (err) {
    res.json({ success: false, error: err.message || 'Kunde inte nå FrameFlow API-endpoint.' });
  }
});

app.post('/api/frameflow/simulate', (req, res) => {
  const type = String(req.body?.type || 'switch');
  let sample;
  if (type === 'ups') {
    sample = {
      device: 'bol-c-nod02-ups1',
      monitor: 'SNMP UPS Power & Battery Status',
      status: 'Critical',
      message: 'UPS på batteridrift (Mains AC Power Lost). Beräknad batteritid: 42 min.',
    };
  } else if (type === 'multi_acc') {
    sample = Array.from({ length: 10 }, (_, idx) => {
      const nr = String(idx + 3).padStart(2, '0');
      return {
        device: `arbra_acc_${nr}`,
        monitor: 'SNMP Ping & Uplink Status',
        status: 'Critical',
        message: `Ingen kontakt med access-switch arbra_acc_${nr} i Arbrå (100% packet loss).`,
      };
    });
  } else if (type === 'dist') {
    sample = {
      device: 'arbra_dist_01',
      monitor: 'SNMP Ping & Uplink Status',
      status: 'Critical',
      message: 'Ingen kontakt med distributionsswitch arbra_dist_01 i fiberbod Arbrå (100% packet loss).',
    };
  } else if (type === 'ok') {
    // Återställ samtliga aktiva larm och länkade enheter i pågående ärenden
    const activeAlerts = loadAlerts().filter((a) => !a.dismissed && !a.resolvedAt);
    const activeIncs = load();
    const okMap = new Map();
    const addOk = (device, monitor) => {
      if (!device) return;
      const m = monitor || 'SNMP Ping & Uplink Status';
      okMap.set(`${device.toLowerCase()}::${m.toLowerCase()}`, {
        device,
        monitor: m,
        status: 'OK',
        message: 'Kontakt återställd (0% packet loss).',
      });
    };
    for (const a of activeAlerts) addOk(a.device, a.monitor);
    for (const inc of activeIncs) {
      if (Array.isArray(inc.nmsDevices)) {
        for (const d of inc.nmsDevices) addOk(d, 'SNMP Ping & Uplink Status');
      } else if (inc.nmsDevice) {
        addOk(inc.nmsDevice, inc.alertKey ? inc.alertKey.split('::')[1] : 'SNMP Ping & Uplink Status');
      }
    }
    addOk('arbra_acc_04', 'SNMP Ping & Uplink Status');
    addOk('arbra_dist_01', 'SNMP Ping & Uplink Status');
    addOk('arbra-nod01-sw1', 'SNMP Ping & Uplink Status');
    addOk('bol-c-nod02-ups1', 'SNMP UPS Power & Battery Status');
    sample = [...okMap.values()];
  } else {
    sample = {
      device: 'arbra_acc_04',
      monitor: 'SNMP Ping & Uplink Status',
      status: 'Critical',
      message: 'Ingen kontakt med access-switch arbra_acc_04 i Arbrå (100% packet loss).',
    };
  }
  const stats = processFrameFlowPayload(sample, 'sim');
  audit('frameflow_simulate', { by: req.adminUser, type, ...stats });
  res.json({ success: true, ...stats, alerts: loadAlerts().filter((a) => !a.dismissed && !a.linkedIncidentId) });
});

app.post('/api/publish', (req, res) => {
  const data = clean(req.body);
  const bad = (error) => res.status(400).json({ success: false, error });
  if (!data.area || !data.faultType) return bad('Område och typ av händelse krävs.');
  if (!isTime(data.startTime)) return bad('Ogiltig starttid (HH:MM).');
  if (/^[\d:]+$/.test(data.ettr) && !isTime(data.ettr)) return bad('Ogiltig klartid (HH:MM).');
  if (data.ettrDate && !isTime(data.ettr)) return bad('Ange klartid som HH:MM när datum för klartid anges.');
  if (data.ettrDate && `${data.ettrDate} ${data.ettr}` < `${data.startDate} ${data.startTime}`) return bad('Klartiden kan inte vara före starttiden.');

  const note = text(req.body?.note, 500); // intern anteckning, sparas bara i historiken
  const rawAlertIds = Array.isArray(req.body?.alertIds)
    ? req.body.alertIds.map((x) => text(x, 40)).filter(Boolean)
    : String(req.body?.alertId || '').split(',').map((x) => text(x, 40)).filter(Boolean);
  const rawId = String(req.body?.id ?? '');
  const id = /^[\w-]{1,40}$/.test(rawId) ? rawId : crypto.randomUUID();
  const now = new Date().toISOString();

  const incidents = load();
  const index = incidents.findIndex((i) => i.id === id);
  const prev = index >= 0 ? incidents[index] : null;

  const expectedUpdatedAt = req.body?.expectedUpdatedAt ? String(req.body.expectedUpdatedAt) : null;
  if (prev && expectedUpdatedAt && prev.updatedAt && prev.updatedAt !== expectedUpdatedAt) {
    const who = prev.updatedBy || 'en annan användare';
    const when = prev.updatedAt ? new Date(prev.updatedAt).toLocaleTimeString('sv-SE') : 'nyss';
    return res.status(409).json({
      success: false,
      conflict: true,
      error: `Ärendet ändrades av ${who} kl ${when}. För att inte skriva över ändringarna behöver du ladda om sidan och redigera på nytt.`
    });
  }

  // Koppla larm från FrameFlow (enskild switch eller grupp av switchar) och/eller noddata
  const settings = loadSettings();
  let matchedNode = matchNode(data.area, settings.nodes);
  let extraMeta = {};
  if (matchedNode) {
    extraMeta.customers = matchedNode.customers || 0;
    extraMeta.critical = matchedNode.critical || '';
  }
  if (rawAlertIds.length > 0) {
    const alerts = loadAlerts();
    const idSet = new Set(rawAlertIds);
    const matchedAlerts = alerts.filter((a) => idSet.has(a.id));
    if (matchedAlerts.length > 0) {
      for (const al of matchedAlerts) {
        al.linkedIncidentId = id;
      }
      saveAlerts(alerts);
      if (!matchedNode) {
        matchedNode = matchNode(`${matchedAlerts[0].area} ${matchedAlerts[0].device}`, settings.nodes);
      }
      const impact = computeSwitchImpact(matchedAlerts, matchedNode);
      const nmsDevices = [...new Set(matchedAlerts.map((a) => a.device).filter(Boolean))];
      extraMeta.alertId = matchedAlerts[0].id;
      extraMeta.alertIds = matchedAlerts.map((a) => a.id);
      extraMeta.alertKey = matchedAlerts[0].key;
      extraMeta.nmsDevices = nmsDevices;
      extraMeta.nmsDevice = summarizeDevices(nmsDevices);
      extraMeta.nmsResolvedDevices = [];
      extraMeta.customers = impact.estimatedCustomers || matchedAlerts[0].customers || extraMeta.customers || 0;
      if (matchedAlerts[0].critical) extraMeta.critical = matchedAlerts[0].critical;
      if (!data.scope && impact.scope) data.scope = impact.scope;
    }
  }

  const changes = diff(prev, data);
  const timelineOpts = {
    timelineMode: req.body?.timelineMode,
    addTimelineStep: req.body?.addTimelineStep,
    clearTimeline: Boolean(req.body?.clearTimeline),
    timelineStepText: req.body?.timelineStepText,
    customPublicUpdates: Array.isArray(req.body?.customPublicUpdates) ? req.body.customPublicUpdates : null,
  };
  const publicUpdates = buildPublicUpdates(prev, data, nowLocal(), timelineOpts);
  const entry = { ts: now, by: req.adminUser, action: prev ? 'update' : 'create', status: data.statusType, ...(note && { note }), ...(prev && { changes }) };
  // Ingen ny historikrad om inget ändrats och ingen anteckning skrivits
  const history = [...(prev?.history || []), ...(!prev || Object.keys(changes).length || note ? [entry] : [])].slice(-200);
  const inc = prev
    ? { ...prev, ...extraMeta, ...data, id, updatedAt: now, updatedBy: req.adminUser, history, publicUpdates }
    : { ...extraMeta, ...data, id, createdAt: now, updatedAt: now, createdBy: req.adminUser, updatedBy: req.adminUser, history, publicUpdates };
  if (prev) incidents[index] = inc; else incidents.push(inc);

  save(incidents);
  invalidate();
  audit(prev ? 'update' : 'create', { id, area: data.area, domain: data.domain, kind: data.kind, by: req.adminUser, ...(extraMeta.nmsDevice && { nmsDevice: extraMeta.nmsDevice }) });
  if (settings.notifications?.enabled && settings.notifications?.onPublish) {
    if (!prev) {
      sendNotification(
        `📢 Publicerat ärende: ${data.area} (${data.faultType})`,
        `Status: ${data.statusType} | Tjänster: ${data.services} | Publicerat av: ${req.adminUser}`,
        { event: 'incident_published', id, area: data.area, faultType: data.faultType, by: req.adminUser }
      ).catch(() => {});
    } else if (Object.keys(changes).length > 0) {
      sendNotification(
        `🔄 Uppdaterat ärende: ${data.area} (${data.faultType})`,
        `Status: ${data.statusType} | Tjänster: ${data.services}${data.estTime ? ` | Ny prognos: ${data.estTime}` : ''} | Uppdaterat av: ${req.adminUser}`,
        { event: 'incident_updated', id, area: data.area, faultType: data.faultType, statusType: data.statusType, by: req.adminUser }
      ).catch(() => {});
    }
  }
  res.json({ success: true, id, count: incidents.length, updatedAt: now });
});

app.post('/api/close', (req, res) => {
  const bad = (code, error) => res.status(code).json({ success: false, error });
  const id = String(req.body?.id ?? '');
  if (!/^[\w-]{1,40}$/.test(id)) return bad(400, 'Ogiltigt ärende-ID.');
  const all = load();
  const inc = all.find((i) => i.id === id);
  if (!inc) return bad(404, 'Ärendet finns inte (redan stängt?).');

  const endDate = text(req.body?.endDate, 10), endTime = text(req.body?.endTime, 5);
  if ((endDate || endTime) && !(isDate(endDate) && isTime(endTime))) return bad(400, 'Ogiltig sluttid (ÅÅÅÅ-MM-DD och HH:MM).');
  const endedAt = endDate ? `${endDate} ${endTime}` : nowLocal(); // faktisk sluttid, svensk lokal tid
  // Ett inplanerat arbete som avbokas före start får stängas när som helst
  if (inc.kind !== 'planned' && endedAt < startKey(inc)) return bad(400, 'Sluttiden kan inte vara före starttiden.');

  const note = text(req.body?.note, 500);
  const nis2 = sanitizeNis2(req.body?.nis2);

  const closedAt = new Date().toISOString();
  const history = [...(inc.history || []), { ts: closedAt, by: req.adminUser, action: 'close', endedAt, ...(note && { note }) }].slice(-200);
  const closedRecord = { ...inc, history, endedAt, closedAt, closedBy: req.adminUser, ...(note && { resolution: note }), nis2 };
  try {
    fs.appendFileSync(archiveFile, JSON.stringify(closedRecord) + '\n');
    invalidateArchiveCache();
  } catch (e) {
    console.error('Arkivering misslyckades', e);
    return bad(500, 'Kunde inte arkivera. Ärendet är inte stängt.'); // radera aldrig utan arkivkopia
  }
  const report = generateCyberReport(closedRecord);
  try {
    fs.writeFileSync(path.join(REPORTS_DIR, `incident-${id}.md`), report, 'utf8');
  } catch (e) {
    console.error('Kunde inte spara incidentrapport:', e);
  }
  // Om ärendet var kopplat till ett eller flera FrameFlow-larm, markera dem som avfärdade/hanterade
  if (inc.alertId || inc.alertKey || (Array.isArray(inc.alertIds) && inc.alertIds.length) || (Array.isArray(inc.nmsDevices) && inc.nmsDevices.length)) {
    const alerts = loadAlerts();
    const idSet = new Set([...(Array.isArray(inc.alertIds) ? inc.alertIds : []), ...(inc.alertId ? [inc.alertId] : [])]);
    const devSet = new Set((Array.isArray(inc.nmsDevices) ? inc.nmsDevices : []).map((d) => String(d).toLowerCase()));
    alerts.forEach((a) => {
      if (idSet.has(a.id) || a.key === inc.alertKey || a.linkedIncidentId === id || (a.device && devSet.has(a.device.toLowerCase()))) {
        a.dismissed = true;
      }
    });
    saveAlerts(alerts);
  }
  const incidents = all.filter((i) => i.id !== id);
  save(incidents);
  invalidate();
  audit('close', { id, area: inc.area, endedAt, by: req.adminUser, significant: nis2.significant });
  const settings = loadSettings();
  if (settings.notifications?.enabled && settings.notifications?.onPublish) {
    sendNotification(
      `✅ Åtgärdat ärende: ${inc.area} (${inc.faultType})`,
      `Sluttid: ${endedAt}${note ? ` | Åtgärd: ${note}` : ''} | Stängt av: ${req.adminUser}`,
      { event: 'incident_closed', id, area: inc.area, faultType: inc.faultType, endedAt, by: req.adminUser }
    ).catch(() => {});
  }
  res.json({ success: true, count: incidents.length, id, report });
});

app.post('/api/reopen', (req, res) => {
  const bad = (code, error) => res.status(code).json({ success: false, error });
  const id = String(req.body?.id ?? '');
  if (!/^[\w-]{1,40}$/.test(id)) return bad(400, 'Ogiltigt ärende-ID.');

  let rows = [];
  try {
    rows = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (err) {
    return bad(500, 'Kunde inte läsa arkivfilen.');
  }

  const index = rows.findIndex((i) => i.id === id);
  if (index < 0) return bad(404, 'Ärendet hittades inte i arkivet (redan återöppnat?).');

  const archivedInc = rows[index];
  const note = text(req.body?.note, 500) || 'Ärende återöppnat från arkivet.';
  const now = new Date().toISOString();

  // Ta bort ur arkivet
  rows.splice(index, 1);
  try {
    const tmp = `${archiveFile}.tmp`;
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    fs.renameSync(tmp, archiveFile);
    invalidateArchiveCache();
  } catch (err) {
    console.error('Kunde inte uppdatera arkivfilen vid återöppning:', err);
    return bad(500, 'Kunde inte uppdatera arkivet.');
  }

  // Ta bort gammal stängningsrapport så att den genereras på nytt vid nästa stängning
  try { fs.rmSync(path.join(REPORTS_DIR, `incident-${id}.md`), { force: true }); } catch {}

  // Förbered det återöppnade ärendet
  const history = [...(archivedInc.history || []), { ts: now, by: req.adminUser, action: 'reopen', note }].slice(-200);
  const activeInc = {
    ...archivedInc,
    domain: DOMAINS.includes(archivedInc.domain) ? archivedInc.domain : 'stadsnat',
    kind: ['incident', 'planned'].includes(archivedInc.kind) ? archivedInc.kind : 'incident',
    startDate: isDate(archivedInc.startDate || '') ? archivedInc.startDate : (archivedInc.createdAt || '').slice(0, 10) || todayLocal(),
    statusType: 'Pågående Störning',
    updatedAt: now,
    updatedBy: req.adminUser,
    history
  };
  delete activeInc.endedAt;
  delete activeInc.closedAt;
  delete activeInc.closedBy;
  delete activeInc.resolution;
  delete activeInc.nis2;
  delete activeInc.nmsResolvedAt;
  if (Array.isArray(activeInc.nmsDevices)) activeInc.nmsResolvedDevices = [];

  const incidents = load();
  const existingIdx = incidents.findIndex((i) => i.id === id);
  if (existingIdx >= 0) incidents[existingIdx] = activeInc;
  else incidents.push(activeInc);

  save(incidents);
  invalidate();
  audit('reopen', { id, area: activeInc.area, by: req.adminUser, note });
  res.json({ success: true, count: incidents.length, incident: activeInc });
});

app.post('/api/archive/update-nis2', (req, res) => {
  const bad = (code, error) => res.status(code).json({ success: false, error });
  const id = String(req.body?.id ?? '');
  if (!/^[\w-]{1,40}$/.test(id)) return bad(400, 'Ogiltigt ärende-ID.');

  let rows = [];
  try {
    if (fs.existsSync(archiveFile)) {
      rows = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch {
    return bad(500, 'Kunde inte läsa arkivfilen.');
  }

  const index = rows.findIndex((i) => i.id === id);
  if (index < 0) return bad(404, 'Ärendet hittades inte i arkivet.');

  const prev = rows[index];
  const now = new Date().toISOString();
  const updatedNis2 = sanitizeNis2(req.body?.nis2, prev.nis2 || {});
  const resolution = req.body?.resolution !== undefined ? text(req.body.resolution, 500) : (prev.resolution || '');
  const updateNote = text(req.body?.updateNote, 300) || 'Kompletterade NIS2-data och rotårsaksanalys i efterhand.';

  const history = [
    ...(prev.history || []),
    { ts: now, by: req.adminUser, action: 'nis2_update', note: updateNote },
  ].slice(-200);

  const updatedRecord = {
    ...prev,
    resolution,
    nis2: updatedNis2,
    nis2UpdatedAt: now,
    nis2UpdatedBy: req.adminUser,
    history,
  };

  rows[index] = updatedRecord;
  try {
    const tmp = `${archiveFile}.tmp`;
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    fs.renameSync(tmp, archiveFile);
    invalidateArchiveCache();
  } catch (err) {
    console.error('Kunde inte spara kompletterad NIS2-post:', err);
    return bad(500, 'Kunde inte uppdatera arkivfilen.');
  }

  const report = generateCyberReport(updatedRecord);
  try {
    fs.writeFileSync(path.join(REPORTS_DIR, `incident-${id}.md`), report, 'utf8');
  } catch (err) {
    console.error('Kunde inte skriva reviderad incidentrapport:', err);
  }

  audit('nis2_update', {
    id,
    area: updatedRecord.area,
    by: req.adminUser,
    significant: updatedNis2.significant,
    authorityRef: updatedNis2.authorityRef || undefined,
  });

  res.json({ success: true, id, incident: updatedRecord, report });
});

app.post('/api/incidents/delete', (req, res) => {
  const bad = (code, error) => res.status(code).json({ success: false, error });
  const id = String(req.body?.id ?? '');
  if (!/^[\w-]{1,40}$/.test(id)) return bad(400, 'Ogiltigt ärende-ID.');
  const all = load();
  const inc = all.find((i) => i.id === id);
  if (!inc) return bad(404, 'Ärendet hittades inte (redan raderat eller stängt?).');

  const alerts = loadAlerts();
  let alertsChanged = false;
  for (const a of alerts) {
    if (a.linkedIncidentId === id) {
      a.linkedIncidentId = null;
      alertsChanged = true;
    }
  }
  if (alertsChanged) saveAlerts(alerts);

  const remaining = all.filter((i) => i.id !== id);
  save(remaining);
  invalidate();
  audit('delete_incident', { id, area: inc.area, faultType: inc.faultType, by: req.adminUser });
  res.json({ success: true, id, count: remaining.length });
});

app.post('/api/archive/delete', (req, res) => {
  const bad = (code, error) => res.status(code).json({ success: false, error });
  const id = String(req.body?.id ?? '');
  if (!/^[\w-]{1,40}$/.test(id)) return bad(400, 'Ogiltigt ärende-ID.');

  let rows = [];
  try {
    if (fs.existsSync(archiveFile)) {
      rows = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch {
    return bad(500, 'Kunde inte läsa arkivfilen.');
  }

  const target = rows.find((i) => i.id === id);
  if (!target) return bad(404, 'Ärendet hittades inte i arkivet.');

  const remaining = rows.filter((i) => i.id !== id);
  try {
    const tmp = `${archiveFile}.tmp`;
    fs.writeFileSync(tmp, remaining.map((r) => JSON.stringify(r)).join('\n') + (remaining.length ? '\n' : ''));
    fs.renameSync(tmp, archiveFile);
    invalidateArchiveCache();
  } catch (err) {
    console.error('Kunde inte uppdatera arkivfilen vid radering:', err);
    return bad(500, 'Kunde inte uppdatera arkivfilen.');
  }

  try {
    fs.rmSync(path.join(REPORTS_DIR, `incident-${id}.md`), { force: true });
  } catch {}

  invalidate();
  audit('delete_archive', { id, area: target.area, faultType: target.faultType, by: req.adminUser });
  res.json({ success: true, id, count: remaining.length });
});

app.get('/api/report/:id/print', (req, res) => {
  const id = String(req.params.id ?? '');
  if (!/^[\w-]{1,40}$/.test(id)) return res.status(400).type('text/plain').send('Ogiltigt ärende-ID.');
  let inc = load().find((i) => i.id === id);
  if (!inc) {
    try {
      const rows = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      inc = rows.find((i) => i.id === id);
    } catch {}
  }
  if (!inc) return res.status(404).type('text/plain').send('Ärendet hittades inte.');
  const html = renderCyberReportHtml(inc, CSS_V, JS_V);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
});

app.get('/api/report/:id', (req, res) => {
  const id = String(req.params.id ?? '');
  if (!/^[\w-]{1,40}$/.test(id)) return res.status(400).json({ success: false, error: 'Ogiltigt ärende-ID.' });
  const file = path.join(REPORTS_DIR, `incident-${id}.md`);
  if (fs.existsSync(file)) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      return res.json({ success: true, id, report: content });
    } catch {}
  }
  let inc = load().find((i) => i.id === id);
  if (!inc) {
    try {
      const rows = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      inc = rows.find((i) => i.id === id);
    } catch {}
  }
  if (!inc) return res.status(404).json({ success: false, error: 'Ärendet hittades inte.' });
  const report = generateCyberReport(inc);
  res.json({ success: true, id, report });
});

app.get('/api/archive', (req, res) => {
  const q = String(req.query?.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(500, parseInt(req.query?.limit, 10) || 100));
  let rows = loadArchiveRows().reverse();
  if (q) {
    rows = rows.filter((inc) =>
      `${inc.area || ''} ${inc.faultType || ''} ${inc.services || ''} ${inc.closedBy || ''} ${inc.startDate || ''} ${inc.endedAt || ''} ${inc.resolution || ''}`
        .toLowerCase()
        .includes(q)
    );
  }
  res.json(rows.slice(0, limit));
});

// Felhanterare (t.ex. trasig JSON i request)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ success: false, error: 'Serverfel' });
});

// Generera statisk sida direkt vid start
generatePublicSite();
loadSettings();

if (require.main === module) {
  setInterval(generatePublicSite, 60000);
  scheduleFrameFlowPoller();
  const adminServer = app.listen(PORT, '0.0.0.0', () => console.log(`Admin lyssnar på port ${PORT}`));
  adminServer.headersTimeout = 10000;
  adminServer.requestTimeout = 15000;
  // All skrivning är synkron, så det är säkert att avsluta direkt (snabb `docker stop`)
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
}

module.exports = {
  app,
  authz,
  clean,
  calcDuration,
  buildPublicUpdates,
  sanitizeNis2,
  generateCyberReport,
  renderCyberReportHtml,
  renderPortal,
  renderRss,
  loadRecentlyResolved,
  extractFrameFlowItems,
  processFrameFlowPayload,
  parseDeviceRole,
  summarizeDevices,
  computeSwitchImpact,
  autoArchiveCompletedPlanned,
  cleanupFrameFlowRateLimits,
  ffAuthFails,
  ffRateWindow,
};
