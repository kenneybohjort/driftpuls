// Publik driftportal: Rendering av HTML, RSS 2.0, status.json, publik tidslinje och auto-arkivering

const path = require('path');
const fs = require('fs');
const {
  ROOT_DIR,
  PUBLIC_DIR,
  PUBLIC_URL,
  PORTAL_PORT,
  archiveFile,
  REPORTS_DIR,
  esc,
  audit,
  load,
  save,
  loadArchiveRows,
  invalidateArchiveCache,
  SCOPE_META,
  DOMAIN_LABEL,
  nowLocal,
  todayLocal,
  isDate,
  isTime,
  text,
  startKey,
  endKey,
} = require('./store');
const { generateCyberReport } = require('./nis2');

const CSS_V = (() => {
  try { return Math.floor(fs.statSync(path.join(ROOT_DIR, 'public', 'assets', 'tailwind.css')).mtimeMs); } catch { return 0; }
})();

// Bygger den publika tidslinjen för ett ärende (läser aldrig in interna anteckningar `note`)
function buildPublicUpdates(prev, data, tsLocal = nowLocal(), opts = {}) {
  const mode = (opts.timelineMode === 'replace' || opts.addTimelineStep === false) ? 'replace' : 'append';
  const clearTimeline = Boolean(opts.clearTimeline);
  const customStepText = text(opts.timelineStepText, 1000);
  const fmtEttr = (d) => (d.ettrDate && isTime(d.ettr || '') ? `${d.ettrDate} ${d.ettr}` : (d.ettr || ''));
  const defaultText = (d) => d.techDetails || (d.kind === 'planned' ? 'Planerat arbete inlagt.' : 'Felsökning pågår.');
  const startTs = `${data.startDate || todayLocal()} ${data.startTime || tsLocal.slice(11)}`;

  if (!prev || clearTimeline) {
    return [{
      ts: startTs,
      status: data.statusType || 'Pågående Störning',
      ettr: fmtEttr(data),
      text: defaultText(data),
    }];
  }

  let list;
  if (Array.isArray(opts.customPublicUpdates) && opts.customPublicUpdates.length > 0) {
    list = opts.customPublicUpdates
      .filter((u) => u && typeof u === 'object')
      .map((u) => ({
        ts: text(u.ts, 25) || startKey(prev),
        status: text(u.status, 40) || 'Pågående Störning',
        ettr: text(u.ettr, 30),
        text: text(u.text, 1000),
      }))
      .filter((u) => u.text);
  }
  if (!list || !list.length) {
    list = Array.isArray(prev.publicUpdates) && prev.publicUpdates.length
      ? prev.publicUpdates.map((u) => ({ ...u }))
      : [{
        ts: startKey(prev),
        status: prev.statusType || 'Pågående Störning',
        ettr: fmtEttr(prev),
        text: defaultText(prev),
      }];
  }

  const newEttr = fmtEttr(data);

  // Om användaren valt att enbart ändra aktuell lägesrapport (utan nytt steg i tidslinjen)
  if (mode === 'replace') {
    if (list.length === 1) {
      list[0] = {
        ts: startTs,
        status: data.statusType || list[0].status || 'Pågående Störning',
        ettr: newEttr,
        text: defaultText(data),
      };
    } else if (!Array.isArray(opts.customPublicUpdates)) {
      const lastIdx = list.length - 1;
      if (list[lastIdx].text === (prev.techDetails || '')) {
        list[lastIdx] = {
          ...list[lastIdx],
          status: data.statusType || list[lastIdx].status,
          ettr: newEttr,
          text: defaultText(data),
        };
      }
    }
    return list.slice(-30);
  }

  const techChanged = (prev.techDetails || '') !== (data.techDetails || '');
  const ettrChanged = fmtEttr(prev) !== newEttr;
  const statusChanged = (prev.statusType || '') !== (data.statusType || '');
  if (!customStepText && !techChanged && !ettrChanged && !statusChanged) return list;

  let newText = customStepText || data.techDetails || '';
  if (!customStepText && !techChanged && ettrChanged) {
    newText = data.techDetails
      ? `${data.techDetails}`
      : `Uppdaterad prognos: ${newEttr || 'Ej fastställt'}`;
  } else if (!newText) {
    newText = `${data.statusType || 'Uppdaterad status'}${newEttr ? ` (Prognos: ${newEttr})` : ''}`;
  }

  const last = list[list.length - 1];
  if (!customStepText && last && last.text === newText && last.ettr === newEttr && last.status === data.statusType) {
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
  const rows = loadArchiveRows();
  if (!rows.length) return [];
  const cutoffMs = Date.now() - hours * 3600 * 1000;
  const seen = new Set();
  const recent = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
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
        invalidateArchiveCache();
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

let lastCopiedCssMtime = -1;
// Generera den statiska publika driftportalen, status.json och rss.xml
function generatePublicSite() {
  try {
    autoArchiveCompletedPlanned(60);
    const assetsDir = path.join(PUBLIC_DIR, 'assets');
    const srcCss = path.join(ROOT_DIR, 'public', 'assets', 'tailwind.css');
    const dstCss = path.join(assetsDir, 'tailwind.css');
    const srcMtime = fs.existsSync(srcCss) ? fs.statSync(srcCss).mtimeMs : 0;
    if (srcMtime && (srcMtime !== lastCopiedCssMtime || !fs.existsSync(dstCss))) {
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.cpSync(path.join(ROOT_DIR, 'public', 'assets'), assetsDir, { recursive: true });
      lastCopiedCssMtime = srcMtime;
    } else if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
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

module.exports = {
  CSS_V,
  buildPublicUpdates,
  whenText,
  loadRecentlyResolved,
  renderRss,
  renderPortal,
  autoArchiveCompletedPlanned,
  generatePublicSite,
  invalidate,
  portal,
};
