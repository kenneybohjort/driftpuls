// Modul: Genererade kanaler (SMS, Driftportal Webb, Sociala Medier och Intern Rapport)

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

  const closingText = done ? 'Felet är åtgärdat och tjänsterna fungerar igen.' : planned ? 'Arbetet utförs enligt plan.' : update ? 'Vi arbetar vidare med felet och återkommer vid ny information.' : 'Felsökning pågår aktivt.';
  const times = done ? `Åtgärdat: ${now}` : planned ? `Planerad start: ${start}\nPlanerat slut: ${ettr}` : `Starttid: ${start}\nBeräknad klartid: ${ettr}`;
  const web = `${label} - ${area.toUpperCase()}\n\nTyp: ${f.faultType}\nTjänster: ${f.services}\n${times}\n${f.techDetails ? `\nLägesrapport: ${f.techDetails}\n` : ''}\n${closingText}`;

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
