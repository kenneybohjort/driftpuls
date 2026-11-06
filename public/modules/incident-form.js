// Modul: Ny händelse & Redigering av pågående ärende (formulär, utkast, larmkoppling och tidslinjeläge)

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
