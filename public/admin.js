// Adminsidans logik. Ligger i egen fil så att CSP kan förbjuda inline-skript.
// Hämtas från servern (miljövariabeln PUBLIC_URL) så att SMS-texterna får rätt publik adress
let PUBLIC_URL = '';

const $ = (id) => document.getElementById(id);
const FIELDS = ['domain', 'statusType', 'area', 'scope', 'faultType', 'startDate', 'startTime', 'ettrDate', 'ettr', 'techDetails', 'note'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Verksamheter: [värde, visningstext?, planerat arbete?]
const DOMAINS = {
  stadsnat: {
    faults: [['Fiberavgrävning'], ['Strömavbrott', 'Strömavbrott i nodhus'], ['Hårdvarufel', 'Hårdvarufel / Access-switch'], ['Stamkabelbrott', 'Skarvningsarbete / Stamkabel'], ['Planerat underhåll', 'Planerat underhåll', true]],
    services: [['Bredband'], ['TV'], ['Företagstjänster', 'Företag / IP-VPN']],
    defaults: ['Bredband', 'TV'], name: '', impact: 'Avbrott på',
  },
  fjarrvarme: {
    faults: [['Ledningsbrott', 'Ledningsbrott / läcka'], ['Värmeverk', 'Driftstörning i värmeverk'], ['Tryckfall', 'Pumpstation / tryckfall'], ['Planerat arbete', 'Planerat arbete / avstängning', true], ['Annat']],
    services: [['Värme'], ['Varmvatten']],
    defaults: ['Värme', 'Varmvatten'], name: ' fjärrvärme', impact: 'Påverkan på',
  },
};
const TABS = [
  ['sms', 'SMS-Utskick', 'SMS-Gateway format', 'Kopiera SMS', 'outSms'],
  ['web', 'Driftportal (Webb)', 'Fullständig text för publicering', 'Kopiera Webtext', 'outWeb'],
  ['social', 'Sociala Medier', 'Anpassad för Facebook / X', 'Kopiera Inlägg', 'outSocial'],
  ['internal', 'Intern Rapport', 'För NOC och driftlogg', 'Kopiera Rapport', 'outInternal'],
];
let incidents = [];
let recentlyResolved = [];
let alerts = [];
let appSettings = { frameflow: {}, notifications: {}, nodes: [] };
let currentUser = '';
let currentUserRole = 'admin';
let myTotpEnabled = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UI_VERSION = '2026.11.05.1';
let editUpdatedAt = null;
let editingPublicUpdates = [];
let timelineModified = false;
// Switch- och topologifunktioner (parseDeviceRole, summarizeDevices, computeSwitchImpact) laddas från /topology.js
let overdueFirstId = null;
let reopeningId = null;
let editingNis2Id = null;
const nowLocal = () => { // "ÅÅÅÅ-MM-DD HH:MM" i svensk tid, oberoende av webbläsarens språkinställning
  const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const todayISO = () => nowLocal().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nowHHMM = () => nowLocal().slice(11);

// ---------- UI-hjälpare ----------
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

function showTab(id) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === id));
  document.querySelectorAll('[data-panel]').forEach((p) => {
    const on = p.dataset.panel === id;
    p.classList.toggle('hidden', !on);
    p.classList.toggle('flex', on);
  });
}

function buildTabs() {
  $('tabBar').innerHTML = TABS.map(([id, label]) =>
    `<button role="tab" data-tab="${id}" class="tab" data-action="showTab" data-arg="${id}">${label}</button>`).join('');
  $('panels').innerHTML = TABS.map(([id, , hint, copyLabel, outId]) => `
    <div data-panel="${id}" class="flex-1 flex-col space-y-2">
      <div class="flex justify-between items-center text-xs text-faint">
        <span>${hint}</span>${id === 'sms' ? '<span id="smsCharCount" class="font-mono text-accent">0 / 160</span>' : ''}
      </div>
      <textarea id="${outId}" readonly class="out min-h-[140px]"></textarea>
      <button data-action="copy" data-arg="${outId}" class="btn self-end">${copyLabel}</button>
    </div>`).join('');
  showTab('sms');
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

// ---------- Tid ----------
function normTime(raw) {
  raw = raw.trim();
  const d = raw.replace(':', '');
  if (/^\d{3,4}$/.test(d)) {
    const p = d.padStart(4, '0');
    return `${p.slice(0, 2)}:${p.slice(2)}`;
  }
  return raw;
}

function validate() {
  const stOk = TIME_RE.test($('startTime').value);
  const sdOk = DATE_RE.test($('startDate').value);
  const etTime = /^[\d:]+$/.test($('ettr').value);
  let etOk = !etTime || TIME_RE.test($('ettr').value); // fritext (t.ex. "Ej fastställt") är OK
  let edOk = !$('ettrDate').value || DATE_RE.test($('ettrDate').value);
  let msg = '';
  if (edOk && $('ettrDate').value && !TIME_RE.test($('ettr').value)) { etOk = false; msg = 'Ange klartid som HH:MM när du anger datum för klartid.'; }
  if (stOk && sdOk && edOk && etOk && $('ettrDate').value && `${$('ettrDate').value} ${$('ettr').value}` < `${$('startDate').value} ${$('startTime').value}`) {
    edOk = false; msg = 'Klartiden kan inte vara före starttiden.';
  }
  $('startTime').setAttribute('aria-invalid', !stOk);
  $('startDate').setAttribute('aria-invalid', !sdOk);
  $('ettr').setAttribute('aria-invalid', !etOk);
  $('ettrDate').setAttribute('aria-invalid', !edOk);
  validate.msg = msg || 'Kontrollera datum (ÅÅÅÅ-MM-DD) och tider (HH:MM).';
  return stOk && sdOk && etOk && edOk;
}

['startTime', 'ettr'].forEach((id) => $(id).addEventListener('blur', () => {
  $(id).value = normTime($(id).value);
  validate();
  generate();
}));

// ---------- Formulär ----------
function applyDomain(key) {
  const dom = DOMAINS[key] || DOMAINS.stadsnat;
  $('domain').value = DOMAINS[key] ? key : 'stadsnat';
  $('faultType').innerHTML = dom.faults.map(([v, l]) => `<option value="${esc(v)}">${esc(l || v)}</option>`).join('');
  $('serviceBox').innerHTML = dom.services.map(([v, l]) => `<label class="chk"><input type="checkbox" value="${esc(v)}" class="service-check accent-brand"> ${esc(l || v)}</label>`).join('');
  setServices(dom.defaults);
}

function setFields(o) {
  applyDomain(o.domain);
  FIELDS.forEach((k) => { if (k !== 'domain' && o[k] !== undefined) $(k).value = o[k]; });
  if (o.services) setServices(o.services.split(', '));
}

function setServices(list) {
  document.querySelectorAll('.service-check').forEach((c) => (c.checked = list.includes(c.value)));
}

function getForm() {
  const f = {};
  FIELDS.forEach((k) => (f[k] = $(k).value.trim()));
  f.services = [...document.querySelectorAll('.service-check:checked')].map((c) => c.value).join(', ') || 'Samtliga tjänster';
  f.kind = (DOMAINS[f.domain] || DOMAINS.stadsnat).faults.find((x) => x[0] === f.faultType)?.[2] ? 'planned' : 'incident';
  return f;
}

function resetForm() {
  editUpdatedAt = null;
  editingPublicUpdates = [];
  timelineModified = false;
  $('editId').value = '';
  $('alertId').value = '';
  $('alertLinkBanner').classList.add('hidden');
  $('statusType').selectedIndex = 0;
  applyDomain($('domain').value);
  $('area').value = '';
  if ($('scope')) $('scope').value = '';
  $('startDate').value = todayISO();
  $('startTime').value = nowHHMM();
  $('ettrDate').value = '';
  $('ettr').value = '';
  $('note').value = '';
  $('techDetails').value = '';
  if ($('tlModeReplace')) $('tlModeReplace').checked = true;
  if ($('tlModeAppend')) $('tlModeAppend').checked = false;
  if ($('timelineStepText')) $('timelineStepText').value = '';
  if ($('tlStepTextWrap')) $('tlStepTextWrap').classList.add('hidden');
  if ($('editTimelineBox')) $('editTimelineBox').classList.add('hidden');
  if ($('publicTimelineHint')) $('publicTimelineHint').classList.add('hidden');
  $('formTitle').textContent = 'Ny händelse';
  try { localStorage.removeItem('draft'); } catch {}
  validate();
  generate();
}

function unlinkAlert() {
  $('alertId').value = '';
  $('alertLinkBanner').classList.add('hidden');
}

function findNodeMetaByName(nameOrDevice = '') {
  const hay = String(nameOrDevice || '').toLowerCase();
  if (!hay || !appSettings || !Array.isArray(appSettings.nodes)) return null;
  for (const n of appSettings.nodes) {
    const terms = [n.name, ...(Array.isArray(n.keywords) ? n.keywords : String(n.match || '').split(','))]
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean);
    if (terms.some((t) => hay.includes(t))) return n;
  }
  return null;
}

function useAlertGroupInForm(rawIds) {
  const idList = Array.isArray(rawIds)
    ? rawIds
    : String(rawIds || '').split(',').map((s) => s.trim()).filter(Boolean);
  const idSet = new Set(idList);
  const matched = alerts.filter((a) => idSet.has(a.id));
  if (!matched.length) return;

  const first = matched[0];
  const nodeMeta = findNodeMetaByName(`${first.area || ''} ${first.device || ''}`);
  const impact = computeSwitchImpact(matched, nodeMeta);
  const devSummary = summarizeDevices(matched.map((a) => a.device));

  editUpdatedAt = null;
  $('editId').value = '';
  $('alertId').value = matched.map((a) => a.id).join(',');
  $('alertLinkText').textContent = `📡 Kopplat till FrameFlow: ${devSummary}${impact.estimatedCustomers ? ` (~${impact.estimatedCustomers} berörda kunder)` : ''}`;
  $('alertLinkBanner').classList.remove('hidden');

  let sd = todayISO();
  let st = nowHHMM();
  const earliest = matched
    .map((a) => a.createdAt)
    .filter(Boolean)
    .sort()[0];
  if (earliest) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(earliest)).map((x) => [x.type, x.value]));
      sd = `${p.year}-${p.month}-${p.day}`;
      st = `${p.hour}:${p.minute}`;
    } catch {}
  }

  const noteText = matched.length > 1
    ? `Skapat från ${matched.length} FrameFlow-larm (${devSummary}${impact.summaryLabel ? ` – ${impact.summaryLabel}` : ''}).`
    : `Skapat från FrameFlow-larm (${first.device} / ${first.monitor}): ${first.message}`;

  setFields({
    domain: first.domain || 'stadsnat',
    statusType: 'Pågående Störning',
    area: impact.publicArea || first.area || first.device,
    scope: impact.scope || '',
    faultType: first.faultType || 'Hårdvarufel',
    services: first.services || 'Bredband, TV',
    startDate: sd,
    startTime: st,
    ettrDate: '',
    ettr: 'Ej fastställt',
    techDetails: impact.techDetails || 'Felsökning av utrustning i nod pågår.',
    note: noteText,
  });
  $('formTitle').textContent = `Nytt ärende från larm: ${impact.publicArea}`;
  validate();
  generate();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast(`Larm (${devSummary}) har fyllts i som "${impact.publicArea}". Granska och klicka Publicera!`);
}

function useAlertInForm(alertId) {
  useAlertGroupInForm([alertId]);
}

function syncTimelineModeUI() {
  const isAppend = Boolean($('tlModeAppend')?.checked);
  if ($('tlStepTextWrap')) {
    $('tlStepTextWrap').classList.toggle('hidden', !isAppend);
  }
}

function renderEditTimelineList() {
  const tlHint = $('publicTimelineHint');
  const tlList = $('publicTimelineList');
  const tlSum = $('publicTimelineSummary');
  if (!tlHint || !tlList || !tlSum) return;
  if (!editingPublicUpdates.length) {
    tlHint.classList.add('hidden');
    return;
  }
  const hasMultiple = editingPublicUpdates.length > 1;
  tlSum.textContent = hasMultiple
    ? `🕒 Publik tidslinje på portalen (${editingPublicUpdates.length} steg – visas publikt)`
    : '🕒 Publik tidslinje (endast 1 steg – ingen tidslinje visas på portalen)';
  const items = editingPublicUpdates
    .map((u, origIdx) => ({ u, origIdx }))
    .reverse()
    .map(({ u, origIdx }, revIdx) => `
      <li class="space-y-1 pb-1.5 border-b border-line/60 last:border-b-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span class="font-mono text-accent">${esc(u.ts)}</span>
            ${revIdx === 0 ? '<span class="ml-1 px-1 py-0.5 rounded bg-brand/20 text-accent text-[10px]">Senaste</span>' : ''}
            ${u.ettr ? ` <span class="text-faint">(Prognos: ${esc(u.ettr)})</span>` : ''}
          </div>
          ${hasMultiple ? `<button type="button" data-del-tl-idx="${origIdx}" class="text-[10px] text-danger hover:underline font-semibold" title="Ta bort detta steg ur tidslinjen">&times; Ta bort steg</button>` : ''}
        </div>
        <input type="text" data-edit-tl-idx="${origIdx}" value="${esc(u.text)}" class="field text-xs !py-1 !px-2 w-full" title="Redigera text för detta tidslinjesteg">
      </li>`);
  tlList.innerHTML = items.join('');
  tlHint.classList.remove('hidden');
}

function editIncident(inc) {
  if (!inc) return;
  editUpdatedAt = inc.updatedAt || inc.createdAt || null;
  $('editId').value = inc.id;
  $('alertId').value = Array.isArray(inc.alertIds) && inc.alertIds.length ? inc.alertIds.join(',') : (inc.alertId || '');
  if (inc.nmsDevice) {
    $('alertLinkText').textContent = `📡 Kopplat till FrameFlow-enhet: ${inc.nmsDevice}`;
    $('alertLinkBanner').classList.remove('hidden');
  } else {
    $('alertLinkBanner').classList.add('hidden');
  }
  setFields({ ...inc, domain: inc.domain || 'stadsnat', scope: inc.scope || '', startDate: inc.startDate || (inc.createdAt || '').slice(0, 10) || todayISO(), ettrDate: inc.ettrDate || '', note: '' });
  editingPublicUpdates = Array.isArray(inc.publicUpdates) && inc.publicUpdates.length
    ? inc.publicUpdates.map((u) => ({ ...u }))
    : [{
      ts: startOf(inc),
      status: inc.statusType || 'Pågående Störning',
      ettr: endOf(inc) || inc.ettr || '',
      text: inc.techDetails || '',
    }];
  timelineModified = false;
  if ($('tlModeReplace')) $('tlModeReplace').checked = true;
  if ($('tlModeAppend')) $('tlModeAppend').checked = false;
  if ($('timelineStepText')) $('timelineStepText').value = '';
  syncTimelineModeUI();
  if ($('editTimelineBox')) $('editTimelineBox').classList.remove('hidden');
  renderEditTimelineList();
  $('formTitle').textContent = `Redigerar: ${inc.area}`;
  validate();
  generate();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Utkast sparas i webbläsaren (bara för nya ärenden)
function saveDraft() {
  if ($('editId').value) return;
  try { localStorage.setItem('draft', JSON.stringify({ ...getForm(), _t: Date.now() })); } catch {}
}

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem('draft') || 'null');
    if (!d || Date.now() - (d._t || 0) > 2 * 3600e3) return false; // utkast äldre än 2 h kastas
    setFields(d);
    return true;
  } catch { return false; }
}

// ---------- Mallar ----------
function templates(f) {
  const dom = DOMAINS[f.domain] || DOMAINS.stadsnat;
  const area = f.area || 'Angivet område';
  const fmt = (d, t) => (d && d !== todayISO() ? `${d.slice(8)}/${d.slice(5, 7)} ${t}` : t);
  const ettr = f.ettrDate && TIME_RE.test(f.ettr) ? fmt(f.ettrDate, f.ettr) : (f.ettr || 'Ej fastställt');
  const start = fmt(f.startDate, f.startTime || '00:00');
  const fullStart = `${f.startDate || todayISO()} ${f.startTime || '00:00'}`;
  const url = PUBLIC_URL || `${location.origin}/drift/`;
  const planned = !!(dom.faults.find((x) => x[0] === f.faultType) || [])[2];
  const update = f.statusType.startsWith('Uppdaterad');
  const done = f.statusType.startsWith('Åtgärdat');
  const fault = f.faultType.toLowerCase();
  const n = dom.name; // '' eller ' fjärrvärme'
  const label = (done ? 'ÅTGÄRDAT' : planned ? 'PLANERAT ARBETE' : update ? 'UPPDATERING' : 'STÖRNING') + n.toUpperCase();
  const now = nowHHMM();

  const sms = done
    ? `ÅTGÄRDAT${n} i ${area}: ${f.services} fungerar igen. Tack för ert tålamod. Info: ${url}`
    : planned
    ? `PLANERAT ARBETE${n} i ${area}: ${f.services} kan vara påverkade ${start} till ${ettr}. Info: ${url}`
    : update
    ? `UPPDATERING${n} ${area}: Fortsatt störning på ${f.services}. Ny beräknad klartid: ${ettr}. Info: ${url}`
    : `STÖRNING${n} i ${area}: ${dom.impact} ${f.services} p.g.a. ${fault}. Beräknad klartid: ${ettr}. Info: ${url}`;

  const closing = done ? 'Felet är åtgärdat och tjänsterna fungerar igen.' : planned ? 'Arbetet utförs enligt plan.' : update ? 'Vi arbetar vidare med felet och återkommer vid ny information.' : 'Felsökning pågår aktivt.';
  const times = done ? `Åtgärdat: ${now}` : planned ? `Planerad start: ${start}\nPlanerat slut: ${ettr}` : `Starttid: ${start}\nBeräknad klartid: ${ettr}`;
  const web = `${label} - ${area.toUpperCase()}\n\nTyp: ${f.faultType}\nTjänster: ${f.services}\n${times}\n${f.techDetails ? `\nLägesrapport: ${f.techDetails}\n` : ''}\n${closing}`;

  const social = done
    ? `✅ Åtgärdat${n}: ${f.services} i ${area} fungerar igen. Tack för ert tålamod. Läs mer: ${url}`
    : planned
    ? `🔧 Planerat arbete${n} i ${area}. ${f.services} kan vara påverkade ${start} till ${ettr}. Mer info: ${url}`
    : update
    ? `ℹ️ Uppdatering om driftstörningen${n} i ${area}. Påverkade tjänster: ${f.services}. Ny beräknad klartid: ${ettr}. Läs mer: ${url}`
    : `⚠️ Pågående driftstörning${n} i ${area}. Tjänster som påverkas: ${f.services}. Tekniker arbetar på felet. Läs mer på driftportalen: ${url}`;

  const internal = `INCIDENTRAPPORT (${f.statusType}) - ${dom.name ? 'Fjärrvärme' : 'Stadsnät'}\nOmråde: ${area}\nTyp: ${f.faultType}\nTjänster: ${f.services}\n${done ? `Åtgärdat: ${now} (start ${fullStart})` : `Start: ${fullStart}\nETTR: ${ettr}`}\nDetaljer: ${f.techDetails || 'Inga angivna'}`;
  return { sms, web, social, internal };
}

function syncLabels(kind) {
  const p = kind === 'planned';
  const set = (id, t) => { document.querySelector(`label[for="${id}"]`).textContent = t; };
  set('startDate', p ? 'Planerad startdag' : 'Startdatum');
  set('startTime', p ? 'Planerad starttid (t.ex. 0800)' : 'Starttid (t.ex. 0800)');
  set('ettrDate', p ? 'Planerat slutdatum' : 'Klartid, datum (valfritt)');
  set('ettr', p ? 'Planerad sluttid (t.ex. 1600)' : 'Beräknad klartid (t.ex. 1600)');
}

function generate() {
  const f = getForm();
  syncLabels(f.kind);
  const o = templates(f);
  $('outSms').value = o.sms;
  $('outWeb').value = o.web;
  $('outSocial').value = o.social;
  $('outInternal').value = o.internal;
  const c = $('smsCharCount');
  c.textContent = `${o.sms.length} / 160`;
  c.classList.toggle('text-danger', o.sms.length > 160);
  c.classList.toggle('text-accent', o.sms.length <= 160);
  saveDraft();
}

// ---------- API ----------
async function api(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `Fel ${res.status}`);
  return data;
}

const fmtTs = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' });
const FIELD_LABEL = { domain: 'Verksamhet', kind: 'Typ', statusType: 'Status', area: 'Område', scope: 'Omfattning', faultType: 'Typ av händelse', services: 'Tjänster', startDate: 'Startdatum', startTime: 'Starttid', ettrDate: 'Klartid, datum', ettr: 'Klartid', techDetails: 'Lägesrapport' };
const openHist = new Set();
let archive = [];
const startOf = (inc) => `${inc.startDate || (inc.createdAt || '').slice(0, 10)} ${inc.startTime || ''}`.trim();
const endOf = (inc) => (inc.ettrDate && TIME_RE.test(inc.ettr || '') ? `${inc.ettrDate} ${inc.ettr}` : '');
const icon = (inc) => (inc.domain === 'fjarrvarme' ? '🔥' : '🌐');

function timeline(inc) {
  const rows = (inc.history || []).map((h) => {
    const what = h.action === 'create'
      ? 'Ärende skapat'
      : h.action === 'close'
        ? `Stängt (faktisk sluttid ${h.endedAt || inc.endedAt || '?'})`
        : h.action === 'reopen'
          ? 'Återöppnat'
          : h.action === 'nms_ok'
            ? '✅ Återställd i FrameFlow'
            : 'Uppdaterat';
    const ch = h.changes ? Object.entries(h.changes).filter(([k]) => FIELD_LABEL[k]).map(([k, [a, b]]) => `${FIELD_LABEL[k]}: ${a || '–'} → ${b || '–'}`).join('; ') : '';
    return `<li class="pb-2"><span class="font-mono text-faint">${esc(fmtTs(h.ts))}</span> <strong class="text-fg">${esc(h.by || '?')}</strong> · ${esc(what)}${h.note ? `<div class="text-fg2">&ldquo;${esc(h.note)}&rdquo;</div>` : ''}${ch ? `<div class="text-faint break-words">${esc(ch)}</div>` : ''}</li>`;
  });
  return rows.length
    ? `<ul class="mt-2 pl-3 border-l-2 border-line text-[11px] leading-snug">${rows.join('')}</ul>`
    : '<p class="mt-2 text-[11px] text-faint">Ingen historik sparad för detta ärende.</p>';
}

async function fetchIncidents() {
  const box = $('activeIncidentsList');
  try {
    const res = await fetch('/api/poll');
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (Array.isArray(data.incidents)) incidents = data.incidents;
    if (Array.isArray(data.recentlyResolved)) recentlyResolved = data.recentlyResolved;
  } catch (e) {
    try {
      const res2 = await fetch('/api/incidents');
      if (!res2.ok) throw new Error(res2.status);
      incidents = await res2.json();
    } catch {
      if (box) box.innerHTML = '<p class="text-xs text-danger">Kunde inte hämta ärenden.</p>';
      return;
    }
  }
  renderIncidents();
}

function renderIncidents() {
  const box = $('activeIncidentsList');
  if (!box) return;
  const now = nowLocal();
  const overdue = incidents.filter((i) => i.kind === 'planned' && endOf(i) && now > endOf(i));
  const alertBox = $('overduePlannedAlert');
  if (alertBox) {
    if (overdue.length > 0) {
      alertBox.classList.remove('hidden');
      $('overduePlannedText').textContent = overdue.length === 1
        ? `Planerat arbete (${overdue[0].area}) har passerat sin sluttid och döljs publikt.`
        : `${overdue.length} planerade arbeten har passerat sin sluttid och döljs publikt.`;
      overdueFirstId = overdue[0].id;
    } else {
      alertBox.classList.add('hidden');
      overdueFirstId = null;
    }
  }
  if (!incidents.length && !recentlyResolved.length) {
    box.innerHTML = '<p class="text-xs text-faint italic">Inga aktiva eller nyligen avslutade ärenden på driftportalen just nu.</p>';
    return;
  }

  const row = (inc) => {
    const planned = inc.kind === 'planned';
    const over = planned && endOf(inc) && now > endOf(inc);
    const activeNow = planned && !over && now >= startOf(inc);
    const nmsOk = Boolean(inc.nmsResolvedAt);
    const totalNmsDevs = Array.isArray(inc.nmsDevices) ? inc.nmsDevices.length : 0;
    const resolvedNmsDevs = Array.isArray(inc.nmsResolvedDevices) ? inc.nmsResolvedDevices.length : 0;
    const partialNms = !nmsOk && totalNmsDevs > 1 && resolvedNmsDevs > 0;
    const warnBadge = over
      ? '<span class="inline-block bg-amber-500/20 text-amber-600 dark:text-amber-400 font-semibold px-2 py-0.5 rounded text-[10px] animate-pulse">⚠️ Sluttid passerad</span>'
      : activeNow
        ? '<span class="inline-block bg-brand/20 text-accent font-semibold px-2 py-0.5 rounded text-[10px]">🔧 Pågår nu</span>'
        : planned
          ? '<span class="inline-block bg-card border border-line text-muted font-semibold px-2 py-0.5 rounded text-[10px]">📅 Kommande</span>'
          : '';
    const nmsBadge = nmsOk
      ? `<span class="inline-block bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-semibold px-2 py-0.5 rounded text-[10px]" title="FrameFlow rapporterade OK kl ${esc(fmtTs(inc.nmsResolvedAt))}">✅ ${totalNmsDevs > 1 ? `Alla ${totalNmsDevs} enheter återställda i FrameFlow` : 'Återställd i FrameFlow'}</span>`
      : partialNms
        ? `<span class="inline-block bg-amber-500/20 text-amber-600 dark:text-amber-400 font-semibold px-2 py-0.5 rounded text-[10px]">⏳ ${resolvedNmsDevs} av ${totalNmsDevs} switchar åter online</span>`
        : inc.nmsDevice
          ? `<span class="inline-block bg-brand/15 text-accent font-mono px-1.5 py-0.5 rounded text-[10px]" title="Kopplad till FrameFlow-enhet">📡 ${esc(inc.nmsDevice)}</span>`
          : '';
    const warn = over ? '<div class="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Planerat slut har passerats och arbetet döljs för allmänheten (auto-arkiveras efter 60 min).</div>' : '';
    const nmsInfo = nmsOk
      ? `<div class="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">Enhet(${esc(inc.nmsDevice || inc.area)}) är åter online enligt FrameFlow (${esc(fmtTs(inc.nmsResolvedAt))}). Redo att klarrapporteras och stängas.</div>`
      : partialNms
        ? `<div class="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Delvis återställt i FrameFlow: ${resolvedNmsDevs} av ${totalNmsDevs} länkade switchar (${esc(inc.nmsDevice)}) svarar igen.</div>`
        : '';
    const rowClass = over
      ? 'border-amber-500/50 bg-amber-500/5'
      : nmsOk
        ? 'border-emerald-500/50 bg-emerald-500/5'
        : 'bg-inset border-line';
    return `
    <div class="${rowClass} border p-3 rounded-xl text-xs transition">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-bold text-fg">${icon(inc)} ${esc(inc.area)}</span> &mdash; <span class="text-muted">${esc(inc.faultType)}</span>
            ${warnBadge}
            ${nmsBadge}
          </div>
          <div class="text-[10px] text-faint truncate">${esc(inc.statusType)} | Start: ${esc(startOf(inc))} | Klart: ${esc(endOf(inc) || inc.ettr)} | ${esc(inc.services)}</div>
          ${warn}
          ${nmsInfo}
        </div>
        <div class="flex flex-wrap justify-end gap-2 shrink-0">
          <button data-hist="${esc(inc.id)}" class="btn">Historik</button>
          <button data-edit="${esc(inc.id)}" class="btn">Redigera</button>
          <button data-close="${esc(inc.id)}" class="${over ? 'bg-amber-600 hover:bg-amber-700 text-white font-semibold px-3 py-1.5 rounded-lg text-xs' : nmsOk ? 'bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-3 py-1.5 rounded-lg text-xs' : 'btn-danger'}">Stäng ärende</button>
          <button data-del-inc="${esc(inc.id)}" class="btn text-danger" title="Radera ärendet direkt utan att det hamnar i arkivet eller under nyligen åtgärdade">Ta bort</button>
        </div>
      </div>
      <div id="h-${esc(inc.id)}" class="${openHist.has(inc.id) ? '' : 'hidden'}">${timeline(inc)}</div>
    </div>`;
  };

  const resolvedRow = (inc) => `
    <div class="bg-inset border border-emerald-500/30 p-3 rounded-xl text-xs transition">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-bold text-fg">${icon(inc)} ${esc(inc.area)}</span> &mdash; <span class="text-muted">${esc(inc.faultType)}</span>
            <span class="inline-block bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-semibold px-2 py-0.5 rounded text-[10px]">✅ Visas under Nyligen åtgärdade (24h)</span>
          </div>
          <div class="text-[10px] text-faint truncate">${esc(startOf(inc))} &rarr; ${esc(inc.endedAt || '?')} | ${esc(inc.services)}</div>
        </div>
        <div class="flex flex-wrap justify-end gap-2 shrink-0">
          <button data-rep="${esc(inc.id)}" class="btn">📄 Rapport</button>
          <button data-reopen="${esc(inc.id)}" class="btn text-amber-600 dark:text-amber-400">↺ Återöppna</button>
          <button data-del-arc="${esc(inc.id)}" class="btn text-danger" title="Ta bort detta avslutade ärende från driftportalen (24h) och arkivet">Ta bort</button>
        </div>
      </div>
    </div>`;

  const part = (title, list, fn = row) => (list.length ? `<h3 class="text-[10px] uppercase tracking-wider font-semibold text-faint pt-1">${title} (${list.length})</h3>${list.map(fn).join('')}` : '');
  box.innerHTML =
    part('Pågående störningar', incidents.filter((i) => i.kind !== 'planned'))
    + part('Planerade arbeten', incidents.filter((i) => i.kind === 'planned'))
    + part('Nyligen åtgärdade – visas på portalen i 24h', recentlyResolved, resolvedRow);
}

// ---------- FrameFlow Larminkorg ----------
async function fetchAlerts() {
  try {
    const res = await fetch('/api/alerts');
    if (!res.ok) throw new Error(res.status);
    alerts = await res.json();
  } catch {
    return;
  }
  renderAlerts();
}

function renderAlerts() {
  const box = $('alertsList');
  const badge = $('alertsBadge');
  const dismissAllBtn = $('dismissAllAlertsBtn');
  if (!box) return;
  const activeAlerts = alerts.filter((a) => !a.dismissed && !a.linkedIncidentId);
  if (badge) {
    badge.textContent = String(activeAlerts.length);
    badge.classList.toggle('hidden', activeAlerts.length === 0);
  }
  if (dismissAllBtn) {
    dismissAllBtn.classList.toggle('hidden', activeAlerts.length === 0);
  }
  if (!activeAlerts.length) {
    box.innerHTML = '<p class="text-xs text-faint italic">Inga nya hårdvarularm från FrameFlow.</p>';
    return;
  }

  const renderSingleAlert = (a, compact = false) => {
    const isResolved = Boolean(a.resolvedAt) || /^(ok|up)$/i.test(a.status || '');
    const isWarn = /warn/i.test(a.status || '');
    const sevBadge = isResolved
      ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">ÅTERSTÄLLD (OK)</span>'
      : !isWarn
        ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-danger">KRITISKT LARM</span>'
        : '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-600 dark:text-amber-400">VARNING</span>';
    const nodeMeta = findNodeMetaByName(`${a.area || ''} ${a.device || ''}`);
    const impact = computeSwitchImpact([a], nodeMeta);
    const roleTag = impact.summaryLabel
      ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-soft text-fg2">${esc(impact.summaryLabel)}${impact.estimatedCustomers ? ` · ~${esc(impact.estimatedCustomers)} kunder` : ''}</span>`
      : (a.customers ? `<span class="text-[10px] text-faint">~${esc(a.customers)} kunder i noden</span>` : '');
    return `
    <div class="bg-inset border ${isResolved ? 'border-emerald-500/40' : 'border-red-500/40'} ${compact ? 'p-2' : 'p-3'} rounded-xl text-xs flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          ${sevBadge}
          <span class="font-bold text-fg">${esc(a.area)}</span>
          <span class="font-mono text-[11px] text-accent">(${esc(a.device)}${a.monitor ? ' · ' + esc(a.monitor) : ''})</span>
          ${roleTag}
        </div>
        <div class="text-[11px] text-fg2 mt-0.5">${esc(a.faultType)}${a.message ? ` — <span class="text-muted">${esc(a.message)}</span>` : ''}</div>
        <div class="text-[10px] text-faint mt-0.5">Inkom: ${esc(fmtTs(a.createdAt || a.updatedAt))} · Förslag på publik rubrik: <strong>${esc(impact.publicArea)}</strong></div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button data-use-alert="${esc(a.id)}" class="bg-brand hover:bg-brand-dark text-white font-semibold px-3 py-1.5 rounded-lg text-xs transition">Använd i formulär</button>
        <button data-dismiss-alert="${esc(a.id)}" class="btn text-faint hover:text-danger" title="Avfärda larm">Avfärda</button>
      </div>
    </div>`;
  };

  // Gruppera pågående larm per nod/område om det finns >= 2 switchlarm i samma nod
  const byArea = new Map();
  for (const a of activeAlerts) {
    const key = String(a.area || 'Okänt').toLowerCase();
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(a);
  }

  const htmlBlocks = [];
  for (const [, group] of byArea) {
    const unresolved = group.filter((a) => !a.resolvedAt && !/^(ok|up)$/i.test(a.status || ''));
    if (unresolved.length >= 2) {
      const first = unresolved[0];
      const nodeMeta = findNodeMetaByName(`${first.area || ''} ${first.device || ''}`);
      const impact = computeSwitchImpact(unresolved, nodeMeta);
      const devSummary = summarizeDevices(unresolved.map((a) => a.device));
      const idsCsv = unresolved.map((a) => a.id).join(',');
      htmlBlocks.push(`
      <div class="bg-inset border-2 border-amber-500/60 p-3.5 rounded-xl text-xs space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-600 dark:text-amber-400">⚡ KLUSTERLARM (${unresolved.length} ENHETER)</span>
              <span class="font-bold text-fg text-sm">${esc(first.area)}</span>
              <span class="font-mono text-[11px] text-accent">${esc(devSummary)}</span>
            </div>
            <div class="text-[11px] text-fg2 mt-1">
              Omfattning: <strong>${esc(impact.summaryLabel || `${unresolved.length} enheter`)}</strong>
              &middot; Publik rubrik: <strong class="text-accent">${esc(impact.publicArea)}</strong>
              ${impact.estimatedCustomers ? ` &middot; Beräknad kundpåverkan: <strong>~${esc(impact.estimatedCustomers)} av ${esc(impact.totalCustomers)} kunder</strong>` : ''}
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <button data-use-alert-group="${esc(idsCsv)}" class="bg-brand hover:bg-brand-dark text-white font-semibold px-3 py-1.5 rounded-lg text-xs transition shadow">Använd alla (${unresolved.length} st) i formulär</button>
            <button data-dismiss-alert-group="${esc(idsCsv)}" class="btn text-faint hover:text-danger">Avfärda grupp</button>
          </div>
        </div>
        <details class="text-[11px]">
          <summary class="cursor-pointer select-none text-faint hover:text-fg2 font-medium">Visa enskilda enheter i klustret (${group.length} st)</summary>
          <div class="space-y-1.5 pt-2">${group.map((a) => renderSingleAlert(a, true)).join('')}</div>
        </details>
      </div>`);
    } else {
      for (const a of group) htmlBlocks.push(renderSingleAlert(a, false));
    }
  }

  box.innerHTML = htmlBlocks.join('');
}

async function dismissAlert(id) {
  try {
    await api('/api/alerts/dismiss', { id });
    if ($('alertId').value.split(',').includes(id) || id === 'all') unlinkAlert();
    await fetchAlerts();
    toast(id === 'all' ? 'Alla larm i inkorgen rensades.' : 'Larmet avfärdades.');
  } catch (e) {
    toast(`Kunde inte avfärda larm: ${e.message}`, false);
  }
}

async function dismissAlertGroup(idsCsv) {
  const ids = String(idsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return;
  try {
    await api('/api/alerts/dismiss', { ids });
    const currentLinked = new Set($('alertId').value.split(',').filter(Boolean));
    if (ids.some((id) => currentLinked.has(id))) unlinkAlert();
    await fetchAlerts();
    toast(`${ids.length} larm i gruppen avfärdades.`);
  } catch (e) {
    toast(`Kunde inte avfärda larmgrupp: ${e.message}`, false);
  }
}

async function simulateAlert(type) {
  try {
    await api('/api/frameflow/simulate', { type });
    await fetchAlerts();
    await fetchIncidents();
    if (type === 'ok') {
      toast('Simulerade återställning (OK) från FrameFlow!');
    } else if (type === 'multi_acc') {
      toast('Simulerade 10 access-switchar (arbra_acc_03–12) i larminkorgen!');
    } else if (type === 'dist') {
      toast('Simulerade dist-switch (arbra_dist_01) i larminkorgen!');
    } else {
      toast(`Testlarm skapat i larminkorgen (${type === 'ups' ? 'Bollnäs C – UPS' : 'arbra_acc_04 – Access-switch'})!`);
    }
  } catch (e) {
    toast(`Kunde inte simulera larm: ${e.message}`, false);
  }
}

function renderArchiveList() {
  const box = $('archiveList');
  if (!box) return;
  const recentIds = new Set(recentlyResolved.map((r) => r.id));
  const q = ($('archiveSearch')?.value || '').trim().toLowerCase();
  const filtered = q
    ? archive.filter((inc) =>
      (inc.area || '').toLowerCase().includes(q)
      || (inc.faultType || '').toLowerCase().includes(q)
      || (inc.services || '').toLowerCase().includes(q)
      || (inc.techDetails || '').toLowerCase().includes(q)
      || (inc.closedBy || '').toLowerCase().includes(q)
      || (inc.startDate || '').includes(q)
      || (inc.endedAt || '').includes(q))
    : archive;
  $('archiveCount').textContent = q ? `– visar ${filtered.length} av ${archive.length} st` : `– ${archive.length} st`;
  box.innerHTML = filtered.length ? filtered.map((inc) => {
    const isSig = inc.nis2?.significant === 'yes';
    const isRecent24h = recentIds.has(inc.id);
    const authRef = inc.nis2?.authorityRef ? ` | Diarienr: ${esc(inc.nis2.authorityRef)}` : '';
    return `
    <div class="bg-inset border border-line p-3 rounded-xl text-xs">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <span class="font-bold text-fg">${icon(inc)} ${esc(inc.area)}</span> &mdash; <span class="text-muted">${esc(inc.faultType)}</span>
          ${isRecent24h ? '<span class="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">🟢 Visas på portalen (24h)</span>' : ''}
          ${isSig ? '<span class="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/15 text-red-500 border border-red-500/30">⚠️ Betydande NIS2</span>' : ''}
          <div class="text-[10px] text-faint">${esc(startOf(inc))} &rarr; ${esc(inc.endedAt || '?')}${inc.closedBy ? ` | stängt av ${esc(inc.closedBy)}` : ''}${authRef}</div>
        </div>
        <div class="flex flex-wrap gap-1.5 shrink-0 justify-end">
          <button data-nis2="${esc(inc.id)}" class="btn text-accent" title="Komplettera NIS2-data, rotårsak och diarienummer i efterhand">🛡️ NIS2</button>
          <button data-rep="${esc(inc.id)}" class="btn">📄 Rapport</button>
          <button data-reopen="${esc(inc.id)}" class="btn text-amber-600 dark:text-amber-400">↺ Återöppna</button>
          <button data-hist="a-${esc(inc.id)}" class="btn">Historik</button>
          <button data-del-arc="${esc(inc.id)}" class="btn text-danger" title="Ta bort detta avslutade ärende permanent ur arkivet och från portalen">Ta bort</button>
        </div>
      </div>
      <div id="h-a-${esc(inc.id)}" class="${openHist.has('a-' + inc.id) ? '' : 'hidden'}">${timeline(inc)}</div>
    </div>`;
  }).join('') : `<p class="text-xs text-faint italic">${q ? 'Inga stängda ärenden matchade din sökning.' : 'Arkivet är tomt.'}</p>`;
}

async function deleteActiveIncident(id) {
  const inc = incidents.find((i) => i.id === id);
  const label = inc ? `${inc.area} – ${inc.faultType}` : id;
  if (!confirm(`Vill du ta bort det pågående ärendet "${label}" permanent?\n\nÄrendet raderas direkt från driftportalen utan att arkiveras eller visas under nyligen åtgärdade.`)) {
    return;
  }
  try {
    await api('/api/incidents/delete', { id });
    if ($('editId').value === id) resetForm();
    toast('Det pågående ärendet har tagits bort.');
    await fetchIncidents();
    await fetchAlerts();
  } catch (e) {
    toast(`Kunde inte ta bort ärende: ${e.message}`, false);
  }
}

async function deleteArchivedIncident(id) {
  const inc = archive.find((i) => i.id === id) || recentlyResolved.find((i) => i.id === id);
  const label = inc ? `${inc.area} – ${inc.faultType}` : id;
  if (!confirm(`Vill du ta bort det avslutade ärendet "${label}" permanent?\n\nÄrendet tas bort ur arkivet, försvinner direkt från "Nyligen åtgärdade händelser (senaste 24 timmarna)" på driftportalen och tillhörande rapportfil raderas.`)) {
    return;
  }
  try {
    await api('/api/archive/delete', { id });
    toast('Det avslutade ärendet har tagits bort från arkivet och driftportalen.');
    await fetchIncidents();
    if ($('archiveBox')?.open) await fetchArchive();
  } catch (e) {
    toast(`Kunde inte ta bort arkiverat ärende: ${e.message}`, false);
  }
}

async function fetchArchive() {
  const box = $('archiveList');
  try {
    const res = await fetch('/api/archive?limit=200');
    if (!res.ok) throw new Error(res.status);
    archive = await res.json();
  } catch (e) {
    box.innerHTML = '<p class="text-xs text-danger">Kunde inte hämta arkivet.</p>';
    return;
  }
  renderArchiveList();
}

$('activeIncidentsList').addEventListener('click', (e) => {
  const ed = e.target.closest('[data-edit]');
  const cl = e.target.closest('[data-close]');
  const dlInc = e.target.closest('[data-del-inc]');
  const dlArc = e.target.closest('[data-del-arc]');
  if (ed) editIncident(incidents.find((i) => i.id === ed.dataset.edit));
  if (cl) closeIncident(cl.dataset.close);
  if (dlInc) deleteActiveIncident(dlInc.dataset.delInc);
  if (dlArc) deleteArchivedIncident(dlArc.dataset.delArc);
});

$('alertsList').addEventListener('click', (e) => {
  const useGroupBtn = e.target.closest('[data-use-alert-group]');
  const disGroupBtn = e.target.closest('[data-dismiss-alert-group]');
  const useBtn = e.target.closest('[data-use-alert]');
  const disBtn = e.target.closest('[data-dismiss-alert]');
  if (useGroupBtn) useAlertGroupInForm(useGroupBtn.dataset.useAlertGroup);
  else if (disGroupBtn) dismissAlertGroup(disGroupBtn.dataset.dismissAlertGroup);
  else if (useBtn) useAlertInForm(useBtn.dataset.useAlert);
  else if (disBtn) dismissAlert(disBtn.dataset.dismissAlert);
});

async function publish() {
  if ($('statusType').value.startsWith('Åtgärdat')) return toast("Kopiera klarrapporten och klicka sedan 'Stäng ärende' i listan.", false);
  $('startTime').value = normTime($('startTime').value);
  $('ettr').value = normTime($('ettr').value);
  if (!validate()) return toast(validate.msg, false);
  const f = getForm();
  if (!f.area) { $('area').focus(); return toast('Ange område / nod.', false); }

  const btn = $('publishBtn');
  btn.disabled = true;
  try {
    const rawAlertId = $('alertId').value || '';
    const alertIds = rawAlertId.split(',').map((s) => s.trim()).filter(Boolean);
    const isEditing = Boolean($('editId').value);
    const timelineMode = isEditing && $('tlModeAppend')?.checked ? 'append' : (isEditing ? 'replace' : 'append');
    const timelineStepText = isEditing && timelineMode === 'append' ? ($('timelineStepText')?.value || '').trim() : '';
    const payload = {
      ...f,
      id: $('editId').value || null,
      alertId: alertIds[0] || '',
      alertIds,
      ...(isEditing && { timelineMode }),
      ...(timelineStepText && { timelineStepText }),
      ...(isEditing && timelineModified && { customPublicUpdates: editingPublicUpdates }),
    };
    if (editUpdatedAt) payload.expectedUpdatedAt = editUpdatedAt;
    const res = await api('/api/publish', payload);
    editUpdatedAt = res.updatedAt || null;
    toast('Ärendet har publicerats på driftportalen!');
    resetForm();
    fetchIncidents();
    fetchAlerts();
  } catch (e) {
    toast(`Kunde inte publicera: ${e.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

let closing = null;
function findNodeMetaForIncident(inc) {
  const nodes = (appSettings && Array.isArray(appSettings.nodes)) ? appSettings.nodes : [];
  const areaLow = (inc.area || '').toLowerCase();
  return nodes.find((n) => (n.name || '').toLowerCase() === areaLow)
    || nodes.find((n) => areaLow.includes((n.name || '').toLowerCase()))
    || null;
}

function guessRootCause(inc) {
  const ft = (inc.faultType || '').toLowerCase();
  if (inc.kind === 'planned') return '';
  if (ft.includes('gräv') || ft.includes('avgrävd')) return 'thirdparty';
  if (ft.includes('ström') || ft.includes('ups') || ft.includes('batteri')) return 'power';
  if (ft.includes('routing') || ft.includes('dhcp') || ft.includes('dns')) return 'human';
  return 'tech';
}

function closeIncident(id) {
  const inc = incidents.find((i) => i.id === id);
  if (!inc) return;
  closing = id;
  const [d, t] = nowLocal().split(' ');
  $('closeTitle').textContent = `${inc.area} – ${inc.faultType}`;
  $('endDate').value = d;
  $('endTime').value = t;
  $('closeNote').value = '';
  $('closeErr').textContent = '';

  // Förifyll NIS2-fälten från nodregistret och ärendet
  const nodeMeta = findNodeMetaForIncident(inc);
  const cust = inc.customers != null && inc.customers !== '' ? inc.customers : (nodeMeta ? nodeMeta.customers : '');
  $('nis2Customers').value = cust !== '' && cust != null ? cust : '';
  const totalPop = 8000; // ungefärligt totalt kundunderlag för snabb procentberäkning
  $('nis2Percent').value = cust ? String(Math.min(100, Math.max(1, Math.round((Number(cust) / totalPop) * 100)))) : '';
  $('nis2RootCause').value = guessRootCause(inc);
  $('nis2Significant').value = 'no';
  $('nis2Preventive').value = '';

  const critStr = inc.critical || (nodeMeta ? nodeMeta.critical : '') || '';
  const crits = new Set(String(critStr).split(',').map((s) => s.trim()).filter(Boolean));
  document.querySelectorAll('.nis2-crit').forEach((cb) => {
    cb.checked = crits.has(cb.value);
  });

  $('closeDlg').showModal();
}

let currentReport = { id: '', content: '' };

function openReportModal(id, reportText, title = '') {
  currentReport = { id, content: reportText };
  $('reportSub').textContent = title || `Incident-ID: ${id} | Upprättad enligt Cybersäkerhetslagen (NIS2)`;
  $('reportText').value = reportText;
  const editBtn = $('editNis2FromReportBtn');
  if (editBtn) {
    const isArchived = archive.some((i) => i.id === id);
    editBtn.classList.toggle('hidden', !isArchived);
  }
  $('reportDlg').showModal();
}

function printReport() {
  if (!currentReport.id) return;
  window.open(`/api/report/${encodeURIComponent(currentReport.id)}/print`, '_blank', 'noopener');
}

function openNis2EditDialog(id) {
  const inc = archive.find((i) => i.id === id);
  if (!inc) {
    toast('Ärendet måste vara arkiverat för att komplettera NIS2-data i efterhand.', false);
    return;
  }
  editingNis2Id = id;
  const n = inc.nis2 || {};
  const nodeMeta = findNodeMetaForIncident(inc);
  const defaultCust = inc.customers != null && inc.customers !== '' ? inc.customers : (nodeMeta ? nodeMeta.customers : '');

  $('nis2EditTitle').textContent = `${inc.area} – ${inc.faultType} (ID: ${inc.id})`;
  $('editNis2RootCause').value = n.rootCauseCategory !== undefined ? n.rootCauseCategory : guessRootCause(inc);
  $('editNis2Significant').value = n.significant === 'yes' ? 'yes' : 'no';
  $('editNis2Customers').value = n.affectedCustomers !== undefined && n.affectedCustomers !== '' ? n.affectedCustomers : (defaultCust || '');
  $('editNis2Percent').value = n.affectedPercent || '';
  $('editNis2CritComment').value = n.criticalComment || '';
  $('editNis2Resolution').value = inc.resolution || '';
  $('editNis2Preventive').value = n.preventiveAction || '';
  $('editNis2Preventive2').value = n.preventiveAction2 || '';
  $('editNis2AuthorityRef').value = n.authorityRef || '';
  $('editNis2CertRef').value = n.certRef || '';
  $('editNis2PoliceRef').value = n.policeRef || '';
  $('editNis2UpdateNote').value = '';
  $('nis2EditErr').textContent = '';

  const crits = new Set(Array.isArray(n.criticalSectors) ? n.criticalSectors : []);
  document.querySelectorAll('.edit-nis2-crit').forEach((cb) => {
    cb.checked = crits.has(cb.value);
  });

  if ($('reportDlg')?.open) $('reportDlg').close();
  $('nis2EditDlg').showModal();
}

async function confirmNis2Update() {
  if (!editingNis2Id) return;
  const nis2 = {
    rootCauseCategory: $('editNis2RootCause').value,
    significant: $('editNis2Significant').value === 'yes' ? 'yes' : 'no',
    affectedCustomers: $('editNis2Customers').value !== '' ? String($('editNis2Customers').value) : '',
    affectedPercent: $('editNis2Percent').value.trim(),
    criticalSectors: [...document.querySelectorAll('.edit-nis2-crit:checked')].map((cb) => cb.value),
    criticalComment: $('editNis2CritComment').value.trim(),
    preventiveAction: $('editNis2Preventive').value.trim(),
    preventiveAction2: $('editNis2Preventive2').value.trim(),
    authorityRef: $('editNis2AuthorityRef').value.trim(),
    certRef: $('editNis2CertRef').value.trim(),
    policeRef: $('editNis2PoliceRef').value.trim(),
  };
  const resolution = $('editNis2Resolution').value.trim();
  const updateNote = $('editNis2UpdateNote').value.trim();

  try {
    const res = await api('/api/archive/update-nis2', {
      id: editingNis2Id,
      nis2,
      resolution,
      updateNote,
    });
    $('nis2EditDlg').close();
    toast('NIS2-underlag uppdaterat och incidentrapport regenererad!');
    await fetchArchive();
    if (res.report) {
      openReportModal(editingNis2Id, res.report);
    }
  } catch (err) {
    $('nis2EditErr').textContent = err.message;
  }
}

async function showIncidentReport(id) {
  try {
    const res = await fetch(`/api/report/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Kunde inte hämta rapport');
    openReportModal(id, data.report);
  } catch (err) {
    toast(`Kunde inte ladda rapport: ${err.message}`, false);
  }
}

function downloadReport() {
  if (!currentReport.content) return;
  const blob = new Blob([currentReport.content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `incidentrapport-${currentReport.id || 'csl'}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Rapport nedladdad som .md');
}

async function copyReportText() {
  const text = $('reportText').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('reportText').select();
    document.execCommand('copy');
  }
  toast('Incidentrapport kopierad till urklipp!');
}

function openReopenDialog(id) {
  const inc = archive.find((i) => i.id === id);
  if (!inc) return;
  reopeningId = id;
  $('reopenTitle').textContent = `${inc.area} – ${inc.faultType}`;
  $('reopenNote').value = '';
  $('reopenErr').textContent = '';
  $('reopenDlg').showModal();
}

async function confirmReopen() {
  if (!reopeningId) return;
  const note = $('reopenNote').value.trim();
  try {
    await api('/api/reopen', { id: reopeningId, note });
    $('reopenDlg').close();
    toast('Ärendet har återöppnats och publicerats på driftportalen!');
    fetchIncidents();
    fetchArchive();
  } catch (err) {
    $('reopenErr').textContent = err.message;
  }
}

async function confirmClose() {
  const endDate = $('endDate').value;
  const endTime = normTime($('endTime').value);
  if (!DATE_RE.test(endDate) || !TIME_RE.test(endTime)) { $('closeErr').textContent = 'Ange datum (ÅÅÅÅ-MM-DD) och tid (HH:MM).'; return; }
  const nis2 = {
    affectedCustomers: $('nis2Customers').value !== '' ? String($('nis2Customers').value) : '',
    affectedPercent: $('nis2Percent').value.trim(),
    rootCauseCategory: $('nis2RootCause').value,
    significant: $('nis2Significant').value === 'yes' ? 'yes' : 'no',
    criticalSectors: [...document.querySelectorAll('.nis2-crit:checked')].map((cb) => cb.value),
    preventiveAction: $('nis2Preventive').value.trim(),
  };
  try {
    const closedId = closing;
    const res = await api('/api/close', { id: closedId, endDate, endTime, note: $('closeNote').value, nis2 });
    $('closeDlg').close();
    if ($('editId').value === closedId) resetForm();
    toast('Ärendet stängt! Incidentrapport enligt Cybersäkerhetslagen genererad.');
    fetchIncidents();
    fetchArchive();
    fetchAlerts();
    if (res.report) {
      openReportModal(closedId, res.report);
    }
  } catch (e) {
    $('closeErr').textContent = e.message;
  }
}

// ---------- Integrationer (FrameFlow) & Nodregister ----------
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

$('usersList')?.addEventListener('change', async (e) => {
  const roleSel = e.target.closest('[data-role-for]');
  if (!roleSel) return;
  const u = roleSel.dataset.roleFor;
  const role = roleSel.value;
  try {
    await api('/api/users/role', { username: u, role });
    toast(`Roll uppdaterad till "${role}" för "${u}"!`);
    loadUsers();
  } catch (err) {
    toast(err.message, false);
    loadUsers();
  }
});

$('usersList')?.addEventListener('click', async (e) => {
  const resetBtn = e.target.closest('[data-reset-pw]');
  const resetTotpBtn = e.target.closest('[data-reset-totp]');
  const delBtn = e.target.closest('[data-del-user]');
  if (resetBtn) {
    const u = resetBtn.dataset.resetPw;
    const pwInput = document.querySelector(`[data-pw-for="${CSS.escape(u)}"]`);
    const pw = pwInput ? pwInput.value : '';
    if (!pw || pw.length < 12) {
      toast('Ange ett nytt lösenord på minst 12 tecken i fältet bredvid kontot.', false);
      return;
    }
    try {
      await api('/api/users/reset-password', { username: u, newPassword: pw });
      if (pwInput) pwInput.value = '';
      toast(`Lösenord uppdaterat för "${u}"!`);
      loadUsers();
    } catch (err) {
      toast(err.message, false);
    }
  } else if (resetTotpBtn) {
    const u = resetTotpBtn.dataset.resetTotp;
    if (!confirm(`Vill du nollställa tvåfaktorsautentisering (2FA) för "${u}"?`)) return;
    try {
      await api('/api/users/reset-totp', { username: u });
      toast(`2FA har nollställts för "${u}".`);
      loadUsers();
    } catch (err) {
      toast(err.message, false);
    }
  } else if (delBtn) {
    const u = delBtn.dataset.delUser;
    if (!confirm(`Vill du verkligen ta bort användarkontot "${u}"?`)) return;
    try {
      await api('/api/users/remove', { username: u });
      toast(`Användare "${u}" borttagen.`);
      if (u === currentUser) {
        location.href = '/login';
        return;
      }
      loadUsers();
    } catch (err) {
      toast(err.message, false);
    }
  }
});

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

$('nodesList')?.addEventListener('click', (e) => {
  const delBtn = e.target.closest('[data-del-node]');
  if (!delBtn) return;
  const current = collectNodesFromEditor();
  current.splice(Number(delBtn.dataset.delNode), 1);
  renderNodesEditor(current);
});

// ---------- Tema, utloggning, lathund ----------
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

// ---------- Start ----------
// En enda klick-lyssnare ersätter alla inline onclick (krävs för strikt CSP)
document.addEventListener('click', (e) => {
  if (e.target.id === 'docModal') return toggleModal(); // klick på bakgrunden
  if (e.target.tagName === 'DIALOG') {
    const r = e.target.getBoundingClientRect();
    if (r.width && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) e.target.close();
    return;
  }
  const rep = e.target.closest('[data-rep]');
  if (rep) {
    showIncidentReport(rep.dataset.rep);
    return;
  }
  const nis2Btn = e.target.closest('[data-nis2]');
  if (nis2Btn) {
    openNis2EditDialog(nis2Btn.dataset.nis2);
    return;
  }
  const ro = e.target.closest('[data-reopen]');
  if (ro) {
    openReopenDialog(ro.dataset.reopen);
    return;
  }
  const delArc = e.target.closest('[data-del-arc]');
  if (delArc && !e.target.closest('#activeIncidentsList')) {
    deleteArchivedIncident(delArc.dataset.delArc);
    return;
  }
  const delTl = e.target.closest('[data-del-tl-idx]');
  if (delTl) {
    const idx = Number(delTl.dataset.delTlIdx);
    if (!Number.isNaN(idx) && editingPublicUpdates.length > 1) {
      editingPublicUpdates.splice(idx, 1);
      timelineModified = true;
      renderEditTimelineList();
    }
    return;
  }
  const hb = e.target.closest('[data-hist]');
  if (hb) {
    const id = hb.dataset.hist;
    const el = document.getElementById(`h-${id}`);
    el.classList.toggle('hidden');
    if (el.classList.contains('hidden')) openHist.delete(id); else openHist.add(id);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, arg } = el.dataset;
  if (action === 'toggleModal') toggleModal();
  else if (action === 'resetForm') resetForm();
  else if (action === 'publish') publish();
  else if (action === 'showTab') showTab(arg);
  else if (action === 'copy') copyText(arg);
  else if (action === 'theme') cycleTheme();
  else if (action === 'logout') logout();
  else if (action === 'doc') showDoc(arg);
  else if (action === 'confirmClose') confirmClose();
  else if (action === 'cancelClose') $('closeDlg').close();
  else if (action === 'closeReport') $('reportDlg').close();
  else if (action === 'copyReport') copyReportText();
  else if (action === 'downloadReport') downloadReport();
  else if (action === 'printReport') printReport();
  else if (action === 'editNis2FromReport') { if (currentReport.id) openNis2EditDialog(currentReport.id); }
  else if (action === 'cancelNis2Edit') $('nis2EditDlg').close();
  else if (action === 'confirmNis2Update') confirmNis2Update();
  else if (action === 'cancelReopen') $('reopenDlg').close();
  else if (action === 'confirmReopen') confirmReopen();
  else if (action === 'closeFirstOverdue') { if (overdueFirstId) closeIncident(overdueFirstId); }
  else if (action === 'openSettings') openSettings();
  else if (action === 'closeSettings') $('settingsDlg').close();
  else if (action === 'settingsTab') showSettingsTab(arg);
  else if (action === 'saveSettings') saveSettings();
  else if (action === 'rotateToken') rotateToken();
  else if (action === 'testFrameFlow') testFrameFlow();
  else if (action === 'testNotification') testNotification();
  else if (action === 'changeMyPassword') changeMyPassword();
  else if (action === 'setupMyTotp') setupMyTotp();
  else if (action === 'enableMyTotp') enableMyTotp();
  else if (action === 'disableMyTotp') disableMyTotp();
  else if (action === 'addUser') addUser();
  else if (action === 'refreshAudit') loadAuditLog();
  else if (action === 'exportAudit') exportAudit();
  else if (action === 'downloadBackup') downloadBackup();
  else if (action === 'restoreBackup') restoreBackup();
  else if (action === 'refreshSystemInfo') loadSystemInfo();
  else if (action === 'simulateAlert') simulateAlert(arg);
  else if (action === 'dismissAlert') dismissAlert(arg);
  else if (action === 'unlinkAlert') unlinkAlert();
  else if (action === 'addNode') {
    const current = collectNodesFromEditor();
    current.push({ id: `node-${Date.now()}`, name: '', domain: 'stadsnat', keywords: [], customers: 100, distCount: 1, accCount: 24, critical: [] });
    renderNodesEditor(current);
  }
});

FIELDS.forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    if (el.getAttribute('aria-invalid') === 'true') validate();
    generate();
  });
});
$('serviceBox')?.addEventListener('change', () => generate());
$('nodesList')?.addEventListener('input', (e) => {
  const accInput = e.target.closest('.node-acc');
  if (!accInput) return;
  const row = accInput.closest('.node-row');
  const distInput = row?.querySelector('.node-dist');
  if (!distInput) return;
  const accVal = Math.max(1, parseInt(accInput.value, 10) || 1);
  const minDist = Math.ceil(accVal / 24);
  const curDist = Math.max(1, parseInt(distInput.value, 10) || 1);
  if (curDist < minDist) {
    distInput.value = String(minDist);
  }
});
$('archiveSearch')?.addEventListener('input', () => renderArchiveList());
$('restoreBackupFile')?.addEventListener('change', previewRestoreFile);
$('auditSearch')?.addEventListener('input', () => loadAuditLog());
$('auditCategory')?.addEventListener('change', () => loadAuditLog());
$('tlModeReplace')?.addEventListener('change', syncTimelineModeUI);
$('tlModeAppend')?.addEventListener('change', syncTimelineModeUI);
$('publicTimelineList')?.addEventListener('input', (e) => {
  const inp = e.target.closest('[data-edit-tl-idx]');
  if (!inp) return;
  const idx = Number(inp.dataset.editTlIdx);
  if (!Number.isNaN(idx) && editingPublicUpdates[idx]) {
    editingPublicUpdates[idx].text = inp.value;
    timelineModified = true;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('docModal').classList.contains('hidden')) toggleModal();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) publish();
});

buildTabs();
applyTheme(getTheme());
$('archiveBox').addEventListener('toggle', () => { if ($('archiveBox').open) fetchArchive(); });
showDoc('tech');
$('domain').addEventListener('change', () => { applyDomain($('domain').value); generate(); });
fetch('/api/me').then((r) => r.json()).then((m) => {
  if (m.user) {
    currentUser = m.user;
    currentUserRole = m.role || 'admin';
    myTotpEnabled = Boolean(m.totpEnabled);
    const roleLabel = currentUserRole === 'tekniker' ? 'Tekniker' : 'Admin';
    $('who').textContent = `(${m.user} · ${roleLabel})`;
  }
}).catch(() => {});
applyDomain('stadsnat');
if (loadDraft()) {
  $('formTitle').textContent = 'Ny händelse (utkast återställt)';
} else {
  $('startDate').value = todayISO();
  $('startTime').value = nowHHMM();
  $('formTitle').textContent = 'Ny händelse';
}
if (!$('startDate').value) $('startDate').value = todayISO();
generate();
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

loadSettingsData();
pollAdminState();
setInterval(() => {
  if (!document.hidden) pollAdminState();
}, 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollAdminState();
});
fetch('/api/config').then((r) => r.json()).then((c) => {
  const portalUrl = c.publicUrl || `${location.protocol}//${location.hostname}:${c.portalPort || 3001}/`;
  PUBLIC_URL = portalUrl;
  $('publicLink').href = portalUrl;
  const jsonUrl = `${portalUrl.replace(/\/+$/, '')}/status.json`;
  if ($('statusJsonLink')) $('statusJsonLink').href = jsonUrl;
  generate();
  const same = c.version === UI_VERSION;
  $('ver').textContent = `Server ${c.version || 'okänd (gammal)'} · Sida ${UI_VERSION}`;
  $('ver').classList.toggle('text-danger', !same);
  if (!same) toast('Server och sida har olika versioner. Kör ./deploy.sh och tryck Ctrl+F5 (se lathunden).', false);
}).catch(() => {});
