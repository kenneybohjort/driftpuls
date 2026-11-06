// Driftpuls Admin – Huvudskript (Event-delegation & uppstart)
// Moduler laddas före detta skript:
// - /topology.js (switch- och topologiberäkning)
// - /modules/core.js (delat tillstånd, tid, API-klient, tema & portalstatus)
// - /modules/channels.js (genererade kanaler: SMS, Webb, Sociala Medier, Intern rapport)
// - /modules/incident-form.js (formulär för ny/redigerad händelse, larmkoppling & publik tidslinje)
// - /modules/incidents-archive.js (aktiva & stängda ärenden, radering, återöppning & NIS2-rapporter)
// - /modules/alerts.js (FrameFlow larminkorg, klustergruppering & simulering)
// - /modules/settings.js (integrationer, nodregister, användare/2FA, revisionslogg & backup)

['startTime', 'ettr'].forEach((id) => $(id).addEventListener('blur', () => {
  $(id).value = normTime($(id).value);
  validate();
  generate();
}));

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

$('nodesList')?.addEventListener('click', (e) => {
  const delBtn = e.target.closest('[data-del-node]');
  if (!delBtn) return;
  const current = collectNodesFromEditor();
  current.splice(Number(delBtn.dataset.delNode), 1);
  renderNodesEditor(current);
});

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

// ---------- Initialisering ----------
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
