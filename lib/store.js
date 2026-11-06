const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
// Lägg DATA_DIR på en volym så att data överlever omstarter och uppdateringar
const DATA_DIR = process.env.DATA_DIR || ROOT_DIR;
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(DATA_DIR, 'public-site');
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PORTAL_PORT = Number(process.env.PORTAL_PORT) || 3001;
const dataFile = path.join(DATA_DIR, 'storingar.json');
const archiveFile = path.join(DATA_DIR, 'arkiv.jsonl'); // stängda ärenden (driftlogg)
const auditFile = path.join(DATA_DIR, 'audit.jsonl'); // beständig revisionslogg
const settingsFile = path.join(DATA_DIR, 'settings.json'); // GUI-konfigurerade integrationer & nodregister
const alertsFile = path.join(DATA_DIR, 'alerts.json'); // Larminkorg från FrameFlow (Pull & Push)
const REPORTS_DIR = path.join(DATA_DIR, 'rapporter');
const MAX_AUDIT_BYTES = 5 * 1024 * 1024; // rotera audit.jsonl vid 5 MB

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ---------- Hjälpfunktioner ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function rotateAuditIfNeeded() {
  try {
    if (!fs.existsSync(auditFile)) return;
    const st = fs.statSync(auditFile);
    if (st.size < MAX_AUDIT_BYTES) return;
    for (let i = 2; i >= 1; i--) {
      const src = `${auditFile}.${i}`;
      const dst = `${auditFile}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    fs.renameSync(auditFile, `${auditFile}.1`);
  } catch {}
}

const audit = (action, o = {}) => {
  const record = { ts: new Date().toISOString(), action, ...o };
  console.log(JSON.stringify(record));
  try {
    rotateAuditIfNeeded();
    fs.appendFileSync(auditFile, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('Kunde inte skriva audit-logg:', err);
  }
};

let dataCache = { mtimeMs: -1, list: [] };
function load() {
  if (!fs.existsSync(dataFile)) {
    dataCache = { mtimeMs: -1, list: [] };
    return [];
  }
  try {
    const st = fs.statSync(dataFile);
    if (st.mtimeMs === dataCache.mtimeMs) {
      return structuredClone(dataCache.list);
    }
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!Array.isArray(data)) throw new Error('inte en lista');
    dataCache = { mtimeMs: st.mtimeMs, list: data };
    return structuredClone(data);
  } catch (e) {
    // Skriv aldrig över en trasig fil tyst – spara en kopia först
    const bak = `${dataFile}.corrupt-${Date.now()}`;
    fs.copyFileSync(dataFile, bak);
    console.error(`storingar.json var trasig, kopia sparad som ${bak}`);
    dataCache = { mtimeMs: -1, list: [] };
    return [];
  }
}

// Atomisk skrivning: temp-fil och byt namn, så filen aldrig blir halvskriven
function save(list) {
  const tmp = `${dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, dataFile);
  try {
    const st = fs.statSync(dataFile);
    dataCache = { mtimeMs: st.mtimeMs, list: structuredClone(list) };
  } catch {
    dataCache = { mtimeMs: -1, list: [] };
  }
}

const DEFAULT_NODES = [
  { id: 'arbra', name: 'Arbrå', domain: 'stadsnat', match: 'arbra, arbrå', customers: 850, distCount: 2, accCount: 36, critical: 'care, municipal' },
  { id: 'bollnas-c', name: 'Bollnäs C', domain: 'stadsnat', match: 'bol-c, bollnas, bollnäs, centrum', customers: 2400, distCount: 5, accCount: 100, critical: '112, care, municipal' },
  { id: 'kilafors', name: 'Kilafors', domain: 'stadsnat', match: 'kilafors, kila', customers: 620, distCount: 2, accCount: 28, critical: 'care' },
  { id: 'rengsjo', name: 'Rengsjö', domain: 'stadsnat', match: 'rengsjo, rengsjö', customers: 310, distCount: 1, accCount: 14, critical: '' },
  { id: 'segersta', name: 'Segersta', domain: 'stadsnat', match: 'segersta, seg', customers: 240, distCount: 1, accCount: 11, critical: '' },
  { id: 'vallsta', name: 'Vallsta', domain: 'stadsnat', match: 'vallsta, val', customers: 280, distCount: 1, accCount: 13, critical: '' },
  { id: 'lottefors', name: 'Lottefors', domain: 'stadsnat', match: 'lottefors, lot', customers: 150, distCount: 1, accCount: 7, critical: '' },
  { id: 'fv-bollnas', name: 'Fjärrvärme Bollnäs', domain: 'fjarrvarme', match: 'fv-, varme, värmeverk, panncentral', customers: 1200, distCount: 1, accCount: 1, critical: 'care, municipal, energy' },
];

let settingsCache = { mtimeMs: -1, data: null };
function loadSettings() {
  if (fs.existsSync(settingsFile)) {
    try {
      const st = fs.statSync(settingsFile);
      if (st.mtimeMs === settingsCache.mtimeMs && settingsCache.data) {
        return structuredClone(settingsCache.data);
      }
    } catch {}
  }
  let saved = {};
  if (fs.existsSync(settingsFile)) {
    try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch {}
  }
  const ff = saved.frameflow || {};
  const notif = saved.notifications || {};
  const rawNodes = Array.isArray(saved.nodes) && saved.nodes.length ? saved.nodes : DEFAULT_NODES;
  const settings = {
    frameflow: {
      pullEnabled: Boolean(ff.pullEnabled),
      apiUrl: String(ff.apiUrl || ''),
      apiKey: String(ff.apiKey || ''),
      pollIntervalSec: Math.max(15, Math.min(3600, parseInt(ff.pollIntervalSec, 10) || 60)),
      pushEnabled: ff.pushEnabled !== false,
      ingestToken: String(ff.ingestToken || crypto.randomBytes(24).toString('hex')),
      lastPollAt: ff.lastPollAt || null,
      lastPollOk: ff.lastPollOk ?? null,
      lastPollMsg: String(ff.lastPollMsg || ''),
      lastPushAt: ff.lastPushAt || null,
    },
    notifications: {
      enabled: Boolean(notif.enabled),
      webhookUrl: String(notif.webhookUrl || ''),
      onFrameFlowAlert: notif.onFrameFlowAlert !== false,
      onPublish: Boolean(notif.onPublish),
      lastSentAt: notif.lastSentAt || null,
      lastSentOk: notif.lastSentOk ?? null,
      lastSentMsg: String(notif.lastSentMsg || ''),
    },
    nodes: rawNodes.map((n) => {
      const accCount = Math.max(1, Math.min(500, parseInt(n.accCount, 10) || 24));
      const rawDist = Math.max(1, Math.min(100, parseInt(n.distCount, 10) || 1));
      return {
        ...n,
        distCount: Math.max(rawDist, Math.ceil(accCount / 24)),
        accCount,
      };
    }),
  };
  if (!fs.existsSync(settingsFile)) {
    saveSettings(settings);
  } else {
    try {
      const st = fs.statSync(settingsFile);
      settingsCache = { mtimeMs: st.mtimeMs, data: structuredClone(settings) };
    } catch {}
  }
  return settings;
}

function saveSettings(settings) {
  const tmp = `${settingsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, settingsFile);
  try {
    const st = fs.statSync(settingsFile);
    settingsCache = { mtimeMs: st.mtimeMs, data: structuredClone(settings) };
  } catch {
    settingsCache = { mtimeMs: -1, data: null };
  }
}

async function sendNotification(title, summary, extra = {}, customWebhookUrl = '') {
  const settings = loadSettings();
  const url = customWebhookUrl || (settings.notifications?.enabled ? settings.notifications.webhookUrl : '');
  if (!url || !/^https?:\/\//i.test(url)) return { sent: false, error: 'Ingen giltig Webhook-URL angiven.' };
  const payload = {
    text: `${title}\n${summary}`,
    content: `**${title}**\n${summary}`,
    title,
    summary,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const latest = loadSettings();
    latest.notifications.lastSentAt = new Date().toISOString();
    latest.notifications.lastSentOk = res.ok;
    latest.notifications.lastSentMsg = res.ok ? `OK (HTTP ${res.status})` : `Fel HTTP ${res.status}`;
    saveSettings(latest);
    if (!res.ok) return { sent: false, status: res.status, error: `HTTP ${res.status}` };
    return { sent: true, status: res.status };
  } catch (err) {
    const latest = loadSettings();
    latest.notifications.lastSentAt = new Date().toISOString();
    latest.notifications.lastSentOk = false;
    latest.notifications.lastSentMsg = err.message || 'Nätverksfel vid webhook-utskick';
    saveSettings(latest);
    return { sent: false, error: err.message || 'Nätverksfel' };
  }
}

let alertsCache = { mtimeMs: -1, list: [] };
function loadAlerts() {
  if (!fs.existsSync(alertsFile)) {
    alertsCache = { mtimeMs: -1, list: [] };
    return [];
  }
  try {
    const st = fs.statSync(alertsFile);
    if (st.mtimeMs === alertsCache.mtimeMs) {
      return structuredClone(alertsCache.list);
    }
    const list = JSON.parse(fs.readFileSync(alertsFile, 'utf8'));
    const valid = Array.isArray(list) ? list : [];
    alertsCache = { mtimeMs: st.mtimeMs, list: valid };
    return structuredClone(valid);
  } catch {
    alertsCache = { mtimeMs: -1, list: [] };
    return [];
  }
}

function saveAlerts(list) {
  const tmp = `${alertsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, alertsFile);
  try {
    const st = fs.statSync(alertsFile);
    alertsCache = { mtimeMs: st.mtimeMs, list: structuredClone(list) };
  } catch {
    alertsCache = { mtimeMs: -1, list: [] };
  }
}

let archiveCache = { mtimeMs: -1, rows: [] };
function invalidateArchiveCache() {
  archiveCache = { mtimeMs: -1, rows: [] };
}

function loadArchiveRows() {
  if (!fs.existsSync(archiveFile)) {
    archiveCache = { mtimeMs: -1, rows: [] };
    return [];
  }
  try {
    const st = fs.statSync(archiveFile);
    if (st.mtimeMs === archiveCache.mtimeMs) {
      return structuredClone(archiveCache.rows);
    }
    const rows = fs.readFileSync(archiveFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    archiveCache = { mtimeMs: st.mtimeMs, rows };
    return structuredClone(rows);
  } catch {
    archiveCache = { mtimeMs: -1, rows: [] };
    return [];
  }
}

function matchNode(searchStr, nodes) {
  const hay = String(searchStr || '').toLowerCase();
  if (!hay) return null;
  for (const n of nodes || []) {
    const terms = [n.name, ...(String(n.match || '').split(','))].map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (terms.some((t) => hay.includes(t))) return n;
  }
  return null;
}

const VALID_SCOPES = ['', 'limited', 'partial', 'major', 'full'];
const SCOPE_META = {
  limited: {
    label: '📍 Begränsat delområde',
    style: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30',
  },
  partial: {
    label: '⚠️ Flera delområden',
    style: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30',
  },
  major: {
    label: '⚠️ Större delområde',
    style: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30',
  },
  full: {
    label: '🚨 Hela området / Huvudnod',
    style: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30',
  },
};

const DOMAINS = ['stadsnat', 'fjarrvarme'];
const DOMAIN_LABEL = { stadsnat: 'Stadsnät', fjarrvarme: 'Fjärrvärme' };
const nowLocal = () => { // "ÅÅÅÅ-MM-DD HH:MM" i svensk tid, oberoende av språkinställning
  const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const todayLocal = () => nowLocal().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const text = (v, max) => String(v ?? '').replace(CTRL, '').trim().slice(0, max);

const LIMITS = { domain: 20, kind: 12, area: 80, scope: 20, faultType: 60, services: 120, startDate: 10, startTime: 5, ettrDate: 10, ettr: 15, techDetails: 1000, statusType: 40 };

function clean(body = {}) {
  const out = {};
  for (const [key, max] of Object.entries(LIMITS)) out[key] = text(body[key], max);
  if (!DOMAINS.includes(out.domain)) out.domain = 'stadsnat';
  if (!['incident', 'planned'].includes(out.kind)) out.kind = 'incident';
  if (!VALID_SCOPES.includes(out.scope)) out.scope = '';
  if (!isDate(out.startDate)) out.startDate = todayLocal();
  if (out.ettrDate && !isDate(out.ettrDate)) out.ettrDate = '';
  return out;
}

// Fält som spåras i ärendets historik
const TRACK = ['domain', 'kind', 'statusType', 'area', 'scope', 'faultType', 'services', 'startDate', 'startTime', 'ettrDate', 'ettr', 'techDetails'];
const FIELD_LABEL = {
  domain: 'Verksamhet',
  kind: 'Typ',
  statusType: 'Status',
  area: 'Område',
  scope: 'Omfattning',
  faultType: 'Typ av händelse',
  services: 'Tjänster',
  startDate: 'Startdatum',
  startTime: 'Starttid',
  ettrDate: 'Klartid, datum',
  ettr: 'Klartid',
  techDetails: 'Lägesrapport'
};
const diff = (a, b) => Object.fromEntries(TRACK.filter((k) => (a?.[k] ?? '') !== (b[k] ?? '')).map((k) => [k, [a?.[k] ?? '', b[k] ?? '']]));
// Jämförbara tidsnycklar i svensk lokal tid, t.ex. "2026-10-25 08:15"
const startKey = (i) => `${i.startDate || (i.createdAt || '').slice(0, 10) || '0000-00-00'} ${i.startTime || '00:00'}`;
const endKey = (i) => (i.ettrDate && isTime(i.ettr || '') ? `${i.ettrDate} ${i.ettr}` : '');

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  PUBLIC_DIR,
  PUBLIC_URL,
  PORTAL_PORT,
  dataFile,
  archiveFile,
  auditFile,
  settingsFile,
  alertsFile,
  REPORTS_DIR,
  esc,
  rotateAuditIfNeeded,
  audit,
  load,
  save,
  DEFAULT_NODES,
  loadSettings,
  saveSettings,
  sendNotification,
  loadAlerts,
  saveAlerts,
  loadArchiveRows,
  invalidateArchiveCache,
  matchNode,
  VALID_SCOPES,
  SCOPE_META,
  DOMAINS,
  DOMAIN_LABEL,
  nowLocal,
  todayLocal,
  isDate,
  isTime,
  text,
  LIMITS,
  clean,
  TRACK,
  FIELD_LABEL,
  diff,
  startKey,
  endKey,
};
