const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Använd isolerad temporär mapp för alla tester så produktionsdata aldrig rörs
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
process.env.DATA_DIR = tmpDir;
process.env.PUBLIC_DIR = path.join(tmpDir, 'public-site');
process.env.ADMIN_USER = 'testadmin';
process.env.ADMIN_PASS = 'testpassword12345';

const {
  app,
  authz,
  clean,
  calcDuration,
  buildPublicUpdates,
  sanitizeNis2,
  generateCyberReport,
  renderCyberReportHtml,
  renderPortal,
  extractFrameFlowItems,
  processFrameFlowPayload,
  autoArchiveCompletedPlanned,
  cleanupFrameFlowRateLimits,
  ffAuthFails,
  ffRateWindow,
} = require('../server');

let server;
let baseUrl = '';

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

test('1. clean() sanerar kontrolltecken, sätter standardvärden och begränsar längd', () => {
  const out = clean({
    area: '  Arbrå\x00\x07 Nod  ',
    domain: 'ogiltig',
    kind: 'ogiltig',
    startTime: '08:0012345',
  });
  assert.equal(out.area, 'Arbrå Nod');
  assert.equal(out.domain, 'stadsnat');
  assert.equal(out.kind, 'incident');
  assert.equal(out.startTime, '08:00');
});

test('2. calcDuration() beräknar varaktighet mellan start och slut', () => {
  const dur = calcDuration('2026-10-29 08:00', '2026-10-29 10:45');
  assert.match(dur, /2 timmar 45 minuter \(165 minuter totalt\)/);
});

test('3. generateCyberReport() skapar komplett NIS2-rapport med 24h/72h/1m-tidsfrister', () => {
  const inc = {
    id: '1700000000000',
    domain: 'stadsnat',
    kind: 'incident',
    statusType: 'Åtgärdat (klarrapport)',
    area: 'Arbrå',
    faultType: 'Fiberavgrävning',
    services: 'Bredband, TV',
    startDate: '2026-10-29',
    startTime: '08:00',
    ettrDate: '2026-10-29',
    ettr: '12:00',
    endedAt: '2026-10-29 11:30',
    createdAt: '2026-10-29T07:05:00.000Z',
    closedAt: '2026-10-29T10:30:00.000Z',
    closedBy: 'testadmin',
    techDetails: 'Schaktskada vid vägarbete.',
    resolution: 'Omskarvad 96-fiber',
    nis2: {
      affectedCustomers: '850',
      affectedPercent: '11',
      rootCauseCategory: 'thirdparty',
      significant: 'yes',
      criticalSectors: ['care', '112'],
      preventiveAction: 'Förbättrad kabelutsättning',
    },
    history: [
      { ts: '2026-10-29T07:05:00.000Z', by: 'testadmin', action: 'create', note: 'Larm inkom' },
    ],
  };
  const md = generateCyberReport(inc);
  assert.match(md, /INCIDENTRAPPORT ENLIGT CYBERSÄKERHETSLAGEN \(NIS2\)/);
  assert.match(md, /Post- och telestyrelsen \(PTS\)/);
  assert.match(md, /Tidig varning \(24h från kännedom\)/);
  assert.match(md, /Incidentanmälan \(72h från kännedom\)/);
  assert.match(md, /Slutrapport \(senast 1 månad\)/);
  assert.match(md, /850 st/);
  assert.match(md, /\[x\] Fysisk yttre åverkan \/ Tredje part/);
  assert.match(md, /Omskarvad 96-fiber/);
});

test('4. renderPortal() skiljer på kommande och pågående planerat arbete samt escapear XSS', () => {
  const html = renderPortal([
    {
      id: '1',
      domain: 'stadsnat',
      kind: 'planned',
      statusType: 'Planerat underhåll',
      area: 'Kilafors <script>alert(1)</script>',
      faultType: 'Planerat underhåll',
      services: 'Bredband',
      startDate: '2099-01-01',
      startTime: '08:00',
      ettrDate: '2099-01-01',
      ettr: '12:00',
      techDetails: 'Byte av linjekort',
    },
    {
      id: '2',
      domain: 'fjarrvarme',
      kind: 'planned',
      statusType: 'Planerat arbete',
      area: 'Bollnäs C',
      faultType: 'Planerat arbete',
      services: 'Värme',
      startDate: '2020-01-01',
      startTime: '08:00',
      ettrDate: '2099-01-01',
      ettr: '16:00',
      techDetails: 'Ventilbyte',
    },
  ]);
  assert.match(html, /📅 Kommande planerat arbete/);
  assert.match(html, /🔧 Pågående planerat arbete/);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'XSS måste vara escapad');
});

test('5. FrameFlow-larm matchar nodregistret och hanterar återställning (OK)', () => {
  const items = extractFrameFlowItems({
    device: 'arbra-sw01',
    monitor: 'Ping',
    status: 'Down',
    message: 'Packet loss 100%',
  });
  assert.equal(items.length, 1);

  const resDown = processFrameFlowPayload(items[0], 'push');
  assert.equal(resDown.created, 1);
  const savedAlerts = JSON.parse(fs.readFileSync(path.join(tmpDir, 'alerts.json'), 'utf8'));
  assert.equal(savedAlerts[0].area, 'Arbrå');
  assert.equal(savedAlerts[0].domain, 'stadsnat');

  const resUp = processFrameFlowPayload({
    device: 'arbra-sw01',
    monitor: 'Ping',
    status: 'OK',
    message: 'Ping response 2 ms',
  }, 'push');
  assert.ok(resUp.resolved >= 1);
});

test('6. autoArchiveCompletedPlanned() arkiverar planerade arbeten vars sluttid passerats med >60 min', () => {
  const storingarPath = path.join(tmpDir, 'storingar.json');
  fs.writeFileSync(storingarPath, JSON.stringify([
    {
      id: '999',
      domain: 'stadsnat',
      kind: 'planned',
      statusType: 'Planerat underhåll',
      area: 'Rengsjö',
      faultType: 'Planerat underhåll',
      services: 'Bredband',
      startDate: '2020-01-01',
      startTime: '01:00',
      ettrDate: '2020-01-01',
      ettr: '02:00',
      createdAt: '2020-01-01T00:00:00.000Z',
      history: [],
    },
  ], null, 2));

  const archivedCount = autoArchiveCompletedPlanned(60);
  assert.equal(archivedCount, 1);
  const remaining = JSON.parse(fs.readFileSync(storingarPath, 'utf8'));
  assert.equal(remaining.length, 0);
});

test('7. auth.users hanterar konton, lösenordsverifiering och skyddar sista kontot', () => {
  authz.users.add('tekniker1', 'ettmycketbraochlangtlosenord');
  assert.equal(authz.users.verifyPassword('tekniker1', 'ettmycketbraochlangtlosenord'), true);
  assert.equal(authz.users.verifyPassword('tekniker1', 'fellosenord12345'), false);

  const list = authz.users.listDetailed();
  assert.ok(list.some((u) => u.username === 'tekniker1'));

  authz.users.remove('tekniker1');
  // Nu återstår bara 'testadmin' - ska inte gå att radera sista kontot
  assert.throws(() => authz.users.remove('testadmin'), /sista kvarvarande användaren/);
});

test('8. HTTP-endpoints: /healthz och FrameFlow brute-force-skydd', async () => {
  const hRes = await fetch(`${baseUrl}/healthz`);
  assert.equal(hRes.status, 200);
  const hText = await hRes.text();
  assert.equal(hText.trim(), 'ok');

  // Felaktig Bearer-token till FrameFlow ska ge 401
  const badRes = await fetch(`${baseUrl}/api/ingest/frameflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fel-token' },
    body: JSON.stringify({ device: 'test', status: 'Down' }),
  });
  assert.equal(badRes.status, 401);
});

test('9. renderPortal() visar nyligen åtgärdade störningar (senaste 24h) utan att läcka interna anteckningar', () => {
  const html = renderPortal([], [
    {
      id: 'res-1',
      domain: 'stadsnat',
      kind: 'incident',
      statusType: 'Åtgärdat (klarrapport)',
      area: 'Vallsta',
      faultType: 'Strömavbrott',
      services: 'Bredband, TV',
      startDate: '2026-10-30',
      startTime: '06:15',
      endedAt: '2026-10-30 07:45',
      closedAt: new Date().toISOString(),
      note: 'INTERN-HEMLIG-ANTECKNING',
      resolution: 'INTERN-ROTorsak-UPS-bytt',
    },
  ]);
  assert.match(html, /Nyligen åtgärdade händelser \(senaste 24 timmarna\)/);
  assert.match(html, /Vallsta/);
  assert.match(html, /Strömavbrott/);
  assert.match(html, /07:45/);
  assert.ok(!html.includes('INTERN-HEMLIG-ANTECKNING'), 'Intern anteckning får aldrig läcka ut på publika portalen');
  assert.ok(!html.includes('INTERN-ROTorsak-UPS-bytt'), 'Intern åtgärdstext får aldrig läcka ut på publika portalen');
});

test('10. buildPublicUpdates() och renderPortal() skapar publik tidslinje för lägesuppdateringar utan interna anteckningar', () => {
  const initialData = {
    domain: 'stadsnat',
    kind: 'incident',
    statusType: 'Pågående Störning',
    area: 'Segersta',
    faultType: 'Fiberavgrävning',
    services: 'Bredband',
    startDate: '2026-10-30',
    startTime: '08:00',
    ettrDate: '2026-10-30',
    ettr: '12:00',
    techDetails: 'Felsökning pågår, tekniker är på väg.',
  };
  const upd1 = buildPublicUpdates(null, initialData, '2026-10-30 08:00');
  assert.equal(upd1.length, 1);

  const prevInc = { ...initialData, publicUpdates: upd1 };
  // Enbart intern ändring (ingen ändring av techDetails/ettr/statusType) ska inte skapa ny publik rad
  const updNoChange = buildPublicUpdates(prevInc, { ...initialData }, '2026-10-30 08:30');
  assert.equal(updNoChange.length, 1);

  // Uppdaterad lägesrapport och prognos ska lägga till steg 2 i tidslinjen
  const nextData = {
    ...initialData,
    statusType: 'Uppdaterad Prognos / Info',
    ettr: '14:30',
    techDetails: 'Avgrävd kabel lokaliserad vid schakt, skarvning pågår.',
  };
  const upd2 = buildPublicUpdates(prevInc, nextData, '2026-10-30 09:45');
  assert.equal(upd2.length, 2);

  const html = renderPortal([{ id: 'tl-1', ...nextData, publicUpdates: upd2 }], []);
  assert.match(html, /🕒 Tidslinje för lägesuppdateringar \(2 st\)/);
  assert.match(html, /Felsökning pågår, tekniker är på väg\./);
  assert.match(html, /Avgrävd kabel lokaliserad vid schakt, skarvning pågår\./);
  assert.match(html, /Senaste/);
  assert.match(html, /Start/);
});

test('11. Förslag 2: Komplettera NIS2-data i efterhand i arkivet och utskriftsvänlig HTML-rapport', async () => {
  // Logga in som admin för att erhålla sessionscookie
  const loginRes = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'testadmin', password: 'testpassword12345' }),
  });
  assert.equal(loginRes.status, 200);
  const rawCookie = loginRes.headers.get('set-cookie') || '';
  const cookieHeader = rawCookie.split(';')[0];
  assert.match(cookieHeader, /^drift_sid=/);

  const authHeaders = {
    'Content-Type': 'application/json',
    Origin: baseUrl,
    Cookie: cookieHeader,
  };

  // Skapa och stäng ett ärende
  const pubRes = await fetch(`${baseUrl}/api/publish`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      id: 'nis2-post-1',
      domain: 'stadsnat',
      statusType: 'Pågående Störning',
      area: 'Rengsjö',
      faultType: 'Fiberavgrävning',
      services: 'Bredband, TV',
      startDate: '2026-10-30',
      startTime: '07:00',
      techDetails: 'Schaktskada vid väg 50.',
    }),
  });
  assert.equal(pubRes.status, 200);

  const closeRes = await fetch(`${baseUrl}/api/close`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      id: 'nis2-post-1',
      endDate: '2026-10-30',
      endTime: '11:30',
      note: 'Skarvning klar.',
      nis2: {
        significant: 'no',
        affectedCustomers: '120',
        rootCauseCategory: 'thirdparty',
      },
    }),
  });
  assert.equal(closeRes.status, 200);

  // Komplettera NIS2-underlaget i efterhand utan att återöppna ärendet
  const updRes = await fetch(`${baseUrl}/api/archive/update-nis2`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      id: 'nis2-post-1',
      resolution: 'Avgrävd 96-fiber stamkabel skarvad och inmätt med OTDR.',
      updateNote: 'Kompletterat med PTS diarienummer och 1-månadsuppföljning.',
      nis2: {
        significant: 'yes',
        affectedCustomers: '410',
        affectedPercent: '8',
        rootCauseCategory: 'thirdparty',
        criticalSectors: ['care', 'municipal'],
        criticalComment: 'Äldreboende i Rengsjö berört under 4,5 timmar.',
        preventiveAction: 'Uppdaterat ledningsanvisningsunderlag i Ledningskollen.',
        preventiveAction2: 'Projektering av sekundär ringmatning Rengsjö–Segersta.',
        authorityRef: 'PTS-2026-9988',
        certRef: 'CERT-2026-771',
        policeRef: '',
      },
    }),
  });
  assert.equal(updRes.status, 200);
  const updJson = await updRes.json();
  assert.equal(updJson.success, true);
  assert.match(updJson.report, /PTS-2026-9988/);
  assert.match(updJson.report, /CERT-2026-771/);
  assert.match(updJson.report, /Projektering av sekundär ringmatning/);
  assert.match(updJson.report, /Komplettering av NIS2-data i arkivet/);

  // Verifiera att ärendet INTE återöppnats på publika sidan
  const activeRes = await fetch(`${baseUrl}/api/incidents`, { headers: { Cookie: cookieHeader } });
  const activeList = await activeRes.json();
  assert.equal(activeList.some((i) => i.id === 'nis2-post-1'), false);

  // Verifiera utskriftsvänlig HTML-rapport (/api/report/:id/print)
  const printRes = await fetch(`${baseUrl}/api/report/nis2-post-1/print`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(printRes.status, 200);
  const printHtml = await printRes.text();
  assert.match(printHtml, /INCIDENTRAPPORT &ndash; DOKUMENTREFERENS INC-nis2-post-1/);
  assert.match(printHtml, /PTS-2026-9988/);
  assert.match(printHtml, /\/print\.js\?v=/);
});

test('12. Förslag 6: Export och återställning av backup (/api/backup/restore) inkl. pre-restore-backup.json', async () => {
  const loginRes = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'testadmin', password: 'testpassword12345' }),
  });
  const cookieHeader = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const authHeaders = {
    'Content-Type': 'application/json',
    Origin: baseUrl,
    Cookie: cookieHeader,
  };

  // Exportera nuvarande backup
  const expRes = await fetch(`${baseUrl}/api/backup/export`, { headers: { Cookie: cookieHeader } });
  assert.equal(expRes.status, 200);
  const exported = await expRes.json();
  assert.ok(Array.isArray(exported.archive));

  // Återställ en anpassad backup-payload
  const customBackup = {
    exportedAt: '2026-10-30T10:00:00.000Z',
    incidents: [
      {
        id: 'restored-active-1',
        domain: 'fjarrvarme',
        kind: 'incident',
        statusType: 'Pågående Störning',
        area: 'Gärdet',
        faultType: 'Tryckfall',
        services: 'Värme, Varmvatten',
        startDate: '2026-10-30',
        startTime: '09:00',
        techDetails: 'Cirkulationspump stannat.',
        history: [{ ts: '2026-10-30T08:00:00.000Z', by: 'testadmin', action: 'create' }],
      },
    ],
    archive: exported.archive,
    alerts: [],
    settings: exported.settings,
  };

  const restRes = await fetch(`${baseUrl}/api/backup/restore`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(customBackup),
  });
  assert.equal(restRes.status, 200);
  const restJson = await restRes.json();
  assert.equal(restJson.success, true);
  assert.equal(restJson.restored.incidents, 1);

  // Kontrollera att pre-restore-backup.json skapades automatiskt
  const preRestorePath = path.join(tmpDir, 'pre-restore-backup.json');
  assert.equal(fs.existsSync(preRestorePath), true);

  // Kontrollera att det återställda aktiva ärendet finns i /api/incidents
  const incRes = await fetch(`${baseUrl}/api/incidents`, { headers: { Cookie: cookieHeader } });
  const incList = await incRes.json();
  assert.equal(incList.length, 1);
  assert.equal(incList[0].id, 'restored-active-1');
  assert.equal(incList[0].area, 'Gärdet');
});

test('13. Punkt 1: Utgående webhook-notiser (publicering, uppdatering, stängning), onFrameFlowAlert och rate-limit-städning', async () => {
  const http = require('node:http');
  const receivedEvents = [];

  // Starta en lokal mottagare för utgående webhook-notiser
  const whServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { receivedEvents.push(JSON.parse(body)); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => whServer.listen(0, '127.0.0.1', resolve));
  const whUrl = `http://127.0.0.1:${whServer.address().port}/webhook`;

  try {
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ username: 'testadmin', password: 'testpassword12345' }),
    });
    const cookieHeader = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    const authHeaders = {
      'Content-Type': 'application/json',
      Origin: baseUrl,
      Cookie: cookieHeader,
    };

    // 1. Verifiera att onFrameFlowAlert: false sparas korrekt via /api/settings
    const saveSetRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        notifications: {
          enabled: true,
          webhookUrl: whUrl,
          onFrameFlowAlert: false,
          onPublish: true,
        },
      }),
    });
    assert.equal(saveSetRes.status, 200);
    const saveSetJson = await saveSetRes.json();
    assert.equal(saveSetJson.notifications.onFrameFlowAlert, false);
    assert.equal(saveSetJson.notifications.onPublish, true);

    // 2. Publicera nytt ärende -> ska trigga incident_published
    const pubRes = await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        id: 'wh-inc-1',
        domain: 'stadsnat',
        kind: 'incident',
        statusType: 'Pågående Störning',
        area: 'Alfta',
        faultType: 'Strömavbrott',
        services: 'Internet',
        startDate: '2026-10-30',
        startTime: '10:00',
      }),
    });
    assert.equal(pubRes.status, 200);

    // 3. Uppdatera ärende -> ska trigga incident_updated
    const updRes = await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        id: 'wh-inc-1',
        domain: 'stadsnat',
        kind: 'incident',
        statusType: 'Felsökning pågår',
        area: 'Alfta',
        faultType: 'Strömavbrott',
        services: 'Internet',
        startDate: '2026-10-30',
        startTime: '10:00',
        estTime: '14:00',
      }),
    });
    assert.equal(updRes.status, 200);

    // 4. Stäng ärende -> ska trigga incident_closed
    const closeRes = await fetch(`${baseUrl}/api/close`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        id: 'wh-inc-1',
        endDate: '2026-10-30',
        endTime: '12:30',
        note: 'Reservkraft inkopplad.',
      }),
    });
    assert.equal(closeRes.status, 200);

    // Vänta kort på de asynkrona utgående webhook-anropen
    for (let i = 0; i < 20 && receivedEvents.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.equal(receivedEvents.length, 3);
    assert.equal(receivedEvents[0].event, 'incident_published');
    assert.match(receivedEvents[0].title, /Publicerat ärende: Alfta/);
    assert.equal(receivedEvents[1].event, 'incident_updated');
    assert.match(receivedEvents[1].title, /Uppdaterat ärende: Alfta/);
    assert.equal(receivedEvents[2].event, 'incident_closed');
    assert.match(receivedEvents[2].title, /Åtgärdat ärende: Alfta/);

    // 5. Verifiera cleanupFrameFlowRateLimits()
    const now = Date.now();
    ffAuthFails.set('10.0.0.1', { count: 0, until: now - 1000, ts: now - 900000 });
    ffAuthFails.set('10.0.0.2', { count: 3, until: 0, ts: now - 7200e3 });
    ffAuthFails.set('10.0.0.3', { count: 2, until: now + 60000, ts: now });
    ffRateWindow.set('10.0.0.1', { count: 15, resetAt: now - 500 });
    ffRateWindow.set('10.0.0.3', { count: 5, resetAt: now + 30000 });

    cleanupFrameFlowRateLimits(now);

    assert.equal(ffAuthFails.has('10.0.0.1'), false);
    assert.equal(ffAuthFails.has('10.0.0.2'), false);
    assert.equal(ffAuthFails.has('10.0.0.3'), true);
    assert.equal(ffRateWindow.has('10.0.0.1'), false);
    assert.equal(ffRateWindow.has('10.0.0.3'), true);
  } finally {
    await new Promise((resolve) => whServer.close(resolve));
  }
});

test('14. Punkt 5: Roller (admin/tekniker), TOTP 2FA-flöde och sökbar revisionslogg (/api/audit)', async () => {
  // 1. Logga in som admin
  const adminLogin = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'testadmin', password: 'testpassword12345' }),
  });
  const adminCookie = (adminLogin.headers.get('set-cookie') || '').split(';')[0];
  const adminHeaders = {
    'Content-Type': 'application/json',
    Origin: baseUrl,
    Cookie: adminCookie,
  };

  // 2. Skydd av sista admin-kontot (får inte nedgraderas eller raderas)
  const demoteSelf = await fetch(`${baseUrl}/api/users/role`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ username: 'testadmin', role: 'tekniker' }),
  });
  assert.equal(demoteSelf.status, 400);

  const deleteSelf = await fetch(`${baseUrl}/api/users/remove`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ username: 'testadmin' }),
  });
  assert.equal(deleteSelf.status, 400);

  // 3. Skapa ett tekniker-konto
  const addTech = await fetch(`${baseUrl}/api/users/add`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      username: 'tekniker1',
      password: 'teknikerpassword123',
      role: 'tekniker',
    }),
  });
  assert.equal(addTech.status, 200);
  const addTechJson = await addTech.json();
  assert.equal(addTechJson.success, true);
  const techUser = addTechJson.users.find((u) => u.username === 'tekniker1');
  assert.equal(techUser.role, 'tekniker');

  // 4. Logga in som tekniker1 och verifiera behörighetsgränser
  const techLogin = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'tekniker1', password: 'teknikerpassword123' }),
  });
  assert.equal(techLogin.status, 200);
  const techCookie = (techLogin.headers.get('set-cookie') || '').split(';')[0];
  const techHeaders = {
    'Content-Type': 'application/json',
    Origin: baseUrl,
    Cookie: techCookie,
  };

  const meRes = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: techCookie } });
  const meJson = await meRes.json();
  assert.equal(meJson.user, 'tekniker1');
  assert.equal(meJson.role, 'tekniker');
  assert.equal(meJson.totpEnabled, false);

  // Tekniker ska se maskerad ingestToken i GET /api/settings
  const getSetRes = await fetch(`${baseUrl}/api/settings`, { headers: { Cookie: techCookie } });
  const getSetJson = await getSetRes.json();
  assert.equal(getSetJson.frameflow.ingestToken, '••••••••');

  // Tekniker FÅR INTE spara systeminställningar, skapa användare eller exportera backup (403)
  const forbidSet = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: techHeaders,
    body: JSON.stringify({ nodes: [] }),
  });
  assert.equal(forbidSet.status, 403);

  const forbidAddUser = await fetch(`${baseUrl}/api/users/add`, {
    method: 'POST',
    headers: techHeaders,
    body: JSON.stringify({ username: 'hacker', password: 'hackerpassword123' }),
  });
  assert.equal(forbidAddUser.status, 403);

  const forbidBackup = await fetch(`${baseUrl}/api/backup/export`, {
    headers: { Cookie: techCookie },
  });
  assert.equal(forbidBackup.status, 403);

  // Tekniker FÅR publicera och avsluta driftärenden
  const techPub = await fetch(`${baseUrl}/api/publish`, {
    method: 'POST',
    headers: techHeaders,
    body: JSON.stringify({
      id: 'tech-inc-1',
      domain: 'stadsnat',
      kind: 'incident',
      statusType: 'Pågående Störning',
      area: 'Vallsta',
      faultType: 'Hårdvarufel',
      services: 'Internet',
      startDate: '2026-10-30',
      startTime: '13:00',
    }),
  });
  assert.equal(techPub.status, 200);

  const techClose = await fetch(`${baseUrl}/api/close`, {
    method: 'POST',
    headers: techHeaders,
    body: JSON.stringify({
      id: 'tech-inc-1',
      endDate: '2026-10-30',
      endTime: '13:45',
      note: 'Linjekort utbytt av tekniker.',
    }),
  });
  assert.equal(techClose.status, 200);

  // 5. Testa hela TOTP 2FA-flödet (setup -> enable -> login-krav -> disable)
  const setupRes = await fetch(`${baseUrl}/api/users/totp/setup`, {
    method: 'POST',
    headers: techHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(setupRes.status, 200);
  const setupJson = await setupRes.json();
  assert.equal(setupJson.success, true);
  assert.ok(setupJson.secret.length >= 16);
  assert.match(setupJson.otpauthUrl, /^otpauth:\/\/totp\//);

  const validCode = authz.totp.generate(setupJson.secret);
  const enableRes = await fetch(`${baseUrl}/api/users/totp/enable`, {
    method: 'POST',
    headers: techHeaders,
    body: JSON.stringify({ token: validCode }),
  });
  assert.equal(enableRes.status, 200);

  // Inloggning utan TOTP-kod ska nu kräva 2FA (requireTotp: true)
  const loginNoTotp = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'tekniker1', password: 'teknikerpassword123' }),
  });
  assert.equal(loginNoTotp.status, 200);
  const loginNoTotpJson = await loginNoTotp.json();
  assert.equal(loginNoTotpJson.success, false);
  assert.equal(loginNoTotpJson.requireTotp, true);

  // Inloggning med felaktig TOTP-kod ska ge 401
  const wrongCode = validCode === '000000' ? '999999' : '000000';
  const loginBadTotp = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'tekniker1', password: 'teknikerpassword123', totp: wrongCode }),
  });
  assert.equal(loginBadTotp.status, 401);

  // Inloggning med rätt TOTP-kod ska lyckas
  const loginGoodTotp = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'tekniker1', password: 'teknikerpassword123', totp: validCode }),
  });
  assert.equal(loginGoodTotp.status, 200);
  const loginGoodTotpJson = await loginGoodTotp.json();
  assert.equal(loginGoodTotpJson.success, true);

  // Stäng av 2FA med lösenordsbekräftelse
  const disableRes = await fetch(`${baseUrl}/api/users/totp/disable`, {
    method: 'POST',
    headers: techHeaders,
    body: JSON.stringify({ currentPassword: 'teknikerpassword123' }),
  });
  assert.equal(disableRes.status, 200);

  // 6. Verifiera /api/audit (revisionslogg med kategorifilter och fritextsökning)
  const auditAuthRes = await fetch(`${baseUrl}/api/audit?category=auth&limit=50`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(auditAuthRes.status, 200);
  const auditAuthJson = await auditAuthRes.json();
  assert.equal(auditAuthJson.success, true);
  assert.ok(auditAuthJson.entries.some((e) => e.action === 'totp_enabled' && e.by === 'tekniker1'));
  assert.ok(auditAuthJson.entries.some((e) => e.action === 'login_totp_failed' && e.user === 'tekniker1'));

  const auditSearchRes = await fetch(`${baseUrl}/api/audit?q=tech-inc-1&category=incidents`, {
    headers: { Cookie: adminCookie },
  });
  const auditSearchJson = await auditSearchRes.json();
  assert.equal(auditSearchJson.success, true);
  assert.ok(auditSearchJson.entries.length >= 2);
  assert.ok(auditSearchJson.entries.every((e) => e.id === 'tech-inc-1'));
});
