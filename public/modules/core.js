// Modul: Delat tillstånd, tidshjälpare, API-klient, tema och portalstatus

let PUBLIC_URL = '';

const $ = (id) => document.getElementById(id);
const FIELDS = ['domain', 'statusType', 'area', 'scope', 'faultType', 'startDate', 'startTime', 'ettrDate', 'ettr', 'techDetails', 'note'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let incidents = [];
let recentlyResolved = [];
let alerts = [];
let appSettings = { frameflow: {}, notifications: {}, nodes: [] };
let currentUser = '';
let currentUserRole = 'admin';
let myTotpEnabled = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UI_VERSION = '2026.11.05.2';
let editUpdatedAt = null;
let editingPublicUpdates = [];
let timelineModified = false;
let overdueFirstId = null;
let reopeningId = null;
let editingNis2Id = null;
let closing = null;
let currentReport = { id: '', content: '' };
const openHist = new Set();
let archive = [];

const nowLocal = () => { // "ÅÅÅÅ-MM-DD HH:MM" i svensk tid, oberoende av webbläsarens språkinställning
  const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const todayISO = () => nowLocal().slice(0, 10);
const nowHHMM = () => nowLocal().slice(11);

function normTime(raw) {
  raw = raw.trim();
  const d = raw.replace(':', '');
  if (/^\d{3,4}$/.test(d)) {
    const p = d.padStart(4, '0');
    return `${p.slice(0, 2)}:${p.slice(2)}`;
  }
  return raw;
}

const fmtTs = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' });
const FIELD_LABEL = { domain: 'Verksamhet', kind: 'Typ', statusType: 'Status', area: 'Område', scope: 'Omfattning', faultType: 'Typ av händelse', services: 'Tjänster', startDate: 'Startdatum', startTime: 'Starttid', ettrDate: 'Klartid, datum', ettr: 'Klartid', techDetails: 'Lägesrapport' };
const startOf = (inc) => `${inc.startDate || (inc.createdAt || '').slice(0, 10)} ${inc.startTime || ''}`.trim();
const endOf = (inc) => (inc.ettrDate && TIME_RE.test(inc.ettr || '') ? `${inc.ettrDate} ${inc.ettr}` : '');
const icon = (inc) => (inc.domain === 'fjarrvarme' ? '🔥' : '🌐');

// ---------- UI-hjälpare & API ----------
function toast(msg, ok = true) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `fixed bottom-6 right-6 z-[60] px-4 py-2.5 rounded-xl text-sm shadow-xl text-white ${ok ? 'bg-brand' : 'bg-red-600'}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function toggleModal() {
  const m = $('docModal');
  const open = m.classList.contains('hidden');
  m.classList.toggle('hidden', !open);
  m.classList.toggle('flex', open);
}

async function copyText(id) {
  const el = $(id);
  try {
    await navigator.clipboard.writeText(el.value);
  } catch {
    el.select();
    document.execCommand('copy');
  }
  toast('Kopierat till urklipp!');
}

async function api(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `Fel ${res.status}`);
  return data;
}

// ---------- Tema, utloggning, lathund & portalstatus ----------
const getTheme = () => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } };
function applyTheme(mode) {
  const r = document.documentElement;
  r.classList.remove('light', 'dark');
  if (mode === 'light' || mode === 'dark') r.classList.add(mode);
  try { mode === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', mode); } catch {}
  $('themeBtn').textContent = { auto: '🌓 Auto', light: '☀️ Ljust', dark: '🌙 Mörkt' }[mode];
}
const cycleTheme = () => applyTheme({ auto: 'light', light: 'dark', dark: 'auto' }[getTheme()]);

async function logout() {
  try { await api('/api/logout', {}); } catch {}
  location.href = '/login';
}

function showDoc(id) {
  document.querySelectorAll('[data-action="doc"]').forEach((b) => b.setAttribute('aria-selected', b.dataset.arg === id));
  $('doc-tech').classList.toggle('hidden', id !== 'tech');
  $('doc-admin').classList.toggle('hidden', id !== 'admin');
}

function renderPortalStatus(data) {
  const dot = $('portalDot');
  const txt = $('portalText');
  const box = $('portalStatus');
  if (!dot || !txt || !box || !data) return;
  if (data.healthy) {
    dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
    txt.className = 'text-emerald-600 dark:text-emerald-400 font-semibold';
    txt.textContent = 'Portal: Online';
    box.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 text-xs transition select-none cursor-help';
    box.title = `Driftportal: Online (healthy)\nSvarstid: ${data.latency} ms\nKontrollerad: ${data.lastChecked ? new Date(data.lastChecked).toLocaleTimeString('sv-SE') : 'nyss'}\nURL: ${data.url}`;
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-red-500 animate-pulse';
    txt.className = 'text-red-600 dark:text-amber-400 font-semibold';
    txt.textContent = 'Portal: Offline';
    box.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl border border-red-500/40 bg-red-500/10 text-xs transition select-none cursor-help';
    box.title = `Driftportal: Offline / Inte nåbar\nFel: ${data.error || 'Status ' + data.status}\nKontrollerad: ${data.lastChecked ? new Date(data.lastChecked).toLocaleTimeString('sv-SE') : 'nyss'}\nURL: ${data.url}`;
  }
}

async function updatePortalStatus() {
  const dot = $('portalDot');
  const txt = $('portalText');
  const box = $('portalStatus');
  if (!dot || !txt || !box) return;
  try {
    const res = await fetch('/api/portal-status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderPortalStatus(data);
  } catch (err) {
    dot.className = 'w-2 h-2 rounded-full bg-amber-500';
    txt.className = 'text-amber-600 dark:text-amber-400 font-semibold';
    txt.textContent = 'Portal: Okänd';
    box.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-xs transition select-none cursor-help';
    box.title = `Kunde inte hämta portalstatus: ${err.message}`;
  }
}

async function pollAdminState() {
  try {
    const res = await fetch('/api/poll');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.alerts)) {
      alerts = data.alerts;
      renderAlerts();
    }
    if (Array.isArray(data.recentlyResolved)) {
      recentlyResolved = data.recentlyResolved;
    }
    if (Array.isArray(data.incidents)) {
      incidents = data.incidents;
      renderIncidents();
    }
    if (data.portalStatus) {
      renderPortalStatus(data.portalStatus);
    }
    if ($('archiveBox')?.open) {
      fetchArchive();
    }
  } catch {
    fetchAlerts();
    fetchIncidents();
    updatePortalStatus();
  }
}
