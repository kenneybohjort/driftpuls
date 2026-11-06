// NIS2 / Cybersäkerhetslagen: Rapportmotor, varaktighetsberäkning och sanering

const { DOMAIN_LABEL, FIELD_LABEL, text } = require('./store');

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

module.exports = {
  VALID_NIS2_CAUSES,
  VALID_NIS2_CRIT,
  CAUSE_LABELS,
  CRIT_LABELS,
  calcDuration,
  sanitizeNis2,
  generateCyberReport,
  renderCyberReportHtml,
};
