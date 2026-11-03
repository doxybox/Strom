'use strict';
/* HAN-leser: live-kort og dialog for å finne og koble til lesere. */
(function () {
  const $ = (id) => document.getElementById(id);
  const n1 = (v) => v.toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const n0 = (v) => Math.round(v).toLocaleString('nb-NO');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let live = null;
  let pendingDev = null;

  window.stromLive = () => live;

  // ---- live-kort ----
  function renderLive() {
    const card = $('live');
    if (!live || !live.tilkoblet) { card.hidden = true; return; }
    card.hidden = false;
    const d = live.data;
    card.classList.toggle('err', !!live.feil);
    $('live-err').textContent = live.feil || '';
    $('live-src').textContent = live.enhet ? `Live fra ${live.enhet.navn}` : 'Live fra HAN-leser';
    if (!d) { $('live-kw').textContent = '–'; $('live-h').textContent = '–'; $('live-d').textContent = '–'; return; }
    $('live-kw').textContent = `${n1(d.kw)} kW`;
    $('live-h').textContent = d.timeKwh != null ? `${n1(d.timeKwh)} kWh` : '–';
    let dag = d.idagKwh != null ? `${n1(d.idagKwh)} kWh` : '–';
    const S = window.stromState && window.stromState();
    if (S && d.idagKwh != null && S.todayStats && S.quarters) {
      const q = S.quarters.find((x) => x.s <= Date.now() && Date.now() < x.e);
      const rest = Math.max(0, d.idagKwh - S.todayStats.kwh);
      const kr = S.todayStats.kr + (q ? rest * q.total / 100 : 0);
      dag += ` · ${n0(kr)} kr`;
    }
    $('live-d').textContent = dag;
  }

  // ---- dialog ----
  function openModal() {
    $('han-modal').hidden = false;
    renderModal();
    if (!(live && live.tilkoblet) && !$('han-list').children.length) scan();
  }
  function closeModal() { $('han-modal').hidden = true; }

  function renderModal() {
    const c = live && live.tilkoblet;
    $('han-connected').hidden = !c;
    $('han-search').hidden = !!c;
    if (c && live.enhet) {
      $('han-c-navn').textContent = `✓ ${live.enhet.navn}`;
      $('han-c-info').textContent = `${live.enhet.maaler || ''} · ${live.enhet.ip}${live.feil ? ` · ${live.feil}` : ''}`;
    }
  }

  function showList(list) {
    $('han-list').innerHTML = list.map((d, i) => `
      <button class="han-dev" data-i="${i}">
        <b>${esc(d.navn)}</b>
        <span class="muted small">${d.needsAuth ? 'Krever passord · ' : ''}${esc(d.maaler || '')}${d.maaler ? ' · ' : ''}${esc(d.hostname || d.ip)}</span>
      </button>`).join('');
    $('han-list').querySelectorAll('.han-dev').forEach((b) => b.addEventListener('click', () => connect(list[Number(b.dataset.i)])));
  }

  async function scan() {
    $('han-scan').disabled = true;
    $('han-progress').hidden = false;
    $('han-progress-fill').style.width = '0%';
    $('han-status').textContent = 'Søker på hjemmenettet …';
    $('han-auth').hidden = true;
    const r = await window.strom.hanScan();
    $('han-scan').disabled = false;
    $('han-progress').hidden = true;
    if (r.feil) { $('han-status').textContent = r.feil; return; }
    const list = r.enheter || [];
    showList(list);
    if (!list.length) {
      $('han-status').textContent = r.nett && r.nett.length
        ? `Fant ingen HAN-leser på ${r.nett.map((x) => `${x}.x`).join(', ')}. Sjekk at leseren er koblet til samme wifi som PC-en.`
        : 'PC-en ser ikke ut til å være koblet til et hjemmenett.';
    } else {
      $('han-status').textContent = list.length === 1 ? 'Fant én HAN-leser. Trykk på den for å koble til.' : `Fant ${list.length} HAN-lesere. Velg din.`;
    }
  }

  async function connect(dev, auth) {
    if (dev.needsAuth && !auth) {
      pendingDev = dev;
      $('han-auth').hidden = false;
      $('han-user').focus();
      return;
    }
    $('han-status').textContent = `Kobler til ${dev.navn} …`;
    const r = await window.strom.hanConnect(dev, auth || null);
    if (r.ok) {
      $('han-status').textContent = '';
      $('han-auth').hidden = true;
      $('han-list').innerHTML = '';
      return;
    }
    $('han-status').textContent = r.feil;
    if (r.auth) { pendingDev = dev; $('han-auth').hidden = false; }
  }

  // ---- hendelser ----
  window.strom.onLive((d) => {
    live = d;
    renderLive();
    if (!$('han-modal').hidden) renderModal();
    if (window.stromRender) window.stromRender();
  });
  window.strom.onShowHan(openModal);
  window.strom.onHanProgress((a, b) => { $('han-progress-fill').style.width = `${Math.round((a / b) * 100)}%`; });
  $('han-close').addEventListener('click', closeModal);
  $('han-modal').addEventListener('click', (e) => { if (e.target === $('han-modal')) closeModal(); });
  $('han-scan').addEventListener('click', scan);
  $('btn-han').addEventListener('click', openModal);
  $('han-disconnect').addEventListener('click', () => { window.strom.hanDisconnect(); });
  $('han-auth-go').addEventListener('click', () => {
    if (pendingDev) connect(pendingDev, { bruker: $('han-user').value.trim(), passord: $('han-pass').value });
  });
  $('han-ip-go').addEventListener('click', async () => {
    const host = $('han-ip').value.trim();
    if (!host) return;
    $('han-status').textContent = `Prøver ${host} …`;
    const r = await window.strom.hanProbe(host, null);
    if (r.feil) { $('han-status').textContent = r.feil; return; }
    showList(r.enheter);
    $('han-status').textContent = 'Fant leseren. Trykk på den for å koble til.';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  window.strom.hanLiveRequest();
}());
