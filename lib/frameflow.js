// FrameFlow-motor (Pull & Push -> Larminkorg i Admin) samt rate-limiting

const crypto = require('crypto');
const {
  DOMAINS,
  nowLocal,
  text,
  load,
  save,
  loadSettings,
  saveSettings,
  sendNotification,
  loadAlerts,
  saveAlerts,
  matchNode,
} = require('./store');
const { parseDeviceRole } = require('../public/topology');

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

  // Städa bort avfärdade och äldre återställda larm först, behåll upp till 250 larm så att även stora switch-kluster ryms
  const MAX_ALERTS = 250;
  let prunedAlerts = alerts;
  if (prunedAlerts.length > MAX_ALERTS) {
    const activeUnlinked = prunedAlerts.filter((a) => !a.dismissed && !a.resolvedAt);
    const rest = prunedAlerts.filter((a) => a.dismissed || a.resolvedAt);
    prunedAlerts = [...activeUnlinked, ...rest].slice(0, MAX_ALERTS);
  }
  saveAlerts(prunedAlerts);
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

module.exports = {
  extractFrameFlowItems,
  processFrameFlowPayload,
  pollFrameFlow,
  scheduleFrameFlowPoller,
  ffAuthFails,
  ffRateWindow,
  cleanupFrameFlowRateLimits,
};
