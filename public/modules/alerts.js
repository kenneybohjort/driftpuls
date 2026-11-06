// Modul: FrameFlow Larminkorg (klustergruppering, avfärdande och simulering)

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
