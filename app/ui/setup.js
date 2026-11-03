'use strict';
/* Oppsett: prisområde, nettselskap og strømavtale. */
(function () {
  const $ = (id) => document.getElementById(id);
  const ZONES = [
    { id: 'NO1', navn: 'Øst-Norge', info: 'Oslo, Akershus, Østfold, Buskerud, Innlandet' },
    { id: 'NO2', navn: 'Sør-Norge', info: 'Telemark, Vestfold, Agder, Rogaland' },
    { id: 'NO3', navn: 'Midt-Norge', info: 'Trøndelag, Møre og Romsdal' },
    { id: 'NO4', navn: 'Nord-Norge', info: 'Nordland, Troms, Finnmark' },
    { id: 'NO5', navn: 'Vest-Norge', info: 'Bergen og store deler av Vestland' },
  ];
  const NORD = new Set(['Nordland', 'Troms', 'Finnmark']);

  let data = null;
  let step = 1;
  const v = {};
  let onDone = null;
  const ore = (x) => x.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const kr0 = (x) => Math.round(x).toLocaleString('nb-NO');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function open(done, force) {
    onDone = done;
    data = await window.strom.setupData();
    if (!force && data.cfg.oppsett_ferdig) { if (done) done(false); return false; }
    Object.assign(v, data.cfg);
    if (!v.nettselskap_id) v.nettselskap_id = null;
    step = 1;
    document.body.classList.add('setup-mode');
    $('setup').hidden = false;
    $('setup-back').textContent = data.cfg.oppsett_ferdig ? 'Avbryt' : 'Tilbake';
    renderStep();
    return true;
  }

  function close() {
    document.body.classList.remove('setup-mode');
    $('setup').hidden = true;
    if (onDone) onDone(true);
  }

  function renderStep() {
    document.querySelectorAll('.step').forEach((el) => { el.hidden = Number(el.dataset.step) !== step; });
    document.querySelectorAll('.steps .dot').forEach((d) => d.classList.toggle('on', Number(d.dataset.s) <= step));
    $('setup-stepinfo').textContent = `Steg ${step} av 3`;
    $('setup-back').style.visibility = step === 1 && !data.cfg.oppsett_ferdig ? 'hidden' : 'visible';
    $('setup-back').textContent = step === 1 ? 'Avbryt' : 'Tilbake';
    $('setup-next').textContent = step === 3 ? 'Ferdig – vis strømprisen' : 'Neste';
    if (step === 1) renderZones();
    if (step === 2) renderCompanies();
    if (step === 3) renderAgreement();
    validate();
  }

  function validate() {
    let ok = true;
    if (step === 1) ok = !!v.prissone;
    if (step === 2) ok = !!v.nettselskap_id;
    if (step === 3 && v.ordning === 'fastpris') ok = Number($('lev-fastpris').value) > 0;
    $('setup-next').disabled = !ok;
  }

  // ---- steg 1 ----
  function renderZones() {
    $('zones').innerHTML = ZONES.map((z) => `
      <button class="zone ${v.prissone === z.id ? 'sel' : ''}" data-z="${z.id}">
        <span class="zid">${z.id}</span><b>${z.navn}</b><span class="muted small">${z.info}</span>
      </button>`).join('');
    $('zones').querySelectorAll('.zone').forEach((b) => b.addEventListener('click', () => {
      if (v.prissone !== b.dataset.z) {
        v.prissone = b.dataset.z;
        const s = data.selskaper.find((x) => x.id === v.nettselskap_id);
        if (s && !s.soner.includes(v.prissone)) v.nettselskap_id = null;
      }
      renderZones();
      validate();
    }));
  }

  // ---- steg 2 ----
  function renderCompanies() {
    const q = $('ns-search').value.trim().toLowerCase();
    const all = $('ns-all').checked || q.length > 1;
    let list = data.selskaper.filter((s) => all || s.soner.includes(v.prissone) || !s.soner.length);
    if (q) list = list.filter((s) => s.navn.toLowerCase().includes(q) || s.fylker.join(' ').toLowerCase().includes(q));
    list.sort((a, b) => (b.kunder || 0) - (a.kunder || 0) || a.navn.localeCompare(b.navn, 'nb'));
    const rows = list.map((s) => `
      <button class="ns ${v.nettselskap_id === s.id ? 'sel' : ''}" data-id="${esc(s.id)}">
        <b>${esc(s.navn)}</b><span class="muted small">${esc(s.fylker.join(', ') || s.soner.join(', '))}</span>
      </button>`);
    rows.push(`<button class="ns ${v.nettselskap_id === 'egen' ? 'sel' : ''}" data-id="egen">
        <b>Finner ikke mitt – legg inn priser selv</b><span class="muted small">Skriv inn nettleien fra nettselskapets nettside</span></button>`);
    $('ns-list').innerHTML = rows.join('');
    $('ns-list').querySelectorAll('.ns').forEach((b) => b.addEventListener('click', () => pickCompany(b.dataset.id)));
    const sel = $('ns-list').querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    $('avgiftssone').value = v.avgiftssone || 'sor';
    $('avg-row').hidden = !(v.prissone === 'NO4' || v.prissone === 'NO3' || v.avgiftssone !== 'sor');
    $('egen-dag').value = v.egen_dag_ore; $('egen-natt').value = v.egen_natt_ore; $('egen-kap').value = v.egen_kapasitet_kr;
    $('ns-egen').hidden = v.nettselskap_id !== 'egen';
    renderPreview();
  }

  function pickCompany(id) {
    v.nettselskap_id = id;
    const s = data.selskaper.find((x) => x.id === id);
    if (s && s.fylker.length) {
      const nordOnly = s.fylker.every((f) => NORD.has(f));
      if (nordOnly && v.avgiftssone === 'sor') v.avgiftssone = 'nord';
      if (!s.fylker.some((f) => NORD.has(f))) v.avgiftssone = 'sor';
    }
    renderCompanies();
    validate();
  }

  async function renderPreview() {
    const box = $('ns-preview');
    const id = v.nettselskap_id;
    if (!id || id === 'egen') { box.hidden = true; return; }
    const s = data.selskaper.find((x) => x.id === id);
    const t = await window.strom.tariffSummary(id, v.avgiftssone);
    if (v.nettselskap_id !== id) return;
    if (!t) { box.hidden = false; box.innerHTML = '<p class="muted small">Fant ingen gjeldende priser for dette selskapet.</p>'; return; }
    const per = t.perioder.map((p) => `<li><span>${esc(p.navn === 'Grunnpris' && t.perioder.length > 1 ? 'Ellers' : p.navn)}${p.tid ? ` <em>${esc(p.tid)}</em>` : ''}</span><b>${ore(p.ore)} øre</b></li>`).join('');
    const trinn = t.trinn.slice(0, 5).map((x) => `<li><span>${x.fra}–${x.til ?? ''} kW</span><b>${kr0(x.kr)} kr/mnd</b></li>`).join('');
    const [y, m, d] = t.gyldig_fra.split('-');
    box.hidden = false;
    box.innerHTML = `
      <div class="pv-head"><b>${esc(s.navn)}</b><span class="muted small">priser fra ${d}.${m}.${y}</span></div>
      <div class="pv-cols">
        <div><p class="label">Energiledd inkl. avgifter</p><ul>${per}</ul></div>
        <div><p class="label">Kapasitetsledd</p><ul>${trinn}</ul></div>
      </div>
      ${t.metode && t.metode !== 'TRE_DØGNMAX_MND' ? '<p class="muted small">Dette selskapet beregner kapasitet på en annen måte. Appen bruker en tilnærming.</p>' : ''}
      <p class="muted small">Stemmer ikke prisene? <a href="${esc(s.kilde)}" target="_blank">Sjekk nettselskapets side</a></p>`;
  }

  // ---- steg 3 ----
  function renderAgreement() {
    document.querySelectorAll('#ordning .choice').forEach((b) => b.classList.toggle('sel', b.dataset.v === v.ordning));
    $('spot-fields').hidden = v.ordning === 'norgespris';
    const fp = v.ordning === 'fastpris';
    $('paaslag-wrap').hidden = fp;
    $('fastpris-wrap').hidden = !fp;
    $('lev-chips').hidden = fp;
    $('lev-fastpris').value = data.cfg.ordning === 'fastpris' || v._fpSatt ? (v.fastpris_ore_inkl_mva ?? '') : '';
    $('fp-stotte-row').hidden = !fp;
    $('fp-stotte').checked = v.fastpris_stotte !== false;
    $('lev-hint').textContent = fp
      ? 'Skriv inn kraftprisen fra avtalen din (øre/kWh inkl. mva) og eventuelt månedsbeløp. Usikker på strømstøtten? Se etter linjen «Strømstøtte» på fakturaen.'
      : 'Påslag og månedsbeløp står i avtalen din (inkl. mva). Vibb har 0 påslag og 0 kr i måneden.';
    $('lev-navn').value = v.stromleverandor || '';
    $('lev-paaslag').value = v.kraft_paaslag_ore_inkl_mva ?? 0;
    $('lev-fast').value = v.kraft_fast_kr_per_mnd ?? 0;
    markChip();
    const np = v.avgiftssone === 'sor' ? '50' : '40';
    validate();
    document.querySelector('#ordning .choice[data-v="norgespris"] span').textContent = `Fast ${np} øre/kWh for strømmen. Meldes på hos Elhub.`;
  }
  function markChip() {
    const n = $('lev-navn').value.trim(); const p = Number($('lev-paaslag').value); const f = Number($('lev-fast').value);
    document.querySelectorAll('#lev-chips .pill').forEach((c) => {
      const match = c.dataset.p !== undefined ? (c.dataset.lev === n && Number(c.dataset.p) === p && Number(c.dataset.f) === f) : !['Vibb', 'Vibb+'].includes(n);
      c.classList.toggle('sel', match);
    });
  }

  function collect() {
    if (step === 2) {
      v.avgiftssone = $('avgiftssone').value;
      v.egen_dag_ore = Number($('egen-dag').value) || v.egen_dag_ore;
      v.egen_natt_ore = Number($('egen-natt').value) || v.egen_natt_ore;
      v.egen_kapasitet_kr = Number($('egen-kap').value) || v.egen_kapasitet_kr;
    }
    if (step === 3) {
      v.stromleverandor = $('lev-navn').value.trim();
      v.kraft_paaslag_ore_inkl_mva = Number($('lev-paaslag').value) || 0;
      v.kraft_fast_kr_per_mnd = Number($('lev-fast').value) || 0;
      if (v.ordning === 'fastpris') { v.fastpris_ore_inkl_mva = Number($('lev-fastpris').value) || v.fastpris_ore_inkl_mva; v.fastpris_stotte = $('fp-stotte').checked; }
    }
  }

  // ---- hendelser ----
  $('ns-search').addEventListener('input', renderCompanies);
  $('ns-all').addEventListener('change', renderCompanies);
  $('avgiftssone').addEventListener('change', () => { v.avgiftssone = $('avgiftssone').value; renderPreview(); });
  document.querySelectorAll('#ordning .choice').forEach((b) => b.addEventListener('click', () => { v.ordning = b.dataset.v; collect(); renderAgreement(); }));
  document.querySelectorAll('#lev-chips .pill').forEach((c) => c.addEventListener('click', () => {
    if (c.dataset.p !== undefined) {
      $('lev-navn').value = c.dataset.lev; $('lev-paaslag').value = c.dataset.p; $('lev-fast').value = c.dataset.f;
    } else {
      if (['Vibb', 'Vibb+'].includes($('lev-navn').value)) $('lev-navn').value = '';
      $('lev-navn').focus();
    }
    markChip();
  }));
  ['lev-navn', 'lev-paaslag', 'lev-fast'].forEach((id) => $(id).addEventListener('input', markChip));
  $('lev-fastpris').addEventListener('input', () => { v._fpSatt = true; v.fastpris_ore_inkl_mva = Number($('lev-fastpris').value) || ''; validate(); });

  $('setup-next').addEventListener('click', () => {
    collect();
    if (step < 3) { step++; renderStep(); return; }
    window.strom.saveSetup({ ...v });
    close();
  });
  $('setup-back').addEventListener('click', () => {
    collect();
    if (step === 1) { if (data.cfg.oppsett_ferdig) close(); return; }
    step--; renderStep();
  });

  window.stromSetup = { open };
}());
