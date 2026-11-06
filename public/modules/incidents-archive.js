// Modul: Aktiva och stängda ärenden, radering, återöppning samt NIS2-incidentrapporter

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
  const inc = archive.find((i) => i.id === id) || recentlyResolved.find((i) => i.id === id);
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
  const inc = archive.find((i) => i.id === id) || recentlyResolved.find((i) => i.id === id);
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
