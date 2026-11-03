'use strict';
/* Tegner opp appen fra tilstanden hovedprosessen sender. */

const $ = (id) => document.getElementById(id);
const HOUR = 3600 * 1000;
const MND = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
const COLORS = { green: '#4fc27f', yellow: '#e9b649', red: '#ec6b57', blue: '#7aa7ff', muted: '#98a0ad', line: '#2e333d', faint: '#6b7280' };

let S = null;
let dayIdx = 0;
let weekMode = false;
const wdFmt = new Intl.DateTimeFormat('nb-NO', { timeZone: 'UTC', weekday: 'short' });
const MND3 = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
function weekDays() {
  if (S && S.week && S.week.length) return S.week;
  return S && S.todaySeries ? [{ date: S.today, prognose: false, series: S.todaySeries }] : [];
}
function curDay() { const w = weekDays(); if (dayIdx >= w.length) dayIdx = 0; return w[dayIdx]; }
/** "I dag 3. nov", "I morgen 4. nov", "Ons 5. nov" */
function dagNavn(date, idx, kort = false) {
  const [y, m, d] = date.split('-').map(Number);
  const dato = `${d}. ${MND3[m - 1]}`;
  if (idx === 0) return kort ? 'I dag' : `I dag ${dato}`;
  if (idx === 1) return kort ? 'I morgen' : `I morgen ${dato}`;
  const wd = wdFmt.format(new Date(Date.UTC(y, m - 1, d))).replace('.', '');
  return kort ? `${wd[0].toUpperCase()}${wd.slice(1)} ${d}.` : `${wd[0].toUpperCase()}${wd.slice(1)} ${dato}`;
}
let hoverIdx = null;
window.stromState = () => S;
window.stromRender = () => { if (S && S.todaySeries) renderUsage(); };

// ---- formatering ----
const hourFmt = new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', hourCycle: 'h23' });
const hmFmt = new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hh = (ms) => hourFmt.format(ms).padStart(2, '0');
const hm = (ms) => hmFmt.format(ms).replace('.', ':');
const kr = (ore, d = 2) => (ore / 100).toLocaleString('nb-NO', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 0) => v.toLocaleString('nb-NO', { minimumFractionDigits: d, maximumFractionDigits: d });
const dayLabel = (dateStr) => { const [, m, d] = dateStr.split('-'); return `${d}.${m}`; };

function terciles(series) {
  const v = series.map((x) => x.total).sort((a, b) => a - b);
  if (!v.length) return [0, 0];
  return [v[Math.floor(v.length / 3)], v[Math.floor((2 * v.length) / 3)]];
}
function isFlat(series) {
  if (!series || !series.length) return false;
  const v = series.map((x) => x.total);
  return Math.max(...v) - Math.min(...v) < 2;
}
const avgOf = (arr, k) => arr.reduce((a, c) => a + c[k], 0) / arr.length;
function level(total, t) { return total <= t[0] ? 'green' : total <= t[1] ? 'yellow' : 'red'; }

function futureSeries() {
  const nowH = Math.floor(Date.now() / HOUR) * HOUR;
  return (S.todaySeries || []).concat(S.tomorrowSeries || []).filter((x) => x.t >= nowH);
}

function cheapestWindow(series, n) {
  if (series.length < n) return null;
  let best = 0; let bestSum = Infinity;
  for (let i = 0; i + n <= series.length; i++) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += series[j].total;
    if (s < bestSum) { bestSum = s; best = i; }
  }
  return { start: series[best].t, end: series[best].t + n * HOUR, avg: bestSum / n };
}

// ---- tegning ----
function render() {
  if (!S) return;
  const st = $('status');
  if (!S.todaySeries) {
    $('now-breakdown').textContent = S.error || 'Henter priser …';
    st.textContent = `v${S.version || ''}`;
    return;
  }
  renderNow();
  renderNext();
  renderChartHeader();
  drawChart();
  renderUsage();

  const q = currentQuarter();
  const parts = [`Oppdatert ${hm(S.lastFetch)}`];
  if (q) parts.push(`ny pris kl. ${hm(q.e)}`);
  if (S.selskap) parts.push(S.selskap.replace(/ AS$/, ''));
  parts.push(`v${S.version}`);
  st.textContent = S.error ? S.error : parts.join(' · ');
  st.classList.toggle('err', !!S.error);
}

function currentQuarter() {
  const now = Date.now();
  return (S.quarters || []).find((q) => q.s <= now && now < q.e) || null;
}

function renderNow() {
  const q = currentQuarter();
  const t = terciles(S.todaySeries);
  const priceEl = $('now-price');
  const badge = $('now-badge');
  if (!q) {
    priceEl.textContent = '–';
    priceEl.style.color = '';
    $('now-breakdown').textContent = 'Ingen pris for dette tidspunktet ennå';
    badge.textContent = '';
    return;
  }
  $('now-when').textContent = `Strømpris nå · kl. ${hm(q.s)}–${hm(q.e)}`;
  if (S.norgespris) {
    priceEl.textContent = kr(q.total);
    priceEl.style.color = COLORS.blue;
    badge.className = 'badge blue';
    badge.textContent = S.avtaleNavn || 'Norgespris';
    const diff = q.altTotal - q.total;
    let h = `${S.avtaleNavn || 'Norgespris'} <b>${kr(q.kraft)}</b> + nettleie og avgifter <b>${kr(q.nett)}</b><br>`;
    if (q.stotte > 0) h += `<span class="support">Strømstøtte −${kr(q.stotte)} kr/kWh${q.total < 0 ? ' – høyere enn fastprisen, så dere tjener på å bruke strøm nå' : ''}</span><br>`;
    h += diff >= 0
      ? `<span class="support">Med spotpris: ${kr(q.altTotal)} · dere sparer ${kr(diff)} kr/kWh nå</span>`
      : `<span class="warnc">Med spotpris: ${kr(q.altTotal)} · spot er ${kr(-diff)} kr/kWh billigere nå</span>`;
    // Samme tall som strømleverandørens app: bare kraftprisen, timesnitt, inkl. mva, uten strømstøtte
    const nowH = Math.floor(Date.now() / HOUR) * HOUR;
    const hr = (S.todaySeries || []).find((x) => x.t === nowH);
    const lev = String(S.leverandor || '').replace(/\+$/, '').trim();
    const hvor = lev && lev.toLowerCase() !== 'annen' ? `Som i ${lev}-appen` : 'Som i strømselskapets app';
    if (hr) h += `<br><span class="vibb">${hvor} (kl. ${hh(hr.t)}–${hh(hr.t + HOUR)}): ${S.avtaleNavn || 'Norgespris'} ${num(hr.kraft, 2)} øre · spotpris ${num(hr.spot * 100 * (S.mva || 1.25), 2)} øre</span>`;
    $('now-breakdown').innerHTML = `${h}<br>Totalpris inkl. nettleie, avgifter og mva`;
    return;
  }
  const lv = level(q.total, t);
  priceEl.textContent = kr(q.total);
  priceEl.style.color = COLORS[lv];
  badge.className = `badge ${lv}`;
  badge.textContent = { green: 'Billig nå', yellow: 'Middels', red: 'Dyrt nå' }[lv];
  $('now-when').textContent = `Strømpris nå · kl. ${hm(q.s)}–${hm(q.e)}`;
  const label = S.norgespris ? (S.avtaleNavn || 'Norgespris') : 'Strøm';
  let html = `${label} <b>${kr(q.kraft)}</b> + nettleie og avgifter <b>${kr(q.nett)}</b>`;
  if (q.stotte > 0) html += `<br><span class="support">Strømstøtte −${kr(q.stotte)} kr/kWh</span>`;
  html += '<br>Alt inkl. mva';
  $('now-breakdown').innerHTML = html;
}

function renderNext() {
  if (S.norgespris && isFlat(S.todaySeries)) {
    const q = currentQuarter();
    const d = S.todaySeries;
    const altAvg = avgOf(d, 'altTotal'); const avg = avgOf(d, 'total');
    const t = terciles(d.map((x) => ({ total: x.altTotal })));
    const cells = [];
    if (q) {
      cells.push(['Spot nå', kr(q.altTotal), level(q.altTotal, t)]);
      cells.push(['Spart nå', kr(q.altTotal - q.total), q.altTotal >= q.total ? 'green' : 'yellow']);
    }
    cells.push(['Spot i dag', kr(altAvg), '']);
    cells.push(['Spart i dag', kr(altAvg - avg), altAvg >= avg ? 'green' : 'yellow']);
    $('next').innerHTML = cells.map(([l, v, c]) => `<div class="chip"><span class="label">${l}</span><span class="v ${c}">${v}</span></div>`).join('');
    return;
  }
  const fut = futureSeries().slice(1, 5);
  const t = terciles(S.todaySeries.concat(S.tomorrowSeries || []));
  $('next').innerHTML = fut.map((x) => `
    <div class="chip"><span class="label">kl. ${hh(x.t)}</span>
    <span class="v ${level(x.total, t)}">${kr(x.total)}</span></div>`).join('');
}

function renderChartHeader() {
  const days = weekDays();
  const day = curDay();
  $('btn-week').classList.toggle('active', weekMode);
  $('day-prev').disabled = weekMode || dayIdx === 0;
  $('day-next').disabled = weekMode || dayIdx >= days.length - 1;
  $('day-label').textContent = weekMode ? `Neste ${days.length} dager` : dagNavn(day.date, dayIdx);
  $('day-badge').hidden = weekMode || !day.prognose;

  if (weekMode) {
    const kjente = days.filter((d) => !d.prognose).length;
    const forste = days[kjente];
    $('day-summary').textContent = forste ? `Fra ${dagNavn(forste.date, kjente, true).toLowerCase()} er prisene anslag. Trykk på en dag.` : 'Trykk på en dag for detaljer.';
  } else {
    const series = day.series;
    if (series.length && S.norgespris) {
      const altAvg = avgOf(series, 'altTotal'); const avg = avgOf(series, 'total');
      $('day-summary').innerHTML = `<span class="legend bars"></span>Spot m/støtte ${day.prognose ? '~' : ''}${kr(altAvg)} · <span class="legend line"></span>${S.avtaleNavn || 'Norgespris'} ${kr(avg)} · ${altAvg >= avg ? `sparer ${day.prognose ? '~' : ''}${kr(altAvg - avg)}` : `spot ${kr(avg - altAvg)} lavere`}`;
    } else if (series.length) {
      const avg = series.reduce((a, c) => a + c.total, 0) / series.length;
      const mn = series.reduce((a, c) => (c.total < a.total ? c : a));
      const mx = series.reduce((a, c) => (c.total > a.total ? c : a));
      const p = day.prognose ? '~' : '';
      $('day-summary').textContent = `Snitt ${p}${kr(avg)} · billigst ${p}${kr(mn.total)} kl. ${hh(mn.t)} · dyrest ${p}${kr(mx.total)} kl. ${hh(mx.t)}`;
    } else {
      $('day-summary').textContent = '';
    }
    if (day.prognose && !S.norgespris) $('day-summary').textContent += dayIdx === 1 ? ' · ekte priser kommer ca. kl. 13' : ' · anslag, kan avvike mye';
  }
  const w = cheapestWindow(futureSeries(), 3);
  $('cheap').classList.toggle('neutral', !!(S.norgespris && isFlat(S.todaySeries)));
  if (S.norgespris && isFlat(S.todaySeries)) {
    $('cheap').textContent = '⚡ Fast pris hele døgnet – unngå at mye går samtidig.';
  } else if (w) {
    const tomorrow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(w.start) !== S.today;
    $('cheap').textContent = `⚡ Billigste 3 timer fremover: ${tomorrow ? 'i morgen ' : ''}kl. ${hh(w.start)}–${hh(w.end)} · snitt ${kr(w.avg)} kr/kWh`;
  } else {
    $('cheap').textContent = '';
  }
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.round(r.width));
  const h = Math.max(10, Math.round(r.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function roundRectTop(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

let chartGeom = null;
function drawChart() {
  const canvas = $('chart');
  const { ctx, w, h } = setupCanvas(canvas);
  if (weekMode) { drawWeek(); return; }
  const day = curDay();
  const series = day ? day.series : [];
  const prog = day && day.prognose;
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  ctx.font = `${Math.round(fs * 0.7)}px "Segoe UI", system-ui, sans-serif`;
  if (!series.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'center';
    ctx.fillText('Ingen priser', w / 2, h / 2);
    chartGeom = null;
    return;
  }
  const np = !!S.norgespris;
  const val = (x) => (np ? x.altTotal : x.total);
  const t = terciles(series.map((x) => ({ total: val(x) })));
  const max = Math.max(...series.map((x) => Math.max(val(x), x.total)));
  const axisW = Math.round(fs * 2.2);
  const labH = Math.round(fs * 1.15);
  const plotX = axisW; const plotW = w - axisW; const plotH = h - labH - 4; const top = 4;
  // "pen" maks for y-akse
  const stepKr = max / 100 > 2 ? 0.5 : 0.25;
  const yMax = Math.ceil((max / 100) / stepKr) * stepKr * 100 || 100;

  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= yMax + 0.01; v += stepKr * 100) {
    const y = top + plotH - (v / yMax) * plotH;
    ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotX, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = COLORS.faint;
    ctx.fillText(kr(v, v % 100 === 0 ? 0 : 2), axisW - 6, y);
  }

  const n = series.length;
  const bw = plotW / n;
  const gap = Math.max(1, Math.min(4, bw * 0.18));
  const nowH = Math.floor(Date.now() / HOUR) * HOUR;
  series.forEach((x, i) => {
    const bh = (val(x) / yMax) * plotH;
    const bx = plotX + i * bw + gap / 2;
    const by = top + plotH - bh;
    const lv = level(val(x), t);
    const past = dayIdx === 0 && x.t < nowH;
    const isNow = dayIdx === 0 && x.t === nowH;
    ctx.globalAlpha = (past ? 0.32 : (hoverIdx === null || hoverIdx === i ? 1 : 0.75)) * (np ? 0.55 : 1) * (prog ? 0.55 : 1);
    ctx.fillStyle = COLORS[lv];
    roundRectTop(ctx, bx, by, bw - gap, bh, 3);
    ctx.fill();
    if (prog) {
      ctx.globalAlpha = 0.9; ctx.setLineDash([3, 3]); ctx.strokeStyle = COLORS[lv]; ctx.lineWidth = 1;
      roundRectTop(ctx, bx + 0.5, by + 0.5, bw - gap - 1, bh - 0.5, 3); ctx.stroke(); ctx.setLineDash([]);
    }
    if (isNow) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      roundRectTop(ctx, bx + 0.75, by + 0.75, bw - gap - 1.5, bh - 0.75, 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });

  if (np) {
    // Norgespris som trappelinje
    ctx.strokeStyle = COLORS.blue; ctx.lineWidth = 2.5; ctx.beginPath();
    series.forEach((x, i) => {
      const y = top + plotH - (Math.max(0, x.total) / yMax) * plotH;
      const x0 = plotX + i * bw; const x1 = x0 + bw;
      if (i === 0) ctx.moveTo(x0, y); else ctx.lineTo(x0, y);
      ctx.lineTo(x1, y);
    });
    ctx.stroke();
  }
  // snittlinje
  const avg = series.reduce((a, c) => a + val(c), 0) / n;
  const ay = top + plotH - (avg / yMax) * plotH;
  ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(238,240,244,0.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(plotX, ay); ctx.lineTo(w, ay); ctx.stroke(); ctx.setLineDash([]);

  // timeetiketter
  ctx.fillStyle = COLORS.faint; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const every = bw > fs * 2.2 ? 1 : bw * 2 > fs * 2.2 ? 2 : bw * 3 > fs * 1.6 ? 3 : 6;
  series.forEach((x, i) => {
    const hr = Number(hh(x.t));
    if (hr % every === 0) ctx.fillText(String(hr).padStart(2, '0'), plotX + i * bw + bw / 2, h - 2);
  });
  chartGeom = { plotX, bw, n, series, top, plotH, yMax, prog };
}

/** Ukeoversikt: én søyle per dag (snitt), strek for laveste–høyeste time. */
function drawWeek() {
  const canvas = $('chart');
  const { ctx, w, h } = setupCanvas(canvas);
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  ctx.font = `${Math.round(fs * 0.7)}px "Segoe UI", system-ui, sans-serif`;
  const np = !!S.norgespris;
  const days = weekDays().filter((d) => d.series.length);
  const val = (x) => (np ? x.altTotal : x.total);
  const stats = days.map((d) => {
    const v = d.series.map(val);
    return { d, avg: v.reduce((a, c) => a + c, 0) / v.length, min: Math.min(...v), max: Math.max(...v), np: avgOf(d.series, 'total') };
  });
  const max = Math.max(...stats.map((s) => Math.max(s.max, s.np)));
  const t = terciles(stats.map((s) => ({ total: s.avg })));
  const axisW = Math.round(fs * 2.2); const labH = Math.round(fs * 1.3);
  const plotX = axisW; const plotW = w - axisW; const top = 4; const plotH = h - labH - 6;
  const stepKr = max / 100 > 2 ? 0.5 : 0.25;
  const yMax = Math.ceil((max / 100) / stepKr) * stepKr * 100 || 100;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= yMax + 0.01; v += stepKr * 100) {
    const y = top + plotH - (v / yMax) * plotH;
    ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotX, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = COLORS.faint; ctx.fillText(kr(v, v % 100 === 0 ? 0 : 2), axisW - 6, y);
  }
  const n = stats.length; const bw = plotW / n; const gap = Math.max(4, bw * 0.28);
  const Y = (v) => top + plotH - (v / yMax) * plotH;
  stats.forEach((s, i) => {
    const bx = plotX + i * bw + gap / 2; const bwi = bw - gap;
    const lv = level(s.avg, t);
    const a = (s.d.prognose ? 0.5 : 1) * (np ? 0.6 : 1) * (hoverIdx === null || hoverIdx === i ? 1 : 0.75);
    ctx.globalAlpha = a; ctx.fillStyle = COLORS[lv];
    roundRectTop(ctx, bx, Y(s.avg), bwi, Y(0) - Y(s.avg), 4); ctx.fill();
    if (s.d.prognose) { ctx.globalAlpha = 0.9; ctx.setLineDash([3, 3]); ctx.strokeStyle = COLORS[lv]; roundRectTop(ctx, bx + 0.5, Y(s.avg) + 0.5, bwi - 1, Y(0) - Y(s.avg) - 0.5, 4); ctx.stroke(); ctx.setLineDash([]); }
    // laveste–høyeste
    ctx.globalAlpha = 0.85; ctx.strokeStyle = '#eef0f4'; ctx.lineWidth = 1.2;
    const cx = bx + bwi / 2;
    ctx.beginPath(); ctx.moveTo(cx, Y(s.min)); ctx.lineTo(cx, Y(s.max)); ctx.moveTo(cx - 4, Y(s.max)); ctx.lineTo(cx + 4, Y(s.max)); ctx.moveTo(cx - 4, Y(s.min)); ctx.lineTo(cx + 4, Y(s.min)); ctx.stroke();
    if (np) { ctx.globalAlpha = 1; ctx.strokeStyle = COLORS.blue; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(bx, Y(Math.max(0, s.np))); ctx.lineTo(bx + bwi, Y(Math.max(0, s.np))); ctx.stroke(); }
    ctx.globalAlpha = 1;
    ctx.fillStyle = s.d.prognose ? COLORS.faint : COLORS.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const idx = weekDays().indexOf(s.d);
    ctx.fillText(dagNavn(s.d.date, idx, true), cx, h - 3);
  });
  chartGeom = { week: true, plotX, bw, n, stats };
}

function onChartMove(e) {
  if (!chartGeom) return;
  const r = $('chart').getBoundingClientRect();
  const x = e.clientX - r.left;
  const i = Math.floor((x - chartGeom.plotX) / chartGeom.bw);
  const tip = $('tip');
  if (i < 0 || i >= chartGeom.n) { tip.hidden = true; if (hoverIdx !== null) { hoverIdx = null; drawChart(); } return; }
  if (i !== hoverIdx) { hoverIdx = i; drawChart(); }
  if (chartGeom.week) {
    const s = chartGeom.stats[i];
    const idx = weekDays().indexOf(s.d);
    const p = s.d.prognose ? '~' : '';
    let h2 = `<b>${dagNavn(s.d.date, idx)}</b>${s.d.prognose ? ' <span class="anslag">Anslag</span>' : ''}<br>`;
    h2 += S.norgespris
      ? `<span style="color:${COLORS.blue}">${S.avtaleNavn || 'Norgespris'} ${kr(s.np)}</span><br>Spot m/støtte snitt ${p}${kr(s.avg)}<br>Laveste ${p}${kr(s.min)} · høyeste ${p}${kr(s.max)}`
      : `Snitt ${p}${kr(s.avg)} kr/kWh<br>Laveste ${p}${kr(s.min)} · høyeste ${p}${kr(s.max)}`;
    tip.innerHTML = h2; tip.hidden = false;
    const tw1 = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(r.width - tw1, chartGeom.plotX + i * chartGeom.bw + chartGeom.bw / 2 - tw1 / 2))}px`;
    tip.style.top = '0px';
    return;
  }
  const d = chartGeom.series[i];
  if (S.norgespris) {
    const diff = d.altTotal - d.total;
    tip.innerHTML = `<b>kl. ${hh(d.t)}–${hh(d.t + HOUR)}</b>${chartGeom.prog ? ' <span class="anslag">Anslag</span>' : ''}<br><span style="color:${COLORS.blue}">${S.avtaleNavn || 'Norgespris'} ${kr(d.total)}</span><br>Spotpris m/støtte ${chartGeom.prog ? '~' : ''}${kr(d.altTotal)}<br><span class="${diff >= 0 ? 'green' : 'yellow'}">${diff >= 0 ? 'Sparer' : 'Spot billigere med'} ${kr(Math.abs(diff))}</span>`;
    tip.hidden = false;
    const tw0 = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(r.width - tw0, chartGeom.plotX + i * chartGeom.bw + chartGeom.bw / 2 - tw0 / 2))}px`;
    tip.style.top = '0px';
    return;
  }
  let html = `<b>${chartGeom.prog ? '~' : ''}${kr(d.total)} kr/kWh</b>${chartGeom.prog ? ' <span class="anslag">Anslag</span>' : ''}<br>kl. ${hh(d.t)}–${hh(d.t + HOUR)}<br>`;
  html += `${S.norgespris ? (S.avtaleNavn || 'Norgespris') : 'Strøm'} ${kr(d.kraft)} · nett ${kr(d.nett)}`;
  if (d.stotte > 0) html += `<br><span class="green">Støtte −${kr(d.stotte)}</span>`;
  tip.innerHTML = html;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  let left = chartGeom.plotX + i * chartGeom.bw + chartGeom.bw / 2 - tw / 2;
  left = Math.max(0, Math.min(r.width - tw, left));
  tip.style.left = `${left}px`;
  tip.style.top = '0px';
}
function onChartLeave() { $('tip').hidden = true; hoverIdx = null; if (S && S.todaySeries) drawChart(); }

function renderUsage() {
  const has = S.hasConsumption;
  $('empty').hidden = has;
  const show = S.month || S.prev;
  if (!has || !show) {
    $('month-title').textContent = 'Forbruk';
    $('month-sub').textContent = has && S.lastDay ? `nyeste data ${dayLabel(S.lastDay)}` : '';
    ['m-kwh', 'm-kr', 'm-est'].forEach((id) => { $(id).textContent = '–'; });
    $('cap').hidden = true; $('yday').hidden = true;
    $('facts').innerHTML = has ? '<li class="warn">Forbruket er for gammelt – last ned ny fil fra Elhub</li>' : '';
    if (has) $('empty').hidden = false;
    return;
  }
  let m = S.month || S.prev;
  const orig = m;
  let hanRatio = 1;
  const name = S.month ? MND[S.monthName - 1] : MND[S.prevName - 1];
  $('month-title').textContent = name[0].toUpperCase() + name.slice(1);
  $('month-sub').textContent = `t.o.m. ${dayLabel(m.sisteDag)}`;
  // HAN-leseren vet hele månedens forbruk, også før appen ble koblet til
  const LL = window.stromLive && window.stromLive();
  if (S.month && LL && LL.data && LL.data.maanedKwh > m.kwh && m.kwh > 0) {
    const ratio = LL.data.maanedKwh / m.kwh;
    hanRatio = ratio;
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(Date.now());
    const dag = Number(p.find((x) => x.type === 'day').value); const time = Number(p.find((x) => x.type === 'hour').value);
    const elapsed = Math.max(0.5, dag - 1 + time / 24);
    const energi = m.energiKr * ratio;
    const fasteHele = m.estimatKr ? m.estimatKr - (m.energiKr / m.antallDager) * m.dagerIMnd : m.totalKr - m.energiKr;
    m = { ...m, kwh: LL.data.maanedKwh, energiKr: energi, totalKr: energi + fasteHele * (elapsed / m.dagerIMnd), estimatKr: energi / elapsed * m.dagerIMnd + fasteHele };
  }
  $('m-kwh').textContent = `${num(m.kwh)} kWh`;
  $('m-kr').textContent = `${num(m.totalKr)} kr`;
  $('m-est').textContent = m.estimatKr ? `~${num(m.estimatKr)} kr` : `${num(m.totalKr)} kr`;

  // kapasitet (live fra HAN-leser gjelder inneværende måned)
  const L = window.stromLive && window.stromLive();
  if (S.month && L && L.cap) {
    m = { ...m, kapKw: L.cap.kw, kapKr: L.cap.kr, kapGrense: L.cap.grense, kapTrinn: L.cap.trinn, kapMetode: L.cap.metode };
  }
  if (m.kapKw !== null && m.kapKw !== undefined) {
    $('cap').hidden = false;
    const g = m.kapGrense;
    $('cap-text').innerHTML = `<b>${num(m.kapKw, 1)} kW</b> <span class="muted">av ${g ? `${g} kW` : 'øverste'} · ${num(m.kapKr)} kr/mnd</span>`;
    const pct = g ? Math.min(100, (m.kapKw / g) * 100) : 100;
    const fill = $('cap-fill');
    fill.style.width = `${pct}%`;
    fill.style.background = pct > 90 ? COLORS.red : pct > 75 ? COLORS.yellow : COLORS.green;
    let hint = '';
    const tr = S.trinn || [];
    const idx = m.kapTrinn ? m.kapTrinn - 1 : -1;
    if (idx >= 0 && tr[idx + 1]) {
      hint += `${num(Math.max(0, g - m.kapKw), 1)} kW til neste trinn (+${num(tr[idx + 1].kr - tr[idx].kr)} kr/mnd).`;
    }
    if (idx > 0) hint += ` Under ${tr[idx].fra} kW sparer ${num(tr[idx].kr - tr[idx - 1].kr)} kr/mnd.`;
    if (m.kapMetode && !['TRE_DØGNMAX_MND', 'MND_MAX', 'EGEN'].includes(m.kapMetode)) hint += ' Nettselskapet beregner kapasitet på en annen måte, så dette er et anslag.';
    $('cap-hint').textContent = hint.trim();
    $('cap').classList.toggle('focus', !!S.norgespris);
  } else {
    $('cap').hidden = true;
  }

  // i går
  const y = S.yesterday;
  if (y) {
    $('yday').hidden = false;
    const isY = S.lastDay === addDays(S.today, -1);
    $('yday-title').textContent = S.lastDay === S.today ? 'I dag hittil' : isY ? 'I går' : dayLabel(S.lastDay);
    $('yday-text').innerHTML = `<b>${num(y.kwh, 1)} kWh</b> <span class="muted">· ${num(y.kr)} kr · topp ${num(y.toppKw, 1)} kW kl. ${String(y.toppKl).padStart(2, '0')}</span>`;
    drawYday(y);
  } else {
    $('yday').hidden = true;
  }

  const facts = [];
  if (!(S.norgespris && isFlat(S.todaySeries))) facts.push(`Snittpris ${kr(m.snittpris)} kr/kWh med alt inkludert`);
  const alt = S.month ? S.monthAlt : S.prevAlt;
  if (S.norgespris && alt) {
    const spart = (alt.energiKr - orig.energiKr) * (S.month ? hanRatio : 1);
    facts.unshift(spart >= 0
      ? `<span class="green">${S.avtaleNavn || 'Norgespris'} har spart dere ~${num(spart)} kr ${S.month ? 'hittil' : 'forrige måned'}</span> mot spotpris`
      : `<span class="warn">Spotpris ville vært ~${num(-spart)} kr billigere ${S.month ? 'denne måneden' : 'forrige måned'}</span>`);

  }
  if (S.month && S.prev) {
    let f = `${cap(MND[S.prevName - 1])}: ${num(S.prev.kwh)} kWh · ${num(S.prev.totalKr)} kr`;
    if (S.norgespris && S.prevAlt) { const sp = S.prevAlt.totalKr - S.prev.totalKr; f += sp >= 0 ? ` · spart ${num(sp)} kr` : ` · ${num(-sp)} kr dyrere enn spot`; }
    facts.push(f);
  }
  if (!S.hourly) facts.push('Kapasitetstrinn trenger timesdata fra Elhub');
  if (m.manglerPris) facts.push('<span class="warn">Mangler spotpriser for disse dagene</span>');
  if (S.lastDay && S.lastDay < addDays(S.today, -2)) facts.push(`<span class="warn">Nyeste forbruk er fra ${dayLabel(S.lastDay)} – last ned ny fil fra Elhub</span>`);
  if (S.errors && S.errors.length) facts.push(`<span class="warn">Kunne ikke lese: ${S.errors.join(', ')}</span>`);
  if (!S.han) facts.push('<a href="#" id="lnk-han" class="lnk">Hent forbruket automatisk med HAN-leser →</a>');
  $('facts').innerHTML = facts.map((f) => `<li>${f}</li>`).join('');
  const lh = document.getElementById('lnk-han');
  if (lh) lh.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('btn-han').click(); });
}

function drawYday(y) {
  const canvas = $('ychart');
  const { ctx, w, h } = setupCanvas(canvas);
  const max = Math.max(...y.hours.map((x) => x.kwh), 0.1);
  const n = 24;
  const bw = w / n;
  const peak = y.hours.reduce((a, c) => (c.kwh > a.kwh ? c : a));
  y.hours.forEach((x) => {
    const i = Number(hh(x.t));
    const bh = Math.max(1, (x.kwh / max) * (h - 2));
    ctx.fillStyle = x === peak ? COLORS.blue : 'rgba(122,167,255,0.38)';
    roundRectTop(ctx, i * bw + 1, h - bh, bw - 2, bh, 2);
    ctx.fill();
  });
}

function addDays(dateStr, n) {
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(yy, mm - 1, dd + n)).toISOString().slice(0, 10);
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---- hendelser ----
let setupOpen = false;
function openSetup(force) {
  if (setupOpen) return;
  setupOpen = true;
  window.stromSetup.open(() => { setupOpen = false; render(); }, force).then((shown) => { if (!shown) setupOpen = false; });
}
window.strom.onState((s) => {
  S = s;
  if (s.needsSetup) openSetup(false);
  render();
});
window.strom.onShowSetup(() => openSetup(true));
openSetup(false);
window.strom.onBusy((b) => $('btn-refresh').classList.toggle('spinning', b));
$('btn-refresh').addEventListener('click', () => window.strom.refresh());
$('btn-menu').addEventListener('click', () => window.strom.menu());
$('btn-elhub').addEventListener('click', () => window.strom.openElhub());
$('btn-folder').addEventListener('click', () => window.strom.openForbruk());
$('day-prev').addEventListener('click', () => { if (dayIdx > 0) { dayIdx--; hoverIdx = null; render(); } });
$('day-next').addEventListener('click', () => { if (dayIdx < weekDays().length - 1) { dayIdx++; hoverIdx = null; render(); } });
$('btn-week').addEventListener('click', () => { weekMode = !weekMode; hoverIdx = null; $('tip').hidden = true; render(); });
$('chart').addEventListener('click', () => {
  if (weekMode && chartGeom && chartGeom.week && hoverIdx !== null) {
    dayIdx = weekDays().indexOf(chartGeom.stats[hoverIdx].d); weekMode = false; hoverIdx = null; $('tip').hidden = true; render();
  }
});
$('chart').addEventListener('mousemove', onChartMove);
$('chart').addEventListener('mouseleave', onChartLeave);
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.strom.menu(); });

let rz = null;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(render, 60); });
setInterval(render, 15000);
