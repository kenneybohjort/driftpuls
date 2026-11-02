const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// Lägg DATA_DIR på en volym så att data överlever omstarter och uppdateringar
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(DATA_DIR, 'public-site');
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PORTAL_PORT = Number(process.env.PORTAL_PORT) || 3001;
const ADMIN_USER = process.env.ADMIN_USER; // används bara för att skapa första kontot
const ADMIN_PASS = process.env.ADMIN_PASS;
const APP_VERSION = '2026.11.02.1'; // höj vid varje ändring: visas i sidans fot så man ser om server och sida är i takt
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

function load() {
  if (!fs.existsSync(dataFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!Array.isArray(data)) throw new Error('inte en lista');
    return data;
  } catch (e) {
    // Skriv aldrig över en trasig fil tyst – spara en kopia först
    const bak = `${dataFile}.corrupt-${Date.now()}`;
    fs.copyFileSync(dataFile, bak);
    console.error(`storingar.json var trasig, kopia sparad som ${bak}`);
    return [];
  }
}

// Atomisk skrivning: temp-fil och byt namn, så filen aldrig blir halvskriven
function save(list) {
  const tmp = `${dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, dataFile);
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

function loadSettings() {
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
  if (!fs.existsSync(settingsFile)) saveSettings(settings);
  return settings;
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

function saveSettings(settings) {
  const tmp = `${settingsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, settingsFile);
}

function loadAlerts() {
  if (!fs.existsSync(alertsFile)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(alertsFile, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function saveAlerts(list) {
  const tmp = `${alertsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, alertsFile);
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

// Identifiera enhetsroll utifrån namnsättning, t.ex. "arbra_acc_04", "arbra_dist_01", "bol-c-nod02-ups1"
function parseDeviceRole(device = '') {
  const s = String(device || '').trim();
  const distMatch = s.match(/^([a-z0-9åäö_-]+?)[_-]dist(?:[_-]?(\d+))?$/i);
  if (distMatch) {
    return {
      prefix: distMatch[1].toLowerCase(),
      role: 'dist',
      num: distMatch[2] ? parseInt(distMatch[2], 10) : null,
      rawNum: distMatch[2] || '',
      raw: s,
    };
  }
  const accMatch = s.match(/^([a-z0-9åäö_-]+?)[_-]acc(?:[_-]?(\d+))?$/i);
  if (accMatch) {
    return {
      prefix: accMatch[1].toLowerCase(),
      role: 'acc',
      num: accMatch[2] ? parseInt(accMatch[2], 10) : null,
      rawNum: accMatch[2] || '',
      raw: s,
    };
  }
  if (/ups|batteri|battery|rectifier|likriktare/i.test(s)) {
    return { prefix: s.toLowerCase(), role: 'ups', num: null, rawNum: '', raw: s };
  }
  return { prefix: s.toLowerCase(), role: 'other', num: null, rawNum: '', raw: s };
}

// Komprimera enhetslista för adminvy/NIS2, t.ex. ["arbra_acc_03", ..., "arbra_acc_12"] -> "arbra_acc_03–12 (10 st)"
function summarizeDevices(devices = []) {
  const list = [...new Set((devices || []).map((d) => String(d || '').trim()).filter(Boolean))];
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];

  const parsed = list.map(parseDeviceRole);
  const groups = new Map();
  for (const p of parsed) {
    const gKey = p.role === 'acc' || p.role === 'dist' ? `${p.prefix}_${p.role}` : `other:${p.raw}`;
    if (!groups.has(gKey)) groups.set(gKey, []);
    groups.get(gKey).push(p);
  }

  const parts = [];
  for (const [, items] of groups) {
    if (items.length === 1) {
      parts.push(items[0].raw);
      continue;
    }
    const first = items[0];
    const withNums = items.filter((i) => i.num !== null).sort((a, b) => a.num - b.num);
    if (withNums.length === items.length && (first.role === 'acc' || first.role === 'dist')) {
      const minItem = withNums[0];
      const maxItem = withNums[withNums.length - 1];
      const padLen = Math.max(minItem.rawNum.length, maxItem.rawNum.length, 2);
      const minStr = String(minItem.num).padStart(padLen, '0');
      const maxStr = String(maxItem.num).padStart(padLen, '0');
      const isContiguous = (maxItem.num - minItem.num + 1) === withNums.length;
      const sep = isContiguous ? '–' : '..';
      parts.push(`${first.prefix}_${first.role}_${minStr}${sep}${maxStr} (${items.length} st)`);
    } else {
      parts.push(`${items.slice(0, 3).map((i) => i.raw).join(', ')}${items.length > 3 ? ` +${items.length - 3} till` : ''}`);
    }
  }
  return parts.join(', ');
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

const CUSTOMERS_PER_ACC = 24;
const ACC_PER_DIST = 24;
const MAX_CUSTOMERS_PER_DIST = ACC_PER_DIST * CUSTOMERS_PER_ACC; // 576

// Beräkna publik områdesrubrik, omfattnings-badge, neutral lägesrapport och kundpåverkan (NIS2)
function computeSwitchImpact(alertList = [], node = null) {
  const items = Array.isArray(alertList) ? alertList.filter(Boolean) : [alertList].filter(Boolean);
  const first = items[0] || {};
  const baseArea = String(node?.name || first.area || 'Okänt område')
    .replace(/\s*\(begränsat område\)\s*$/i, '')
    .replace(/^Delar av\s+/i, '')
    .trim();
  const totalCustomers = Math.max(0, parseInt(node?.customers ?? first.customers, 10) || 0);
  const distCount = Math.max(1, parseInt(node?.distCount ?? first.distCount, 10) || 1);
  const accCount = Math.max(1, parseInt(node?.accCount ?? first.accCount, 10) || 24);

  const roles = items.map((a) => parseDeviceRole(a.device || ''));
  const downDist = roles.filter((r) => r.role === 'dist').length;
  const downAcc = roles.filter((r) => r.role === 'acc').length;

  let publicArea = baseArea;
  let scope = '';
  let techDetails = `Driftstörning i ${baseArea}. Felsökning pågår.`;
  let fraction = 1;
  let summaryLabel = '';
  let estimatedCustomers = totalCustomers;

  if (downDist >= distCount || downAcc >= accCount) {
    // Samtliga dist-switchar i fiberboden (t.ex. 1 av 1) eller alla access-switchar nere -> Hela området
    publicArea = baseArea;
    scope = 'full';
    techDetails = `Driftstörning i nod som påverkar ${baseArea}. Felsökning pågår.`;
    fraction = 1;
    summaryLabel = downDist > 0
      ? `${downDist}/${distCount} dist-switchar nere (hela noden)`
      : `${downAcc}/${accCount} access-switchar nere`;
    estimatedCustomers = totalCustomers > 0
      ? totalCustomers
      : accCount * CUSTOMERS_PER_ACC;
  } else if (downDist > 0 && downDist < distCount) {
    // 1 av flera dist-switchar i större fiberbod nere -> Större delområde (max 24*24 = 576 kunder per dist-switch)
    publicArea = `Delar av ${baseArea}`;
    scope = 'major';
    techDetails = `Driftstörning i nod som påverkar delar av ${baseArea}. Felsökning pågår.`;
    fraction = Math.max(downDist / distCount, downAcc / accCount);
    summaryLabel = `${downDist} av ${distCount} dist-switchar nere${downAcc ? ` (+${downAcc} acc)` : ''}`;
    const maxByDistPorts = downDist * MAX_CUSTOMERS_PER_DIST;
    estimatedCustomers = totalCustomers > 0
      ? Math.min(totalCustomers, maxByDistPorts, Math.max(1, Math.round(totalCustomers * fraction)))
      : Math.min(accCount * CUSTOMERS_PER_ACC, maxByDistPorts);
  } else if (downAcc > 1) {
    // Flera access-switchar nere i samma nod (t.ex. arbra_acc_03..12) -> Flera delområden (max 24 kunder per acc-switch)
    publicArea = `Delar av ${baseArea}`;
    scope = 'partial';
    techDetails = `Driftstörning som påverkar delar av ${baseArea}. Felsökning pågår.`;
    fraction = Math.min(1, downAcc / accCount);
    summaryLabel = `${downAcc} av ${accCount} access-switchar nere`;
    const maxByAccPorts = downAcc * CUSTOMERS_PER_ACC;
    estimatedCustomers = totalCustomers > 0
      ? Math.min(totalCustomers, maxByAccPorts, Math.max(1, Math.round(totalCustomers * fraction)))
      : maxByAccPorts;
  } else if (downAcc === 1) {
    // En enskild access-switch nere (t.ex. arbra_acc_04) -> Begränsat delområde (max 24 kunder)
    publicArea = `${baseArea} (begränsat område)`;
    scope = 'limited';
    techDetails = `Driftstörning som berör ett begränsat antal fastigheter i ${baseArea}. Felsökning pågår.`;
    fraction = Math.min(1, 1 / accCount);
    summaryLabel = `1 access-switch nere (1/${accCount})`;
    estimatedCustomers = totalCustomers > 0
      ? Math.min(totalCustomers, CUSTOMERS_PER_ACC, Math.max(1, Math.round(totalCustomers * fraction)))
      : CUSTOMERS_PER_ACC;
  } else if (roles.some((r) => r.role === 'ups')) {
    publicArea = baseArea;
    scope = 'full';
    techDetails = `Strömavbrott påverkar utrustning i ${baseArea}. Felsökning pågår.`;
    fraction = 1;
    summaryLabel = 'UPS / Kraftmatning';
    estimatedCustomers = totalCustomers > 0 ? totalCustomers : 0;
  } else {
    estimatedCustomers = totalCustomers > 0
      ? Math.max(1, Math.round(totalCustomers * fraction))
      : 0;
  }

  return {
    baseArea,
    publicArea,
    scope,
    techDetails,
    estimatedCustomers,
    totalCustomers,
    fraction,
    downDist,
    downAcc,
    distCount,
    accCount,
    summaryLabel,
  };
}

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

// Bygger den publika tidslinjen för ett ärende (läser aldrig in interna anteckningar `note`)
function buildPublicUpdates(prev, data, tsLocal = nowLocal()) {
  const fmtEttr = (d) => (d.ettrDate && isTime(d.ettr || '') ? `${d.ettrDate} ${d.ettr}` : (d.ettr || ''));
  const defaultText = (d) => d.techDetails || (d.kind === 'planned' ? 'Planerat arbete inlagt.' : 'Felsökning pågår.');
  if (!prev) {
    const startTs = `${data.startDate || todayLocal()} ${data.startTime || tsLocal.slice(11)}`;
    return [{
      ts: startTs,
      status: data.statusType || 'Pågående Störning',
      ettr: fmtEttr(data),
      text: defaultText(data),
    }];
  }
  const list = Array.isArray(prev.publicUpdates) && prev.publicUpdates.length
    ? [...prev.publicUpdates]
    : [{
      ts: startKey(prev),
      status: prev.statusType || 'Pågående Störning',
      ettr: fmtEttr(prev),
      text: defaultText(prev),
    }];

  const techChanged = (prev.techDetails || '') !== (data.techDetails || '');
  const ettrChanged = fmtEttr(prev) !== fmtEttr(data);
  const statusChanged = (prev.statusType || '') !== (data.statusType || '');
  if (!techChanged && !ettrChanged && !statusChanged) return list;

  const newEttr = fmtEttr(data);
  let newText = data.techDetails || '';
  if (!techChanged && ettrChanged) {
    newText = data.techDetails
      ? `${data.techDetails}`
      : `Uppdaterad prognos: ${newEttr || 'Ej fastställt'}`;
  } else if (!newText) {
    newText = `${data.statusType || 'Uppdaterad status'}${newEttr ? ` (Prognos: ${newEttr})` : ''}`;
  }

  const last = list[list.length - 1];
  if (last && last.text === newText && last.ettr === newEttr && last.status === data.statusType) {
    return list;
  }
  list.push({
    ts: tsLocal,
    status: data.statusType || 'Uppdaterad Prognos / Info',
    ettr: newEttr,
    text: newText,
  });
  return list.slice(-30);
}

function calcDuration(startStr, endStr) {
  if (!startStr || !endStr) return 'Okänd varaktighet';
  const d1 = new Date(startStr.replace(' ', 'T') + ':00');
  const d2 = new Date(endStr.replace(' ', 'T') + ':00');
  const diffMs = d2 - d1;
  if (isNaN(diffMs)) return 'Ej beräkningsbar';
  if (diffMs < 0) return 'Stängt före start (avbokat)';
  const totalMin = Math.floor(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} minuter`;
  if (m === 0) return `${h} timmar`;
  return `${h} timmar ${m} minuter (${totalMin} minuter totalt)`;
}

function generateCyberReport(inc) {
  const domain = inc.domain === 'fjarrvarme' ? 'fjarrvarme' : 'stadsnat';
  const isHeating = domain === 'fjarrvarme';
  const sector = isHeating
    ? 'Energi – Fjärrvärme och fjärrkyla'
    : 'Digital infrastruktur – Elektroniska kommunikationsnät och allmänt tillgängliga elektroniska kommunikationstjänster';
  const authority = isHeating
    ? 'Statens energimyndighet samt MSB / CERT-SE'
    : 'Post- och telestyrelsen (PTS) samt MSB / CERT-SE';

  const start = `${inc.startDate || (inc.createdAt || '').slice(0, 10) || '0000-00-00'} ${inc.startTime || '00:00'}`;
  const end = inc.endedAt || (inc.ettrDate && inc.ettr ? `${inc.ettrDate} ${inc.ettr}` : 'Ej fastställd');
  const duration = calcDuration(start, inc.endedAt || '');

  const createdTs = inc.createdAt ? new Date(inc.createdAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) : '–';
  const closedTs = inc.closedAt ? new Date(inc.closedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) : '–';
  const reportTs = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });

  // Lagstadgade tidsfrister vid allvarlig/betydande incident (Cybersäkerhetslagen / NIS2)
  const createdDate = inc.createdAt ? new Date(inc.createdAt) : new Date();
  const earlyWarningDeadline = new Date(createdDate.getTime() + 24 * 3600e3).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const fullNoticeDeadline = new Date(createdDate.getTime() + 72 * 3600e3).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const endBase = inc.endedAt ? new Date(inc.endedAt.replace(' ', 'T') + ':00') : new Date();
  const finalReportDeadline = new Date(endBase.getTime() + 30 * 24 * 3600e3).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

  const histLines = (inc.history || []).map((h) => {
    const ts = h.ts ? new Date(h.ts).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) : '–';
    const actionText = h.action === 'create'
      ? 'Ärende registrerat'
      : h.action === 'close'
        ? `Ärende stängt (klartid: ${h.endedAt || '–'})`
        : h.action === 'reopen'
          ? 'Ärende återöppnat'
          : h.action === 'nms_ok'
            ? 'Övervakning (FrameFlow) rapporterar återställd drift'
            : h.action === 'nis2_update'
              ? 'Komplettering av NIS2-data i arkivet'
              : 'Ärende uppdaterat';
    const parts = [actionText];
    if (h.status) parts.push(`Rapportstatus: ${h.status}`);
    if (h.note) parts.push(`Intern anteckning: "${h.note}"`);
    if (h.changes) {
      const ch = Object.entries(h.changes).map(([k, [a, b]]) => `${FIELD_LABEL[k] || k}: ${a || '–'} → ${b || '–'}`).join('; ');
      if (ch) parts.push(`Ändrade fält: ${ch}`);
    }
    return `- **${ts}** av **${h.by || '?'}**: ${parts.join(' | ')}`;
  }).join('\n') || '- Ingen historik loggad.';

  const resolutionText = inc.resolution || inc.closeNote || (inc.history || []).slice().reverse().find((h) => h.action === 'close')?.note || '(Ingen orsak/åtgärd angiven vid stängning)';

  const n2 = inc.nis2 || {};
  const sigYes = n2.significant === 'yes' ? 'x' : ' ';
  const sigNo = n2.significant === 'no' ? 'x' : ' ';
  const custCount = n2.affectedCustomers !== undefined && n2.affectedCustomers !== '' ? String(n2.affectedCustomers) : (inc.customers ? String(inc.customers) : '______________');
  const custPct = n2.affectedPercent !== undefined && n2.affectedPercent !== '' ? String(n2.affectedPercent) : '______________';
  const critSet = new Set(Array.isArray(n2.criticalSectors) ? n2.criticalSectors : String(inc.critical || '').split(',').map((s) => s.trim()).filter(Boolean));
  const cBox = (key) => (critSet.has(key) ? 'x' : ' ');
  const rc = n2.rootCauseCategory || '';
  const rBox = (key) => (rc === key ? 'x' : ' ');
  const critComment = n2.criticalComment ? n2.criticalComment : '__________________________________________________________________';
  const prevAction1 = n2.preventiveAction ? n2.preventiveAction : '__________________________________________________________________';
  const prevAction2 = n2.preventiveAction2 ? n2.preventiveAction2 : '__________________________________________________________________';
  const authRef = n2.authorityRef ? n2.authorityRef : '_____________________________';
  const polRef = n2.policeRef ? n2.policeRef : '_____________________________';
  const certRef = n2.certRef ? n2.certRef : '_____________________________';
  const handlerName = inc.closedBy || inc.updatedBy || inc.createdBy || '________________________';
  const closedDateStr = inc.closedAt ? new Date(inc.closedAt).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }) : '____________________';

  return `# INCIDENTRAPPORT ENLIGT CYBERSÄKERHETSLAGEN (NIS2)
Dokumentreferens: INC-${inc.id}
Genererad: ${reportTs} av ${inc.closedBy || inc.updatedBy || inc.createdBy || 'administratör'}

================================================================================
AVSNITT 1: VERKSAMHET OCH INCIDENTIDENTIFIERING
================================================================================
System / Rapportkälla:    Driftpuls
Verksamhetsområde:        ${DOMAIN_LABEL[domain] || 'Stadsnät'}
Sektor enligt NIS2:       ${sector}
Tillsynsmyndighet:        ${authority}
Ärende-ID:                ${inc.id}
Rapportör / Handläggare:  ${inc.closedBy || inc.updatedBy || inc.createdBy || 'Okänd'}
Incidentens status:       Stängd / Åtgärdad
Kategori:                 ${inc.kind === 'planned' ? 'Planerat underhåll / arbete' : 'Oplanerad driftstörning / Incident'}${inc.nmsDevice ? `\nLarmande enhet (NMS):     ${inc.nmsDevice}` : ''}${Array.isArray(inc.nmsDevices) && inc.nmsDevices.length > 1 ? `\nBerörda enheter (${inc.nmsDevices.length} st):  ${inc.nmsDevices.join(', ')}` : ''}

================================================================================
AVSNITT 2: TIDSFÖRLOPP OCH LAGSTADGADE TIDSFRISTER (NIS2 / CSL)
================================================================================
Starttidpunkt:            ${start}
Registrerad i systemet:   ${createdTs}
Faktisk sluttid:          ${end}
Stängd i driftlogg:       ${closedTs}
Total varaktighet:        ${duration}

Lagstadgade tidsfrister vid betydande incident:
- Tidig varning (24h från kännedom):    ${earlyWarningDeadline}
- Incidentanmälan (72h från kännedom):  ${fullNoticeDeadline}
- Slutrapport (senast 1 månad):         ${finalReportDeadline}

================================================================================
AVSNITT 3: HÄNDELSEBESKRIVNING OCH DRIFTPÅVERKAN
================================================================================
Typ av händelse:          ${inc.faultType}
Drabbat område / Nod:     ${inc.area}
Påverkade tjänster:       ${inc.services}

Påverkan på säkerhetsdimensioner:
- Tillgänglighet (Availability): PÅVERKAD (avbrott/störning i tjänsteleverans)
- Konfidentialitet (Confidentiality): EJ INDIKERAD PÅVERKAD
- Riktighet (Integrity): EJ INDIKERAD PÅVERKAD

Publicerad lägesrapport:
${inc.techDetails ? inc.techDetails : '(Ingen publik lägesrapport angiven)'}

Fastställd orsak och vidtagna åtgärder vid stängning:
${resolutionText}

================================================================================
AVSNITT 4: AUDIT TRAIL / HÄNDELSEHISTORIK
================================================================================
${histLines}

================================================================================
AVSNITT 5: KOMPLETTERANDE UPPGIFTER (FYLLS I AV DRIFTLEDNING / CISO)
================================================================================
Följande punkter kräver manuell bedömning enligt föreskrift om incidentrapportering:

1. Tröskelvärde för betydande incident:
   [${sigYes}] Incidenten bedöms som BETYDANDE (skall rapporteras till tillsynsmyndighet)
   [${sigNo}] Incidenten understiger tröskelvärden för extern rapportering (enbart intern logg)

2. Uppskattad volymmässig påverkan:
   - Antal berörda abonnenter/kunder: ${custCount} st
   - Procentuell andel av verksamhetens användarbas: ${custPct} %

3. Påverkan på samhällsviktiga funktioner:
   [${cBox('112')}] Blåljus / Nödkommunikation (112, Rakel)
   [${cBox('care')}] Vård- och omsorgsinrättningar
   [${cBox('municipal')}] Kommunal lednings- och krisverksamhet
   [${cBox('energy')}] Energiförsörjning / Vatten / Avlopp
   [${cBox('crossborder')}] Gränsöverskridande påverkan (annat EU/EES-land)
   Kommentar: ${critComment}

4. Bakomliggande orsaksklassificering:
   [${rBox('tech')}] Tekniskt fel / Komponenthaveri (switch, laser, pump, ventil etc.)
   [${rBox('thirdparty')}] Fysisk yttre åverkan / Tredje part (t.ex. grävskada, trädfall)
   [${rBox('weather')}] Väder / Naturhändelse / Åska / Översvämning
   [${rBox('power')}] Strömavbrott från överliggande elnät
   [${rBox('human')}] Mänsklig faktor / Konfigurationsfel / Rutinbrist
   [${rBox('cyber')}] Misstänkt antagonistisk handling / Cyberangrepp / Sabotage

5. Eventuella myndighetskontakter och polisanmälan:
   - Anmäld till Tillsynsmyndighet (Diarienummer): ${authRef}
   - Anmäld till Polismyndigheten (K1-nummer):      ${polRef}
   - Kontaktad CERT-SE / MSB:                      ${certRef}

6. Förebyggande åtgärder för att förhindra återupprepning:
   Åtgärd 1: ${prevAction1}
   Åtgärd 2: ${prevAction2}
   Ansvarig handläggare: ${handlerName}   Datum: ${closedDateStr}

================================================================================
Rapporten är automatiskt sammanställd via Driftpuls.
`;
}

const VALID_NIS2_CAUSES = ['tech', 'thirdparty', 'weather', 'power', 'human', 'cyber', ''];
const VALID_NIS2_CRIT = ['112', 'care', 'municipal', 'energy', 'crossborder'];
const CAUSE_LABELS = {
  tech: 'Tekniskt fel / Komponenthaveri (switch, laser, pump, ventil etc.)',
  thirdparty: 'Fysisk yttre åverkan / Tredje part (t.ex. grävskada, trädfall)',
  weather: 'Väder / Naturhändelse / Åska / Översvämning',
  power: 'Strömavbrott från överliggande elnät',
  human: 'Mänsklig faktor / Konfigurationsfel / Rutinbrist',
  cyber: 'Misstänkt antagonistisk handling / Cyberangrepp / Sabotage',
};
const CRIT_LABELS = {
  '112': 'Blåljus / Nödkommunikation (112, Rakel)',
  care: 'Vård- och omsorgsinrättningar',
  municipal: 'Kommunal lednings- och krisverksamhet',
  energy: 'Energi / Vatten / Avlopp',
  crossborder: 'Gränsöverskridande påverkan (annat EU/EES-land)',
};

function sanitizeNis2(rawNis2 = {}, fallback = {}) {
  const src = { ...fallback, ...(rawNis2 || {}) };
  return {
    significant: src.significant === 'yes' ? 'yes' : 'no',
    affectedCustomers: text(src.affectedCustomers, 20),
    affectedPercent: text(src.affectedPercent, 10),
    rootCauseCategory: VALID_NIS2_CAUSES.includes(src.rootCauseCategory) ? src.rootCauseCategory : '',
    criticalSectors: Array.isArray(src.criticalSectors) ? src.criticalSectors.filter((c) => VALID_NIS2_CRIT.includes(c)) : [],
    criticalComment: text(src.criticalComment, 300),
    preventiveAction: text(src.preventiveAction, 500),
    preventiveAction2: text(src.preventiveAction2, 500),
    authorityRef: text(src.authorityRef, 100),
    policeRef: text(src.policeRef, 100),
    certRef: text(src.certRef, 100),
  };
}

function renderCyberReportHtml(inc, cssVersion = 0, jsVersion = 0) {
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const domain = inc.domain === 'fjarrvarme' ? 'fjarrvarme' : 'stadsnat';
  const isHeating = domain === 'fjarrvarme';
  const sector = isHeating
    ? 'Energi – Fjärrvärme och fjärrkyla'
    : 'Digital infrastruktur – Elektroniska kommunikationsnät och kommunikationstjänster';
  const authority = isHeating
    ? 'Statens energimyndighet samt MSB / CERT-SE'
    : 'Post- och telestyrelsen (PTS) samt MSB / CERT-SE';
  const start = `${inc.startDate || (inc.createdAt || '').slice(0, 10) || '0000-00-00'} ${inc.startTime || '00:00'}`;
  const end = inc.endedAt || (inc.ettrDate && inc.ettr ? `${inc.ettrDate} ${inc.ettr}` : 'Ej fastställd');
  const duration = calcDuration(start, inc.endedAt || '');
  const createdTs = inc.createdAt ? new Date(inc.createdAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) : '–';
  const closedTs = inc.closedAt ? new Date(inc.closedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) : '–';
  const reportTs = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const createdDate = inc.createdAt ? new Date(inc.createdAt) : new Date();
  const earlyWarningDeadline = new Date(createdDate.getTime() + 24 * 3600e3).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const fullNoticeDeadline = new Date(createdDate.getTime() + 72 * 3600e3).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const endBase = inc.endedAt ? new Date(inc.endedAt.replace(' ', 'T') + ':00') : new Date();
  const finalReportDeadline = new Date(endBase.getTime() + 30 * 24 * 3600e3).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const resolutionText = inc.resolution || inc.closeNote || (inc.history || []).slice().reverse().find((h) => h.action === 'close')?.note || '(Ingen orsak/åtgärd angiven)';
  const n2 = inc.nis2 || {};
  const critSet = new Set(Array.isArray(n2.criticalSectors) ? n2.criticalSectors : String(inc.critical || '').split(',').map((s) => s.trim()).filter(Boolean));
  const handlerName = inc.closedBy || inc.updatedBy || inc.createdBy || 'Administratör';
  const histRows = (inc.history || []).map((h) => {
    const ts = h.ts ? new Date(h.ts).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) : '–';
    const act = h.action === 'create'
      ? 'Ärende registrerat'
      : h.action === 'close'
        ? `Ärende stängt (klartid: ${h.endedAt || '–'})`
        : h.action === 'reopen'
          ? 'Ärende återöppnat'
          : h.action === 'nms_ok'
            ? 'Övervakning (FrameFlow) rapporterar OK'
            : h.action === 'nis2_update'
              ? 'Komplettering av NIS2-data i arkivet'
              : 'Ärende uppdaterat';
    return `<tr class="border-b border-line"><td class="py-1.5 pr-3 font-mono text-xs whitespace-nowrap">${escHtml(ts)}</td><td class="py-1.5 pr-3 font-semibold text-xs">${escHtml(h.by || '?')}</td><td class="py-1.5 text-xs">${escHtml(act)}${h.note ? ` — <em>"${escHtml(h.note)}"</em>` : ''}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="sv" class="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Incidentrapport INC-${escHtml(inc.id)} – Driftpuls</title>
  <link rel="stylesheet" href="/assets/tailwind.css?v=${cssVersion}">
</head>
<body class="bg-page text-fg p-6 font-sans">
  <div class="max-w-4xl mx-auto bg-card border border-line rounded-2xl p-8 shadow-xl space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-line">
      <div>
        <div class="text-xs font-mono uppercase tracking-wider text-accent font-bold">Driftpuls &middot; Cybersäkerhetslagen (NIS2)</div>
        <h1 class="text-xl font-bold text-fg mt-0.5">INCIDENTRAPPORT &ndash; DOKUMENTREFERENS INC-${escHtml(inc.id)}</h1>
        <p class="text-xs text-muted">Sammanställd: ${escHtml(reportTs)} &middot; Handläggare: ${escHtml(handlerName)}</p>
      </div>
      <div class="flex gap-2">
        <button id="printBtn" class="bg-brand hover:bg-brand-dark text-white font-semibold px-4 py-2 rounded-xl text-xs">🖨️ Skriv ut / Spara som PDF</button>
        <button id="closeTabBtn" class="btn !px-3 !py-2 text-xs">Stäng</button>
      </div>
    </div>

    <section class="space-y-2">
      <h2 class="text-xs font-bold uppercase tracking-wider text-accent border-b border-line pb-1">Avsnitt 1: Verksamhet och incidentidentifiering</h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <div><strong>System / Rapportkälla:</strong> Driftpuls</div>
        <div><strong>Verksamhetsområde:</strong> ${escHtml(DOMAIN_LABEL[domain] || 'Stadsnät')}</div>
        <div><strong>Sektor enligt NIS2:</strong> ${escHtml(sector)}</div>
        <div><strong>Tillsynsmyndighet:</strong> ${escHtml(authority)}</div>
        <div><strong>Ärende-ID:</strong> <span class="font-mono">${escHtml(inc.id)}</span></div>
        <div><strong>Kategori:</strong> ${inc.kind === 'planned' ? 'Planerat underhåll / arbete' : 'Oplanerad driftstörning / Incident'}</div>
        ${inc.nmsDevice ? `<div class="sm:col-span-2"><strong>Larmande enhet (NMS):</strong> <span class="font-mono">${escHtml(inc.nmsDevice)}</span>${Array.isArray(inc.nmsDevices) && inc.nmsDevices.length > 1 ? ` <span class="text-muted">(${escHtml(inc.nmsDevices.join(', '))})</span>` : ''}</div>` : ''}
      </div>
    </section>

    <section class="space-y-2">
      <h2 class="text-xs font-bold uppercase tracking-wider text-accent border-b border-line pb-1">Avsnitt 2: Tidsförlopp och lagstadgade tidsfrister (NIS2 / CSL)</h2>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div class="bg-inset border border-line rounded-xl p-2.5"><div class="text-muted">Starttidpunkt</div><div class="font-mono font-bold">${escHtml(start)}</div></div>
        <div class="bg-inset border border-line rounded-xl p-2.5"><div class="text-muted">Faktisk sluttid</div><div class="font-mono font-bold">${escHtml(end)}</div></div>
        <div class="bg-inset border border-line rounded-xl p-2.5"><div class="text-muted">Total varaktighet</div><div class="font-bold">${escHtml(duration)}</div></div>
      </div>
      <div class="bg-inset border border-line rounded-xl p-3 text-xs space-y-1">
        <div class="font-semibold text-fg">Lagstadgade tidsfrister vid betydande incident:</div>
        <div>&bull; <strong>Tidig varning (24h från kännedom):</strong> <span class="font-mono">${escHtml(earlyWarningDeadline)}</span></div>
        <div>&bull; <strong>Incidentanmälan (72h från kännedom):</strong> <span class="font-mono">${escHtml(fullNoticeDeadline)}</span></div>
        <div>&bull; <strong>Slutrapport (senast 1 månad):</strong> <span class="font-mono">${escHtml(finalReportDeadline)}</span></div>
      </div>
    </section>

    <section class="space-y-2">
      <h2 class="text-xs font-bold uppercase tracking-wider text-accent border-b border-line pb-1">Avsnitt 3: Händelsebeskrivning, rotorsak och vidtagna åtgärder</h2>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div><strong>Typ av händelse:</strong> ${escHtml(inc.faultType)}</div>
        <div><strong>Drabbat område / Nod:</strong> ${escHtml(inc.area)}</div>
        <div><strong>Påverkade tjänster:</strong> ${escHtml(inc.services)}</div>
      </div>
      <div class="bg-inset border border-line rounded-xl p-3 text-xs space-y-1">
        <div class="font-semibold">Publicerad lägesrapport:</div>
        <div class="whitespace-pre-line text-fg2">${escHtml(inc.techDetails || '(Ingen publik lägesrapport angiven)')}</div>
      </div>
      <div class="bg-inset border border-line rounded-xl p-3 text-xs space-y-1">
        <div class="font-semibold">Fastställd orsak och vidtagna åtgärder:</div>
        <div class="whitespace-pre-line text-fg2">${escHtml(resolutionText)}</div>
      </div>
    </section>

    <section class="space-y-2">
      <h2 class="text-xs font-bold uppercase tracking-wider text-accent border-b border-line pb-1">Avsnitt 4: Audit Trail / Händelsehistorik</h2>
      <table class="w-full text-left border-collapse">
        <thead><tr class="border-b border-line text-[11px] text-muted"><th class="py-1 pr-3">Tidpunkt</th><th class="py-1 pr-3">Användare</th><th class="py-1">Händelse / Anteckning</th></tr></thead>
        <tbody>${histRows || '<tr><td colspan="3" class="py-2 text-xs text-muted">Ingen historik loggad.</td></tr>'}</tbody>
      </table>
    </section>

    <section class="space-y-3">
      <h2 class="text-xs font-bold uppercase tracking-wider text-accent border-b border-line pb-1">Avsnitt 5: Klassificering &amp; Myndighetsrapportering (NIS2)</h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div class="bg-inset border border-line rounded-xl p-3 space-y-1">
          <div class="font-semibold">1. Tröskelvärde för betydande incident</div>
          <div>${n2.significant === 'yes' ? '☑️ <strong>BETYDANDE INCIDENT</strong> (skall rapporteras till tillsynsmyndighet)' : '☑️ Understiger tröskelvärde (enbart intern driftlogg)'}</div>
        </div>
        <div class="bg-inset border border-line rounded-xl p-3 space-y-1">
          <div class="font-semibold">2. Volymmässig påverkan</div>
          <div>Antal berörda abonnenter: <strong>${escHtml(n2.affectedCustomers || inc.customers || 'Ej angivet')} st</strong> (${escHtml(n2.affectedPercent || '–')} %)</div>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div class="bg-inset border border-line rounded-xl p-3 space-y-1">
          <div class="font-semibold">3. Samhällsviktiga funktioner</div>
          ${Object.entries(CRIT_LABELS).map(([k, lbl]) => `<div>${critSet.has(k) ? '☑️' : '☐'} ${escHtml(lbl)}</div>`).join('')}
          ${n2.criticalComment ? `<div class="pt-1 text-fg2"><strong>Kommentar:</strong> ${escHtml(n2.criticalComment)}</div>` : ''}
        </div>
        <div class="bg-inset border border-line rounded-xl p-3 space-y-1">
          <div class="font-semibold">4. Bakomliggande orsaksklassificering</div>
          <div><strong>${escHtml(CAUSE_LABELS[n2.rootCauseCategory] || 'Ej klassificerad / Planerat arbete')}</strong></div>
          <div class="pt-2 font-semibold">5. Myndighetskontakter &amp; Diarienummer</div>
          <div>Tillsynsmyndighet (Diarienr): <span class="font-mono">${escHtml(n2.authorityRef || '–')}</span></div>
          <div>Polismyndigheten (K1-nr): <span class="font-mono">${escHtml(n2.policeRef || '–')}</span></div>
          <div>CERT-SE / MSB-referens: <span class="font-mono">${escHtml(n2.certRef || '–')}</span></div>
        </div>
      </div>

      <div class="bg-inset border border-line rounded-xl p-3 text-xs space-y-1">
        <div class="font-semibold">6. Förebyggande åtgärder för att förhindra återupprepning</div>
        <div><strong>Åtgärd 1:</strong> ${escHtml(n2.preventiveAction || '–')}</div>
        ${n2.preventiveAction2 ? `<div><strong>Åtgärd 2:</strong> ${escHtml(n2.preventiveAction2)}</div>` : ''}
      </div>

      <div class="grid grid-cols-2 gap-6 pt-6 mt-4 border-t border-line text-xs">
        <div>
          <div class="text-muted">Ansvarig handläggare / Driftledning</div>
          <div class="font-semibold mt-4 pt-1 border-t border-line">${escHtml(handlerName)}</div>
        </div>
        <div>
          <div class="text-muted">Datum &amp; Signatur (CISO / Säkerhetsansvarig)</div>
          <div class="font-semibold mt-4 pt-1 border-t border-line">${escHtml(closedTs.slice(0, 10))}</div>
        </div>
      </div>
    </section>
  </div>
  <script src="/print.js?v=${jsVersion}" defer></script>
</body>
</html>`;
}

// ---------- Säkerhetsheaders (gäller oavsett vad proxyn gör) ----------
const CSP_PUBLIC = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
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
app.set('trust proxy', process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(',').map(s => s.trim()) : TRUSTED_PROXIES);

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

// ---------- Publik driftportal ----------
// Versionsnummer på CSS-filen så att ändringar syns direkt trots lång cache
const CSS_V = (() => {
  try { return Math.floor(fs.statSync(path.join(__dirname, 'public', 'assets', 'tailwind.css')).mtimeMs); } catch { return 0; }
})();

const JS_V = (() => {
  try { return Math.floor(fs.statSync(path.join(__dirname, 'public', 'admin.js')).mtimeMs); } catch { return 0; }
})();
// Sidorna serveras med versionsnummer på skript och CSS, så att webbläsaren aldrig kör en gammal kopia
const readPage = (name) => fs.readFileSync(path.join(__dirname, 'public', name), 'utf8')
  .replace('/assets/tailwind.css', `/assets/tailwind.css?v=${CSS_V}`)
  .replace('/theme.js', `/theme.js?v=${JS_V}`)
  .replace('/admin.js', `/admin.js?v=${JS_V}`)
  .replace('/login.js', `/login.js?v=${JS_V}`);
const ADMIN_HTML = readPage('index.html');
const LOGIN_HTML = readPage('login.html');

// Datum i klartext för besökare: "mån 2 nov 21:00" (årtal visas bara om det inte är i år)
const WD = ['sön', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör'];
const MON = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const whenText = (date, time) => {
  if (!isDate(date || '')) return time || '';
  const [y, m, d] = date.split('-').map(Number);
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const yr = y === Number(todayLocal().slice(0, 4)) ? '' : ` ${y}`;
  return `${wd} ${d} ${MON[m - 1]}${yr} ${time || ''}`.trim();
};
const MAX_PLANNED_SHOWN = 5; // fler planerade arbeten döljs bakom "Visa fler"

const TONE = {
  incident: { bar: 'bg-danger', edge: 'border-l-danger' },
  planned: { bar: 'bg-info', edge: 'border-l-info' },
  resolved: { bar: 'bg-emerald-500', edge: 'border-l-emerald-500' },
};

function loadRecentlyResolved(hours = 24, activeIds = new Set()) {
  if (!fs.existsSync(archiveFile)) return [];
  const cutoffMs = Date.now() - hours * 3600 * 1000;
  const seen = new Set();
  const recent = [];
  try {
    const lines = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || !r.id || activeIds.has(r.id) || seen.has(r.id) || r.hidePublic) continue;
      // Hoppa över planerade arbeten som avbokats före start
      if (r.kind === 'planned' && r.endedAt && r.endedAt < startKey(r)) continue;
      const closedMs = r.closedAt
        ? Date.parse(r.closedAt)
        : (r.endedAt ? Date.parse(r.endedAt.replace(' ', 'T') + ':00') : NaN);
      if (Number.isNaN(closedMs) || closedMs < cutoffMs) continue;
      seen.add(r.id);
      recent.push(r);
      if (recent.length >= 10) break;
    }
  } catch {}
  return recent;
}

function renderRss(all, recentOverride = null) {
  const now = nowLocal();
  const phase = (i) => (now < startKey(i) ? 'upcoming' : endKey(i) && now > endKey(i) ? 'over' : 'ongoing');
  const activeIds = new Set(all.map((i) => i.id));
  const recent = Array.isArray(recentOverride)
    ? recentOverride.filter((r) => r && r.id && !activeIds.has(r.id))
    : loadRecentlyResolved(24, activeIds);
  const incidents = all.filter((i) => i.kind !== 'planned').sort((a, b) => startKey(b).localeCompare(startKey(a)));
  const planned = all.filter((i) => i.kind === 'planned' && phase(i) !== 'over').sort((a, b) => startKey(a).localeCompare(startKey(b)));
  const baseUrl = (PUBLIC_URL || `http://localhost:${PORTAL_PORT}/`).replace(/\/+$/, '') + '/';

  const toRfc822 = (isoOrLocal) => {
    const d = isoOrLocal ? new Date(isoOrLocal.includes('T') ? isoOrLocal : isoOrLocal.replace(' ', 'T') + ':00') : new Date();
    return Number.isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
  };

  const itemsXml = [];
  for (const inc of incidents) {
    const dom = DOMAIN_LABEL[inc.domain] || 'Stadsnät';
    const title = `[DRIFTSTÖRNING - ${dom}] ${inc.area}: ${inc.faultType}`;
    const ettr = endKey(inc) ? `${inc.ettrDate} ${inc.ettr}` : (inc.ettr || 'Ej fastställt');
    const desc = `Status: ${inc.statusType}. Påverkade tjänster: ${inc.services}. Start: ${startKey(inc)}. Beräknad klartid: ${ettr}.${inc.techDetails ? ' Lägesrapport: ' + inc.techDetails : ''}`;
    itemsXml.push(`    <item>
      <title>${esc(title)}</title>
      <link>${esc(baseUrl)}</link>
      <guid isPermaLink="false">driftpuls-${esc(inc.id)}-active-${esc(inc.updatedAt || inc.createdAt || '')}</guid>
      <pubDate>${esc(toRfc822(inc.updatedAt || inc.createdAt))}</pubDate>
      <description>${esc(desc)}</description>
    </item>`);
  }
  for (const inc of planned) {
    const dom = DOMAIN_LABEL[inc.domain] || 'Stadsnät';
    const title = `[PLANERAT ARBETE - ${dom}] ${inc.area}: ${inc.faultType}`;
    const ettr = endKey(inc) ? `${inc.ettrDate} ${inc.ettr}` : (inc.ettr || '–');
    const desc = `Planerat arbete (${phase(inc) === 'ongoing' ? 'Pågår nu' : 'Kommande'}). Påverkade tjänster: ${inc.services}. Planerad start: ${startKey(inc)}. Planerat slut: ${ettr}.${inc.techDetails ? ' Info: ' + inc.techDetails : ''}`;
    itemsXml.push(`    <item>
      <title>${esc(title)}</title>
      <link>${esc(baseUrl)}</link>
      <guid isPermaLink="false">driftpuls-${esc(inc.id)}-planned-${esc(inc.updatedAt || inc.createdAt || '')}</guid>
      <pubDate>${esc(toRfc822(inc.updatedAt || inc.createdAt))}</pubDate>
      <description>${esc(desc)}</description>
    </item>`);
  }
  for (const inc of recent) {
    const dom = DOMAIN_LABEL[inc.domain] || 'Stadsnät';
    const title = `[ÅTGÄRDAD - ${dom}] ${inc.area}: ${inc.faultType}`;
    const desc = `Händelsen är åtgärdad och avslutad (${inc.endedAt || 'klart'}). Påverkade tjänster var: ${inc.services}.`;
    itemsXml.push(`    <item>
      <title>${esc(title)}</title>
      <link>${esc(baseUrl)}</link>
      <guid isPermaLink="false">driftpuls-${esc(inc.id)}-resolved-${esc(inc.closedAt || '')}</guid>
      <pubDate>${esc(toRfc822(inc.closedAt || inc.endedAt))}</pubDate>
      <description>${esc(desc)}</description>
    </item>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Driftpuls - Driftportal</title>
    <link>${esc(baseUrl)}</link>
    <description>Aktuella driftstörningar, planerade arbeten och nyligen åtgärdade händelser från Driftpuls.</description>
    <language>sv-SE</language>
    <lastBuildDate>${esc(new Date().toUTCString())}</lastBuildDate>
${itemsXml.join('\n')}
  </channel>
</rss>
`;
}

function renderPortal(all, recentOverride = null) {
  const now = nowLocal();
  const updated = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const phase = (i) => (now < startKey(i) ? 'upcoming' : endKey(i) && now > endKey(i) ? 'over' : 'ongoing');
  const incidents = all.filter((i) => i.kind !== 'planned').sort((a, b) => startKey(b).localeCompare(startKey(a))); // senaste först
  const planned = all
    .filter((i) => i.kind === 'planned' && phase(i) !== 'over')
    .sort((a, b) => startKey(a).localeCompare(startKey(b)));
  const activeIds = new Set(all.map((i) => i.id));
  const recent = Array.isArray(recentOverride)
    ? recentOverride.filter((r) => r && r.id && !activeIds.has(r.id))
    : loadRecentlyResolved(24, activeIds);
  const active = incidents.length > 0;
  const plannedNow = planned.some((i) => phase(i) === 'ongoing');

  const fmtLocalKey = (k) => {
    const [d, t] = String(k || '').split(' ');
    return isDate(d || '') ? whenText(d, t) : (k || '–');
  };

  const box = (label, value) => `<div class="bg-inset border border-line rounded-xl p-3"><div class="text-xs text-muted">${label}</div><div class="text-sm font-bold text-accent">${esc(value)}</div></div>`;
  const renderUpdatesTimeline = (inc) => {
    const updates = Array.isArray(inc.publicUpdates) ? inc.publicUpdates : [];
    if (updates.length <= 1) return '';
    const rev = updates.slice().reverse();
    const items = rev.map((u, idx) => `
      <li class="pb-2 last:pb-0">
        <div class="flex flex-wrap items-center gap-2 text-[11px]">
          <span class="font-mono font-semibold text-accent">${esc(fmtLocalKey(u.ts))}</span>
          ${idx === 0 ? '<span class="px-1.5 py-0.5 rounded bg-brand/20 text-accent text-[10px] font-semibold">Senaste</span>' : idx === rev.length - 1 ? '<span class="px-1.5 py-0.5 rounded bg-soft text-faint text-[10px] font-semibold">Start</span>' : ''}
          ${u.status ? `<span class="text-faint">&middot; ${esc(u.status)}</span>` : ''}
          ${u.ettr ? `<span class="text-faint">&middot; Prognos: ${esc(fmtLocalKey(u.ettr))}</span>` : ''}
        </div>
        <div class="text-xs text-fg2 mt-0.5 whitespace-pre-line">${esc(u.text)}</div>
      </li>`).join('');
    return `
      <details class="bg-inset border border-line rounded-xl px-3.5 py-2.5 text-xs">
        <summary class="cursor-pointer select-none font-semibold text-fg2 hover:text-fg">🕒 Tidslinje för lägesuppdateringar (${updates.length} st)</summary>
        <ul class="mt-2.5 space-y-2 border-l-2 border-line pl-3">${items}</ul>
      </details>`;
  };

  const card = (inc, isPlanned) => {
    const p = isPlanned ? phase(inc) : '';
    const badge = isPlanned
      ? (p === 'upcoming' ? '📅 Kommande planerat arbete' : '🔧 Pågående planerat arbete')
      : inc.statusType;
    const badgeStyle = isPlanned && p === 'ongoing'
      ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30'
      : 'bg-brand/20 text-accent border border-brand/30';
    const scopeInfo = !isPlanned && inc.scope && SCOPE_META[inc.scope] ? SCOPE_META[inc.scope] : null;
    const scopeBadgeHtml = scopeInfo
      ? `<span class="${scopeInfo.style} text-xs px-3 py-1 rounded-full font-medium">${esc(scopeInfo.label)}</span>`
      : '';
    const start = whenText(inc.startDate || (inc.createdAt || '').slice(0, 10), inc.startTime);
    const end = endKey(inc) ? whenText(inc.ettrDate, inc.ettr) : inc.ettr || '–';
    return `
        <div class="bg-card border border-line border-l-4 ${TONE[isPlanned ? 'planned' : 'incident'].edge} rounded-2xl p-6 shadow-xl space-y-3">
          <div class="flex flex-wrap gap-2"><span class="${badgeStyle} text-xs px-3 py-1 rounded-full font-medium">${esc(badge)}</span><span class="bg-soft text-fg2 text-xs px-3 py-1 rounded-full font-medium">${esc(DOMAIN_LABEL[inc.domain] || DOMAIN_LABEL.stadsnat)}</span>${scopeBadgeHtml}</div>
          <h3 class="text-xl font-bold text-fg">${esc(inc.faultType)}: ${esc(inc.area)}</h3>
          <p class="text-sm text-fg2">Påverkade tjänster: <strong class="text-fg">${esc(inc.services)}</strong></p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${box(isPlanned ? 'Planerad start' : 'Start', start)}${box(isPlanned ? 'Planerat slut' : 'Beräknad klartid', end)}</div>
          ${inc.techDetails ? `<p class="text-xs text-muted bg-inset p-3 rounded-xl border border-line whitespace-pre-line"><strong>Lägesrapport:</strong> ${esc(inc.techDetails)}</p>` : ''}
          ${renderUpdatesTimeline(inc)}
        </div>`;
  };
  const resolvedCard = (inc) => {
    const start = whenText(inc.startDate || (inc.createdAt || '').slice(0, 10), inc.startTime);
    const end = fmtLocalKey(inc.endedAt);
    return `
        <div class="bg-card border border-line border-l-4 ${TONE.resolved.edge} rounded-2xl p-5 shadow-md space-y-2.5 opacity-95">
          <div class="flex flex-wrap gap-2">
            <span class="bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 text-xs px-3 py-1 rounded-full font-medium">✅ Åtgärdad</span>
            <span class="bg-soft text-fg2 text-xs px-3 py-1 rounded-full font-medium">${esc(DOMAIN_LABEL[inc.domain] || DOMAIN_LABEL.stadsnat)}</span>
          </div>
          <h3 class="text-lg font-bold text-fg">${esc(inc.faultType)}: ${esc(inc.area)}</h3>
          <p class="text-xs text-fg2">Påverkade tjänster: <strong class="text-fg">${esc(inc.services)}</strong></p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${box('Start', start)}${box('Åtgärdad / Avslutad', end)}</div>
          <p class="text-xs text-muted bg-inset p-2.5 rounded-xl border border-line">Felet är åtgärdat och samtliga tjänster är åter i normal drift.</p>
          ${renderUpdatesTimeline(inc)}
        </div>`;
  };
  const group = (title, items, isPlanned, extra = []) => `
      <section class="space-y-4" aria-label="${title}">
        <div class="flex items-center gap-3 pb-2 border-b border-line">
          <span class="w-1.5 h-6 rounded-full ${TONE[isPlanned ? 'planned' : 'incident'].bar}"></span>
          <h2 class="text-base font-bold text-fg">${title}</h2>
          <span class="text-xs font-mono px-2 py-0.5 rounded-full bg-soft text-fg2">${items.length + extra.length}</span>
        </div>
        ${items.map((i) => card(i, isPlanned)).join('')}
        ${extra.length ? `<details><summary class="cursor-pointer select-none text-sm font-semibold text-info bg-card border border-line rounded-xl px-4 py-3 hover:border-line-strong">Visa ${extra.length} fler planerade arbeten</summary><div class="space-y-4 pt-4">${extra.map((i) => card(i, isPlanned)).join('')}</div></details>` : ''}
      </section>`;
  const resolvedGroup = (items) => `
      <section class="space-y-4" aria-label="Nyligen åtgärdade störningar (senaste 24h)">
        <div class="flex items-center gap-3 pb-2 border-b border-line">
          <span class="w-1.5 h-6 rounded-full ${TONE.resolved.bar}"></span>
          <h2 class="text-base font-bold text-fg">Nyligen åtgärdade händelser (senaste 24 timmarna)</h2>
          <span class="text-xs font-mono px-2 py-0.5 rounded-full bg-soft text-fg2">${items.length}</span>
        </div>
        ${items.map(resolvedCard).join('')}
      </section>`;
  const normal = `
        <div class="bg-card border border-line rounded-2xl p-8 text-center space-y-2">
          <h2 class="text-xl font-bold text-fg">Alla tjänster fungerar som normalt</h2>
          <p class="text-sm text-muted">Det finns inga rapporterade driftstörningar för närvarande.</p>
        </div>`;
  const main = (active ? group('Pågående störningar', incidents, false) : normal)
    + (planned.length ? group('Planerade arbeten', planned.slice(0, MAX_PLANNED_SHOWN), true, planned.slice(MAX_PLANNED_SHOWN)) : '')
    + (recent.length ? resolvedGroup(recent) : '');

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="refresh" content="60">
  <title>Driftpuls - Aktuell status</title>
  <link rel="stylesheet" href="/assets/tailwind.css?v=${CSS_V}">
  <link rel="alternate" type="application/rss+xml" title="Driftpuls - Driftstatus (RSS)" href="/rss.xml">
</head>
<body class="bg-page text-fg min-h-screen flex flex-col justify-between p-6 font-sans">
  <div class="max-w-3xl mx-auto w-full space-y-6">
    <header class="border-b border-line pb-4 flex justify-between items-center">
      <div class="flex items-center gap-2.5">
        <span class="inline-block w-3 h-3 ${active ? 'bg-brand animate-pulse' : 'bg-emerald-500'} rounded-full"></span>
        <h1 class="text-lg font-bold tracking-tight text-fg">Driftpuls</h1>
      </div>
      <span class="text-xs text-muted font-mono">${active ? 'Aktiva störningar inrapporterade' : plannedNow ? 'Planerat arbete pågår' : 'Normal drift - Inga störningar'}</span>
    </header>
    <main class="space-y-10">${main}</main>
    <footer class="text-center text-xs text-faint space-y-1.5">
      <div>Driftpuls &middot; Senast uppdaterad ${esc(updated)}. Sidan laddas om automatiskt.</div>
      <div class="flex justify-center gap-4 text-[11px]">
        <a href="/rss.xml" class="hover:text-fg2 underline">📡 RSS-flöde</a>
        <span>&middot;</span>
        <a href="/status.json" class="hover:text-fg2 underline">JSON-status</a>
      </div>
    </footer>
  </div>
</body>
</html>`;
}

// Arkivera automatiskt planerade arbeten där sluttiden passerats med mer än graceMinutes (standard 60 min)
function autoArchiveCompletedPlanned(graceMinutes = 60, refNow = nowLocal()) {
  const all = load();
  if (!all.length) return 0;
  const parseLocalKey = (k) => (k ? Date.parse(k.replace(' ', 'T') + ':00Z') : NaN);
  const nowMs = parseLocalKey(refNow);
  if (Number.isNaN(nowMs)) return 0;

  let archivedCount = 0;
  const remaining = [];
  for (const inc of all) {
    const eKey = endKey(inc);
    const endMs = inc.kind === 'planned' && eKey ? parseLocalKey(eKey) : NaN;
    if (inc.kind === 'planned' && !Number.isNaN(endMs) && (nowMs - endMs) >= graceMinutes * 60000) {
      const closedAt = new Date().toISOString();
      const note = 'Planerat arbete slutfört enligt tidsplan (automatiskt arkiverat).';
      const history = [...(inc.history || []), { ts: closedAt, by: 'system', action: 'close', endedAt: eKey, note }].slice(-200);
      const closedRecord = {
        ...inc,
        history,
        endedAt: eKey,
        closedAt,
        closedBy: 'system',
        resolution: note,
        nis2: {
          significant: 'no',
          affectedCustomers: inc.customers ? String(inc.customers) : '',
          affectedPercent: '',
          rootCauseCategory: '',
          criticalSectors: [],
          criticalComment: '',
          preventiveAction: '',
        },
      };
      try {
        fs.appendFileSync(archiveFile, JSON.stringify(closedRecord) + '\n');
        const report = generateCyberReport(closedRecord);
        fs.writeFileSync(path.join(REPORTS_DIR, `incident-${inc.id}.md`), report, 'utf8');
        audit('auto_archive_planned', { id: inc.id, area: inc.area, endedAt: eKey });
        archivedCount++;
      } catch (err) {
        console.error('Kunde inte auto-arkivera planerat arbete:', err);
        remaining.push(inc);
      }
    } else {
      remaining.push(inc);
    }
  }
  if (archivedCount > 0) save(remaining);
  return archivedCount;
}

// Generera den statiska publika driftportalen, status.json och rss.xml
function generatePublicSite() {
  try {
    autoArchiveCompletedPlanned(60);
    const assetsDir = path.join(PUBLIC_DIR, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const srcAssets = path.join(__dirname, 'public', 'assets');
    if (fs.existsSync(srcAssets)) {
      fs.cpSync(srcAssets, assetsDir, { recursive: true });
    }
    const all = load();
    const activeIds = new Set(all.map((i) => i.id));
    const recent = loadRecentlyResolved(24, activeIds);
    const html = renderPortal(all, recent);
    const tmpHtml = path.join(PUBLIC_DIR, 'index.html.tmp');
    const targetHtml = path.join(PUBLIC_DIR, 'index.html');
    fs.writeFileSync(tmpHtml, html, 'utf8');
    fs.renameSync(tmpHtml, targetHtml);

    // Generera RSS 2.0-flöde (rss.xml)
    const rssXml = renderRss(all, recent);
    const tmpRss = path.join(PUBLIC_DIR, 'rss.xml.tmp');
    const targetRss = path.join(PUBLIC_DIR, 'rss.xml');
    fs.writeFileSync(tmpRss, rssXml, 'utf8');
    fs.renameSync(tmpRss, targetRss);

    // Generera maskinläsbar status.json
    const now = nowLocal();
    const phase = (i) => (now < startKey(i) ? 'upcoming' : endKey(i) && now > endKey(i) ? 'over' : 'ongoing');
    const incidents = all.filter((i) => i.kind !== 'planned').sort((a, b) => startKey(b).localeCompare(startKey(a)));
    const planned = all.filter((i) => i.kind === 'planned' && phase(i) !== 'over').sort((a, b) => startKey(a).localeCompare(startKey(b)));
    const statusData = {
      updated: new Date().toISOString(),
      updatedLocal: now,
      status: incidents.length > 0 ? 'incident' : planned.some((i) => phase(i) === 'ongoing') ? 'planned' : 'normal',
      summary: incidents.length > 0 ? 'Aktiva störningar inrapporterade' : planned.some((i) => phase(i) === 'ongoing') ? 'Planerat arbete pågår' : 'Normal drift - Inga störningar',
      counts: {
        activeIncidents: incidents.length,
        activePlanned: planned.length,
        recentlyResolved24h: recent.length
      },
      incidents: incidents.map((i) => ({
        id: i.id,
        domain: i.domain,
        domainLabel: DOMAIN_LABEL[i.domain] || 'Stadsnät',
        statusType: i.statusType,
        area: i.area,
        scope: i.scope || '',
        scopeLabel: SCOPE_META[i.scope]?.label || '',
        faultType: i.faultType,
        services: i.services,
        startDate: i.startDate,
        startTime: i.startTime,
        ettrDate: i.ettrDate || '',
        ettr: i.ettr || '',
        techDetails: i.techDetails || '',
        publicUpdates: Array.isArray(i.publicUpdates) ? i.publicUpdates : [],
        updatedAt: i.updatedAt || i.createdAt
      })),
      planned: planned.map((i) => ({
        id: i.id,
        domain: i.domain,
        domainLabel: DOMAIN_LABEL[i.domain] || 'Stadsnät',
        phase: phase(i),
        statusType: i.statusType,
        area: i.area,
        faultType: i.faultType,
        services: i.services,
        startDate: i.startDate,
        startTime: i.startTime,
        ettrDate: i.ettrDate || '',
        ettr: i.ettr || '',
        techDetails: i.techDetails || '',
        publicUpdates: Array.isArray(i.publicUpdates) ? i.publicUpdates : [],
        updatedAt: i.updatedAt || i.createdAt
      })),
      recentlyResolved: recent.map((r) => ({
        id: r.id,
        domain: r.domain,
        domainLabel: DOMAIN_LABEL[r.domain] || 'Stadsnät',
        kind: r.kind || 'incident',
        area: r.area,
        faultType: r.faultType,
        services: r.services,
        startDate: r.startDate,
        startTime: r.startTime,
        endedAt: r.endedAt || '',
        closedAt: r.closedAt || '',
        publicUpdates: Array.isArray(r.publicUpdates) ? r.publicUpdates : []
      }))
    };
    const tmpJson = path.join(PUBLIC_DIR, 'status.json.tmp');
    const targetJson = path.join(PUBLIC_DIR, 'status.json');
    fs.writeFileSync(tmpJson, JSON.stringify(statusData, null, 2), 'utf8');
    fs.renameSync(tmpJson, targetJson);
  } catch (e) {
    console.error('Kunde inte skriva publik webbplats:', e);
  }
}

let cache = { html: '', t: 0 };
const invalidate = () => {
  cache.t = 0;
  generatePublicSite();
};
function portal(req, res) {
  if (Date.now() - cache.t > 10000) cache = { html: renderPortal(load()), t: Date.now() };
  res.set('Cache-Control', 'no-cache').type('html').send(cache.html);
}

// ---------- FrameFlow-motor (Pull & Push -> Larminkorg i Admin) ----------
function extractFrameFlowItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const k of ['alerts', 'devices', 'monitors', 'events', 'items', 'data', 'results']) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  if (typeof payload === 'object') return [payload];
  return [];
}

function processFrameFlowPayload(payload, source = 'push') {
  const rawItems = extractFrameFlowItems(payload);
  if (!rawItems.length) return { processed: 0, created: 0, updated: 0, resolved: 0 };

  const settings = loadSettings();
  const alerts = loadAlerts();
  const incidents = load();
  let incidentsChanged = false;
  let created = 0, updated = 0, resolved = 0;
  const now = new Date().toISOString();

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const device = text(raw.device || raw.hostname || raw.host || raw.system || raw.node || raw.deviceName || raw.name, 100);
    const monitor = text(raw.monitor || raw.eventMonitor || raw.monitorName || raw.check || raw.sensor || raw.service || 'SNMP-övervakning', 100);
    const statusRaw = text(raw.status || raw.state || raw.severity || raw.level || 'Critical', 40);
    const message = text(raw.message || raw.details || raw.description || raw.summary || raw.output || '', 500);
    if (!device && !message) continue;

    const devName = device || 'Okänd enhet';
    const key = `${devName.toLowerCase()}::${monitor.toLowerCase()}`;
    const isResolved = /^(ok|up|normal|online|clear|cleared|resolved|informational|info|success|healthy|0)$/i.test(statusRaw);
    const isProblem = !isResolved;

    const matchedNode = matchNode(`${devName} ${raw.area || ''} ${message}`, settings.nodes);
    const area = matchedNode ? matchedNode.name : text(raw.area || devName, 80);
    const domain = matchedNode
      ? (DOMAINS.includes(matchedNode.domain) ? matchedNode.domain : 'stadsnat')
      : (/fv-|fjärrvärme|fjarrvarme|värmeverk|panncentral/i.test(`${devName} ${monitor} ${message}`) ? 'fjarrvarme' : 'stadsnat');
    const customers = matchedNode ? (parseInt(matchedNode.customers, 10) || 0) : (parseInt(raw.customers, 10) || 0);
    const distCount = matchedNode ? Math.max(1, parseInt(matchedNode.distCount, 10) || 1) : 1;
    const accCount = matchedNode ? Math.max(1, parseInt(matchedNode.accCount, 10) || 24) : 24;
    const critical = matchedNode ? String(matchedNode.critical || '') : '';
    const roleInfo = parseDeviceRole(devName);

    const combined = `${devName} ${monitor} ${message}`;
    let faultType = 'Hårdvarufel';
    let services = 'Bredband, TV';
    if (domain === 'fjarrvarme') {
      services = 'Värme, Varmvatten';
      if (/tryck|pump/i.test(combined)) faultType = 'Tryckfall';
      else if (/pann|verk/i.test(combined)) faultType = 'Värmeverk';
      else faultType = 'Ledningsbrott';
    } else {
      if (/ups|batteri|battery|power|ström|strom|mains|likriktare|spänning|voltage/i.test(combined)) {
        faultType = 'Strömavbrott';
      } else {
        faultType = 'Hårdvarufel';
      }
    }

    const existingIdx = alerts.findIndex((a) => a.key === key && !a.dismissed);

    if (isProblem) {
      if (existingIdx >= 0) {
        const ex = alerts[existingIdx];
        ex.status = statusRaw;
        ex.message = message || ex.message;
        ex.updatedAt = now;
        ex.resolvedAt = null;
        ex.area = area;
        ex.domain = domain;
        ex.faultType = faultType;
        ex.services = services;
        ex.customers = customers;
        ex.distCount = distCount;
        ex.accCount = accCount;
        ex.deviceRole = roleInfo.role;
        ex.critical = critical;
        updated++;
      } else {
        alerts.unshift({
          id: crypto.randomUUID(),
          key,
          source,
          device: devName,
          deviceRole: roleInfo.role,
          monitor,
          status: statusRaw,
          message: message || `${monitor} rapporterar ${statusRaw} på ${devName}`,
          area,
          domain,
          faultType,
          services,
          customers,
          distCount,
          accCount,
          critical,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
          dismissed: false,
          linkedIncidentId: null,
        });
        created++;
      }
      // Om ett aktivt ärende var markerat som återställt (eller delvis återställt) men enheten larmar igen
      const devLow = devName.toLowerCase();
      for (const inc of incidents) {
        const inMulti = Array.isArray(inc.nmsDevices) && inc.nmsDevices.some((d) => String(d).toLowerCase() === devLow);
        if (inMulti && Array.isArray(inc.nmsResolvedDevices)) {
          const prevLen = inc.nmsResolvedDevices.length;
          inc.nmsResolvedDevices = inc.nmsResolvedDevices.filter((d) => String(d).toLowerCase() !== devLow);
          if (inc.nmsResolvedDevices.length !== prevLen) incidentsChanged = true;
        }
        if ((inc.alertKey === key || inMulti || (inc.nmsDevice && inc.nmsDevice.toLowerCase() === devLow)) && inc.nmsResolvedAt) {
          delete inc.nmsResolvedAt;
          incidentsChanged = true;
        }
      }
    } else {
      // Enheten rapporteras som OK / Up i FrameFlow
      if (existingIdx >= 0 && !alerts[existingIdx].resolvedAt) {
        alerts[existingIdx].status = 'OK';
        alerts[existingIdx].resolvedAt = now;
        alerts[existingIdx].updatedAt = now;
        resolved++;
      }
      const devLow = devName.toLowerCase();
      for (const inc of incidents) {
        const multiDevs = Array.isArray(inc.nmsDevices) ? inc.nmsDevices : [];
        const inMulti = multiDevs.some((d) => String(d).toLowerCase() === devLow);
        const matchInc = inc.alertKey === key
          || (existingIdx >= 0 && (inc.alertId === alerts[existingIdx].id || (Array.isArray(inc.alertIds) && inc.alertIds.includes(alerts[existingIdx].id))))
          || inMulti
          || (inc.nmsDevice && inc.nmsDevice.toLowerCase() === devLow);

        if (!matchInc) continue;

        if (multiDevs.length > 1) {
          const resolvedList = Array.isArray(inc.nmsResolvedDevices) ? [...inc.nmsResolvedDevices] : [];
          const alreadyResolved = resolvedList.some((d) => String(d).toLowerCase() === devLow);
          if (!alreadyResolved) {
            const canonicalDev = multiDevs.find((d) => String(d).toLowerCase() === devLow) || devName;
            resolvedList.push(canonicalDev);
            inc.nmsResolvedDevices = resolvedList;
            const allUp = resolvedList.length >= multiDevs.length;
            if (allUp && !inc.nmsResolvedAt) {
              inc.nmsResolvedAt = nowLocal();
            }
            inc.history = [...(inc.history || []), {
              ts: now,
              by: 'FrameFlow',
              action: 'nms_ok',
              note: allUp
                ? `Samtliga ${multiDevs.length} länkade enheter återställda (senast ${devName}).`
                : `Enhet ${devName} åter online (${resolvedList.length} av ${multiDevs.length} enheter återställda).`,
            }].slice(-200);
            incidentsChanged = true;
            resolved++;
          }
        } else if (!inc.nmsResolvedAt) {
          inc.nmsResolvedAt = nowLocal();
          inc.nmsResolvedDevices = [devName];
          inc.history = [...(inc.history || []), {
            ts: now,
            by: 'FrameFlow',
            action: 'nms_ok',
            note: `Enhet ${devName} (${monitor}) rapporterar återställd status (${statusRaw}).`,
          }].slice(-200);
          incidentsChanged = true;
          resolved++;
        }
      }
    }
  }

  // Behåll max 50 larm i inkorgen
  saveAlerts(alerts.slice(0, 50));
  if (incidentsChanged) save(incidents);

  if (created > 0 && settings.notifications?.enabled && settings.notifications?.onFrameFlowAlert) {
    const newest = alerts[0];
    if (newest) {
      sendNotification(
        `🚨 FrameFlow-larm: ${newest.area} (${newest.device})`,
        `Typ: ${newest.faultType} | Status: ${newest.status} | Detaljer: ${newest.message}`,
        { event: 'frameflow_alert', area: newest.area, device: newest.device, faultType: newest.faultType }
      ).catch(() => {});
    }
  }

  return { processed: rawItems.length, created, updated, resolved };
}

let ffPollTimer = null;
async function pollFrameFlow() {
  const settings = loadSettings();
  const ff = settings.frameflow;
  if (!ff.pullEnabled || !ff.apiUrl) return;
  try {
    const reqHeaders = { Accept: 'application/json' };
    if (ff.apiKey) {
      reqHeaders.Authorization = ff.apiKey.startsWith('Bearer ') ? ff.apiKey : `Bearer ${ff.apiKey}`;
      reqHeaders['X-API-Key'] = ff.apiKey;
    }
    const res = await fetch(ff.apiUrl, { headers: reqHeaders, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const stats = processFrameFlowPayload(payload, 'pull');
    const latest = loadSettings();
    latest.frameflow.lastPollAt = new Date().toISOString();
    latest.frameflow.lastPollOk = true;
    latest.frameflow.lastPollMsg = `OK (${stats.processed} objekt kontrollerade, ${stats.created} nya larm)`;
    saveSettings(latest);
  } catch (err) {
    const latest = loadSettings();
    latest.frameflow.lastPollAt = new Date().toISOString();
    latest.frameflow.lastPollOk = false;
    latest.frameflow.lastPollMsg = err.message || 'Anslutningsfel vid API-polling';
    saveSettings(latest);
  }
}

function scheduleFrameFlowPoller() {
  if (ffPollTimer) {
    clearInterval(ffPollTimer);
    ffPollTimer = null;
  }
  const settings = loadSettings();
  if (settings.frameflow.pullEnabled && settings.frameflow.apiUrl) {
    const ms = Math.max(15, settings.frameflow.pollIntervalSec || 60) * 1000;
    ffPollTimer = setInterval(pollFrameFlow, ms);
    setTimeout(pollFrameFlow, 1500);
  }
}

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

// Rate-limiting och brute-force-skydd för inkommande FrameFlow-webhook
const ffAuthFails = new Map(); // ip -> { count, until, ts }
const ffRateWindow = new Map(); // ip -> { count, resetAt }

function cleanupFrameFlowRateLimits(now = Date.now()) {
  for (const [ip, f] of ffAuthFails.entries()) {
    if ((f.until && f.until < now) || (f.ts && now - f.ts > 3600e3)) {
      ffAuthFails.delete(ip);
    }
  }
  for (const [ip, r] of ffRateWindow.entries()) {
    if (r.resetAt <= now) {
      ffRateWindow.delete(ip);
    }
  }
}
setInterval(cleanupFrameFlowRateLimits, 10 * 60e3).unref();

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
  const publicUpdates = buildPublicUpdates(prev, data, nowLocal());
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
  let rows = [];
  try {
    rows = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (q) {
      rows = rows.filter((inc) =>
        `${inc.area || ''} ${inc.faultType || ''} ${inc.services || ''} ${inc.closedBy || ''} ${inc.startDate || ''} ${inc.endedAt || ''} ${inc.resolution || ''}`
          .toLowerCase()
          .includes(q)
      );
    }
    rows = rows.slice(0, limit);
  } catch {}
  res.json(rows);
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
