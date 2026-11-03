'use strict';
/*
 * Beregninger for strøm-appen: spotpriser, nettleie, strømstøtte, Elhub-CSV og statistikk.
 * Ingen Electron-avhengigheter, så filen kan testes med vanlig Node.
 * Alle tider internt er millisekunder (UTC), og alle øre-beløp er inkl. mva.
 */
const fs = require('fs');
const path = require('path');

const HOUR = 3600 * 1000;
const TZ = 'Europe/Oslo';

const DEFAULT_CONFIG = {
  _info: 'Endre verdiene og lagre - appen leser filen på nytt av seg selv. Enklest er menyen -> "Endre sone og nettselskap".',
  oppsett_ferdig: false,
  prissone: 'NO2',
  nettselskap_id: null,
  _nettselskap_info: 'id fra fri-nettleie (f.eks. vestmar, lede, elvia). "egen" = egne priser under.',
  avgiftssone: 'sor',
  _avgiftssone_info: "'sor' = alle avgifter, 'nord' = Nordland/Troms uten mva, 'tiltak' = tiltakssonen i Finnmark/Nord-Troms uten mva og elavgift.",
  ordning: 'stromstotte',
  _ordning_info: "'stromstotte' = spotpris med statlig strømstøtte. 'norgespris' = fast kraftpris (meldes på via minside.elhub.no).",
  stromleverandor: 'Vibb',
  kraft_paaslag_ore_inkl_mva: 0.0,
  kraft_fast_kr_per_mnd: 0.0,
  stotte_terskel_ore_eks_mva: 77.0,
  stotte_andel: 0.9,
  norgespris_ore_eks_mva: 40.0,
  elavgift_ore_eks_mva: 7.13,
  enova_ore_eks_mva: 1.0,
  egen_dag_ore: 45.0,
  egen_natt_ore: 30.0,
  egen_kapasitet_kr: 400.0,
  _egen_info: 'Brukes bare når nettselskap_id = "egen". Øre/kWh inkl. mva og avgifter, kapasitetsledd kr/mnd.',
  alltid_overst: false,
  oppdater_sekunder: 60,
  importer_fra_nedlastinger: true,
  lukk_til_systemstatusfelt: true,
  varsler: true,
  start_med_windows: false,
};

// ---------------------------------------------------------------------------
// Tid (alltid norsk tid, uansett hva PC-en står på)
// ---------------------------------------------------------------------------
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function osloParts(ms) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute, s: +o.second,
    wd: WD[o.weekday], date: `${o.year}-${o.month}-${o.day}`,
  };
}

/** Oslo-lokal tid -> UTC ms (håndterer sommertid). */
function osloToUtc(y, m, d, h = 0, min = 0) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 3; i++) {
    const p = osloParts(guess);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const want = Date.UTC(y, m - 1, d, h, min);
    if (asUtc === want) break;
    guess += want - asUtc;
  }
  return guess;
}

function hourKey(ms) { return Math.floor(ms / HOUR) * HOUR; }

function dateAdd(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

// ---------------------------------------------------------------------------
// Konfigurasjon
// ---------------------------------------------------------------------------
function loadConfig(file) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') saveConfig(file, DEFAULT_CONFIG);
  }
  return { ...DEFAULT_CONFIG, ...user };
}

function saveConfig(file, cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) if (!k.startsWith('__')) out[k] = v;
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8'); } catch (_) { /* ignorer */ }
}

/** Fjerner gamle innstillinger fra tidligere versjoner. */
function migrateConfig(cfg) {
  const old = ['mva', 'energiledd_dag_ore', 'energiledd_natt_ore', 'natt_fra_kl', 'natt_til_kl', 'helg_er_natt',
    'avgifter_ore', '_nett_info', 'kapasitetstrinn', '_kapasitet_info', 'norgespris_ore_inkl_mva', '_kraft_info',
    '_varsel_info', '_import_info', 'nettselskap', 'gjennomsiktighet', 'vindusramme', '_vindu_info', 'vindu',
    'maksimert', 'posisjon'];
  let changed = false;
  if (cfg.nettselskap && !cfg.nettselskap_id && /vestmar/i.test(cfg.nettselskap)) { cfg.nettselskap_id = 'vestmar'; changed = true; }
  for (const k of old) if (k in cfg) { delete cfg[k]; changed = true; }
  return changed;
}

// ---------------------------------------------------------------------------
// Spotpriser (hvakosterstrommen.no)
// ---------------------------------------------------------------------------
async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'strom-app/2.4 (personlig bruk)', Accept: 'application/json' } });
    return { status: r.status, data: r.status === 200 ? await r.json() : null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spotpriser fra Nord Pool (kraftbørsen) i NOK - samme tall som strømleverandørene bruker.
 * Returnerer liste i samme format som hvakosterstrommen.no, eller null hvis ikke publisert.
 */
async function fetchNordPool(dateStr, zone) {
  const url = `https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices?date=${dateStr}&market=DayAhead&deliveryArea=${zone}&currency=NOK`;
  const { status, data } = await fetchJson(url);
  if (status === 204 || status === 404) return null;
  if (status !== 200 || !data || !Array.isArray(data.multiAreaEntries)) throw new Error(`Nord Pool HTTP ${status}`);
  const out = [];
  for (const row of data.multiAreaEntries) {
    const v = row.entryPerArea && Number(row.entryPerArea[zone]);
    if (!Number.isFinite(v) || !row.deliveryStart) continue;
    out.push({ time_start: row.deliveryStart, time_end: row.deliveryEnd, NOK_per_kWh: v / 1000, kilde: 'nordpool' });
  }
  return out.length >= 20 ? out : null;
}

async function fetchHvaKoster(dateStr, zone) {
  const [y, m, d] = dateStr.split('-');
  const { status, data } = await fetchJson(`https://www.hvakosterstrommen.no/api/v1/prices/${y}/${m}-${d}_${zone}.json`);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`hvakosterstrommen HTTP ${status}`);
  return Array.isArray(data) && data.length ? data : null;
}

/** Henter spotpriser for en dag: Nord Pool først, hvakosterstrommen.no som reserve. Caches på disk. */
async function fetchDayPrices(dateStr, zone, cacheDir) {
  const npFile = path.join(cacheDir, `${dateStr}_${zone}_np.json`);
  const hkFile = path.join(cacheDir, `${dateStr}_${zone}.json`);
  try { return JSON.parse(fs.readFileSync(npFile, 'utf8')); } catch (_) { /* hent */ }
  let data = null;
  try {
    data = await fetchNordPool(dateStr, zone);
  } catch (e) {
    lastSourceError = e.message;
  }
  if (data) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(npFile, JSON.stringify(data));
    return data;
  }
  // Reserve
  try { return JSON.parse(fs.readFileSync(hkFile, 'utf8')); } catch (_) { /* hent */ }
  data = await fetchHvaKoster(dateStr, zone);
  if (data) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(hkFile, JSON.stringify(data));
  }
  return data;
}
let lastSourceError = null;

/** [{s, e, p}] der p er NOK/kWh eks. mva. */
function parseEntries(data) {
  return (data || []).map((x) => ({
    s: Date.parse(x.time_start), e: Date.parse(x.time_end), p: Number(x.NOK_per_kWh), np: x.kilde === 'nordpool',
  })).sort((a, b) => a.s - b.s);
}

/** Map timeKey -> snitt spotpris (NOK/kWh eks. mva). */
function hourlyAvg(entries) {
  const b = new Map();
  for (const x of entries) {
    const k = hourKey(x.s);
    if (!b.has(k)) b.set(k, []);
    b.get(k).push(x.p);
  }
  const out = new Map();
  for (const [k, v] of b) out.set(k, v.reduce((a, c) => a + c, 0) / v.length);
  return out;
}

// ---------------------------------------------------------------------------
// Prisberegning
// ---------------------------------------------------------------------------
// Helligdager (påvirker natt/helg-priser hos mange nettselskaper)
const holidayCache = new Map();
function easterSunday(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451); const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function holidays(y) {
  if (!holidayCache.has(y)) {
    const e = easterSunday(y);
    holidayCache.set(y, new Set([
      `${y}-01-01`, dateAdd(e, -3), dateAdd(e, -2), e, dateAdd(e, 1), `${y}-05-01`, `${y}-05-17`,
      dateAdd(e, 39), dateAdd(e, 49), dateAdd(e, 50), `${y}-12-25`, `${y}-12-26`,
    ]));
  }
  return holidayCache.get(y);
}
function isHoliday(p) { return holidays(p.y).has(p.date); }

const MND_NAVN = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
const DAG_NAVN = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];

function dayMatches(dager, p) {
  if (!dager || !dager.length) return true;
  const hol = isHoliday(p);
  return dager.some((d) => {
    switch (d) {
      case 'alle': return true;
      case 'ukedag': return p.wd < 5;
      case 'virkedag': return p.wd < 5 && !hol;
      case 'helg': return p.wd >= 5;
      case 'helligdager': return hol;
      case 'fridag': return p.wd >= 5 || hol;
      default: return DAG_NAVN[p.wd] === d;
    }
  });
}
function hoursMatch(timer, h) {
  if (!timer) return true;
  const m = String(timer).match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return true;
  const a = +m[1]; const b = +m[2];
  return a <= b ? h >= a && h <= b : h >= a || h <= b;
}

/** Tariffen (husholdning) som gjelder på en gitt dato. */
function activeTariff(selskap, dateStr) {
  if (!selskap || !selskap.tariffer) return null;
  let best = null;
  for (const t of selskap.tariffer) {
    if (t.gyldig_fra <= dateStr && (!t.gyldig_til || dateStr < t.gyldig_til)) {
      if (!best || t.gyldig_fra > best.gyldig_fra) best = t;
    }
  }
  if (!best) {
    // ingen gyldig: bruk den nyeste som har startet
    for (const t of selskap.tariffer) if (t.gyldig_fra <= dateStr && (!best || t.gyldig_fra > best.gyldig_fra)) best = t;
  }
  return best;
}

function mvaFactor(cfg) { return cfg.avgiftssone === 'sor' || !cfg.avgiftssone ? 1.25 : 1.0; }
function elavgiftEks(cfg) { return cfg.avgiftssone === 'tiltak' ? 0 : cfg.elavgift_ore_eks_mva; }

/** Energiledd fra nettselskapet (øre/kWh eks. mva og avgifter) og navnet på perioden. */
function energileddEks(tariff, ms) {
  const p = osloParts(ms);
  const e = tariff.energiledd || {};
  for (const u of e.unntak || []) {
    if (!hoursMatch(u.timer, p.h)) continue;
    if (!dayMatches(u.dager, p)) continue;
    if (u.måneder && u.måneder.length && !u.måneder.includes(MND_NAVN[p.m - 1])) continue;
    return { pris: u.pris, navn: u.navn || 'Unntak' };
  }
  return { pris: e.grunnpris || 0, navn: 'Grunnpris' };
}

/** Nettleie + avgifter for en time, øre/kWh inkl. mva. */
function nettOre(cfg, ms) {
  if (cfg.nettselskap_id === 'egen' || !cfg.__selskap) {
    const p = osloParts(ms);
    const natt = p.h >= 22 || p.h < 6 || p.wd >= 5 || isHoliday(p);
    return natt ? cfg.egen_natt_ore : cfg.egen_dag_ore;
  }
  const t = activeTariff(cfg.__selskap, osloParts(ms).date);
  if (!t) return 0;
  const e = energileddEks(t, ms).pris;
  return (e + elavgiftEks(cfg) + cfg.enova_ore_eks_mva) * mvaFactor(cfg);
}

/** Returnerer øre/kWh inkl. mva: kraft, stotte, nett, total. */
function beregn(cfg, ms, spotEksKr) {
  const mva = mvaFactor(cfg);
  let kraft; let stotte;
  if (cfg.ordning === 'norgespris') {
    kraft = cfg.norgespris_ore_eks_mva * mva;
    stotte = 0;
  } else {
    const spotEksOre = spotEksKr * 100;
    kraft = spotEksOre * mva + cfg.kraft_paaslag_ore_inkl_mva;
    stotte = Math.max(0, spotEksOre - cfg.stotte_terskel_ore_eks_mva) * cfg.stotte_andel * mva;
  }
  const nett = nettOre(cfg, ms);
  return { kraft, stotte, nett, total: kraft - stotte + nett };
}

/** Kapasitetstrinn for et effektnivå. Returnerer {grense, kr, trinn, metode}. */
function kapasitet(cfg, kw, dateStr) {
  if (cfg.nettselskap_id === 'egen' || !cfg.__selskap) {
    return { grense: null, kr: cfg.egen_kapasitet_kr, trinn: null, metode: 'EGEN' };
  }
  const t = activeTariff(cfg.__selskap, dateStr);
  if (!t || !t.fastledd || !t.fastledd.terskler || !t.fastledd.terskler.length) return { grense: null, kr: 0, trinn: null, metode: 'UKJENT' };
  const ter = [...t.fastledd.terskler].sort((a, b) => a.terskel - b.terskel);
  const incl = t.fastledd.terskel_inkludert !== false;
  let idx = 0;
  ter.forEach((x, i) => { if (incl ? kw >= x.terskel : kw > x.terskel) idx = i; });
  const next = ter[idx + 1];
  return {
    grense: next ? next.terskel : null,
    kr: (ter[idx].pris / 12) * mvaFactor(cfg),
    trinn: idx + 1,
    metode: t.fastledd.metode,
  };
}

/** Kort oppsummering av et nettselskaps priser (til oppsettet). */
function tariffSummary(cfg, selskap, dateStr) {
  const t = activeTariff(selskap, dateStr);
  if (!t) return null;
  const c = { ...cfg, __selskap: selskap, nettselskap_id: selskap.id };
  const mva = mvaFactor(c);
  const add = elavgiftEks(c) + c.enova_ore_eks_mva;
  const e = t.energiledd || {};
  const perioder = [{ navn: 'Grunnpris', ore: (e.grunnpris + add) * mva }];
  for (const u of e.unntak || []) {
    const deler = [];
    if (u.timer) {
      const m = String(u.timer).match(/^(\d+)-(\d+)$/);
      deler.push(m ? `kl. ${m[1].padStart(2, '0')}–${String((+m[2] + 1) % 24).padStart(2, '0')}` : u.timer);
    }
    if (u.dager && u.dager.length && !u.dager.includes('alle')) deler.push(u.dager.join(', '));
    if (u.måneder && u.måneder.length) deler.push(u.måneder.length > 4 ? `${u.måneder[0].slice(0, 3)}–${u.måneder[u.måneder.length - 1].slice(0, 3)}` : u.måneder.map((x) => x.slice(0, 3)).join(', '));
    perioder.push({ navn: u.navn || 'Unntak', tid: deler.join(' · '), ore: (u.pris + add) * mva });
  }
  const ter = [...((t.fastledd && t.fastledd.terskler) || [])].sort((a, b) => a.terskel - b.terskel);
  const trinn = ter.map((x, i) => ({ fra: x.terskel, til: ter[i + 1] ? ter[i + 1].terskel : null, kr: (x.pris / 12) * mva }));
  return { gyldig_fra: t.gyldig_fra, perioder, trinn, metode: t.fastledd && t.fastledd.metode };
}

// ---------------------------------------------------------------------------
// Elhub-CSV
// ---------------------------------------------------------------------------
const DT_RE = [
  // dd.mm.yyyy hh:mm(:ss)
  [/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})[ T](\d{1,2})[:.](\d{2})(?::\d{2})?$/, (m) => [m[3], m[2], m[1], m[4], m[5]]],
  // yyyy-mm-dd hh:mm(:ss)
  [/^(\d{4})-(\d{1,2})-(\d{1,2})[ ](\d{1,2}):(\d{2})(?::\d{2})?$/, (m) => [m[1], m[2], m[3], m[4], m[5]]],
];
const D_RE = [
  [/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/, (m) => [m[3], m[2], m[1]]],
  [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (m) => [m[1], m[2], m[3]]],
];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const TIME_RE = /^(\d{1,2})[:.](\d{2})(?:\s*[-–]\s*\d{1,2}[:.]\d{2})?$/;
const NUM_RE = /^-?[\d\s  .]*\d([.,]\d+)?$/;

/** Returnerer {type:'dt', ms} | {type:'date', y,m,d} | null */
function parseDateCell(s) {
  s = s.trim().replace(/^"|"$/g, '');
  if (s.length < 8) return null;
  if (ISO_RE.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return { type: 'dt', ms };
  }
  for (const [re, f] of DT_RE) {
    const m = s.match(re);
    if (m) {
      const [y, mo, d, h, mi] = f(m).map(Number);
      return { type: 'dt', ms: osloToUtc(y, mo, d, h % 24, mi) };
    }
  }
  for (const [re, f] of D_RE) {
    const m = s.match(re);
    if (m) {
      const [y, mo, d] = f(m).map(Number);
      return { type: 'date', y, m: mo, d };
    }
  }
  return null;
}

function parseNumber(s) {
  s = s.trim().replace(/^"|"$/g, '');
  if (!s || !NUM_RE.test(s)) return null;
  s = s.replace(/[\s  ]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function splitCsvLine(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function decodeText(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('�')) text = buf.toString('latin1');
  return text;
}

/** Leser forbruks-CSV fleksibelt. Returnerer {cons: Map(timeKey->kWh), hourly: bool} */
function parseElhubText(text) {
  const lines = text.split(/\r?\n/);
  const sample = lines.slice(0, 20).join('\n');
  const delim = [';', ',', '\t'].reduce((a, b) => ((sample.split(b).length > sample.split(a).length) ? b : a));
  let header = null;
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = splitCsvLine(line, delim);
    let start = null; let startIsDateOnly = false;
    const used = new Set();
    let curDate = null;
    row.forEach((cell, i) => {
      const v = parseDateCell(cell);
      if (v && v.type === 'dt') {
        used.add(i);
        if (start === null) start = v.ms;
      } else if (v && v.type === 'date') {
        used.add(i);
        curDate = v;
        if (start === null) { start = osloToUtc(v.y, v.m, v.d, 0, 0); startIsDateOnly = true; }
      } else {
        const m = cell.trim().match(TIME_RE);
        if (m && curDate) {
          used.add(i);
          const t = osloToUtc(curDate.y, curDate.m, curDate.d, (+m[1]) % 24, +m[2]);
          if (start === null || startIsDateOnly) { start = t; startIsDateOnly = false; }
          curDate = null;
        }
      }
    });
    if (start === null) {
      if (!records.length) header = row.map((c) => c.trim().toLowerCase());
      continue;
    }
    const nums = [];
    row.forEach((c, i) => {
      if (used.has(i)) return;
      const v = parseNumber(c);
      if (v !== null) nums.push([i, v]);
    });
    if (nums.length) records.push({ start, nums });
  }
  if (!records.length) return { cons: new Map(), hourly: true };

  let col = null;
  if (header) {
    for (const key of ['kwh', 'forbruk', 'volum', 'mengde', 'verdi', 'value', 'quantity']) {
      const i = header.findIndex((h, idx) => h.includes(key) && records[0].nums.some(([j]) => j === idx));
      if (i >= 0) { col = i; break; }
    }
  }
  if (col === null) {
    const cnt = new Map();
    for (const r of records) for (const [i] of r.nums) cnt.set(i, (cnt.get(i) || 0) + 1);
    const ok = [...cnt].filter(([, n]) => n >= records.length * 0.8).map(([i]) => i);
    col = Math.max(...ok);
  }
  const pts = [];
  for (const r of records) {
    const hit = r.nums.find(([i]) => i === col);
    if (hit) pts.push([r.start, hit[1]]);
  }
  pts.sort((a, b) => a[0] - b[0]);

  let step = null;
  if (pts.length > 1) {
    const diffs = [];
    for (let i = 1; i < pts.length; i++) if (pts[i][0] > pts[i - 1][0]) diffs.push(pts[i][0] - pts[i - 1][0]);
    diffs.sort((a, b) => a - b);
    step = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null;
  }
  const cons = new Map();
  if (step !== null && step >= 20 * HOUR) {
    for (const [t, v] of pts) {
      const p = osloParts(t);
      const base = osloToUtc(p.y, p.m, p.d, 0, 0);
      for (let h = 0; h < 24; h++) {
        const k = hourKey(base + h * HOUR);
        cons.set(k, (cons.get(k) || 0) + v / 24);
      }
    }
    return { cons, hourly: false };
  }
  for (const [t, v] of pts) {
    const k = hourKey(t);
    cons.set(k, (cons.get(k) || 0) + v);
  }
  return { cons, hourly: true };
}

function parseElhubFile(file) {
  return parseElhubText(decodeText(fs.readFileSync(file)));
}

function listCsv(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /\.(csv|txt)$/i.test(n))
      .map((n) => ({ n, mt: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => a.mt - b.mt);
  } catch (_) { return []; }
}

function consumptionSignature(dir) {
  return listCsv(dir).map((x) => `${x.n}:${x.mt}`).join('|');
}

function loadConsumption(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cons = new Map(); let hourly = true; const errors = [];
  const files = listCsv(dir);
  for (const { n } of files) {
    try {
      const r = parseElhubFile(path.join(dir, n));
      for (const [k, v] of r.cons) cons.set(k, v); // nyeste fil vinner
      hourly = hourly && r.hourly;
    } catch (e) { errors.push(n); }
  }
  return { cons, hourly, files: files.map((f) => f.n), errors };
}

/** Kopierer nye Elhub-CSV-er fra Nedlastinger. Returnerer liste over importerte filnavn. */
function importFromDownloads(downloadsDir, forbrukDir, seen) {
  const imported = [];
  let names = [];
  try { names = fs.readdirSync(downloadsDir); } catch (_) { return imported; }
  const cutoff = Date.now() - 14 * 86400 * 1000;
  for (const n of names) {
    if (!/\.csv$/i.test(n)) continue;
    const p = path.join(downloadsDir, n);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    const key = `${n}:${st.mtimeMs}`;
    if (st.mtimeMs < cutoff || seen.has(key) || st.size > 20e6) continue;
    seen.add(key);
    try {
      const head = decodeText(fs.readFileSync(p)).slice(0, 4000).toLowerCase();
      if (!['kwh', 'forbruk', 'elhub', 'målepunkt', 'malepunkt'].some((k) => head.includes(k))) continue;
      const r = parseElhubFile(p);
      if (r.cons.size < 24) continue;
      fs.mkdirSync(forbrukDir, { recursive: true });
      const dest = path.join(forbrukDir, n);
      try { if (fs.statSync(dest).size === st.size) continue; } catch (_) { /* finnes ikke */ }
      fs.copyFileSync(p, dest);
      imported.push(n);
    } catch (_) { /* hopp over */ }
  }
  return imported;
}

// ---------------------------------------------------------------------------
// Statistikk
// ---------------------------------------------------------------------------
function monthStats(cfg, cons, prices, y, m, hourly) {
  const hrs = [...cons.keys()].filter((h) => { const p = osloParts(h); return p.y === y && p.m === m; }).sort((a, b) => a - b);
  if (!hrs.length) return null;
  let kwh = 0; let costOre = 0; let pricedKwh = 0;
  const daymax = new Map();
  for (const h of hrs) {
    const v = cons.get(h);
    kwh += v;
    if (prices.has(h)) { costOre += v * beregn(cfg, h, prices.get(h)).total; pricedKwh += v; }
    const d = osloParts(h).date;
    daymax.set(d, Math.max(daymax.get(d) || 0, v));
  }
  let energiKr = costOre / 100;
  if (pricedKwh > 0 && pricedKwh < kwh) energiKr = energiKr * kwh / pricedKwh;
  const days = [...daymax.keys()].sort();
  let kapKw = null; let kapKr = 0; let kapGrense = null;
  let kapTrinn = null; let kapMetode = null;
  const midMonth = `${y}-${String(m).padStart(2, '0')}-15`;
  if (hourly) {
    const kap0 = kapasitet(cfg, 0, midMonth);
    if (kap0.metode === 'MND_MAX') {
      kapKw = Math.max(...daymax.values());
    } else {
      const top = [...daymax.values()].sort((a, b) => b - a).slice(0, 3);
      kapKw = top.reduce((a, c) => a + c, 0) / top.length;
    }
    ({ grense: kapGrense, kr: kapKr, trinn: kapTrinn, metode: kapMetode } = kapasitet(cfg, kapKw, midMonth));
  } else {
    ({ kr: kapKr, metode: kapMetode } = kapasitet(cfg, 0, midMonth));
  }
  const dim = daysInMonth(y, m);
  let faste = kapKr + cfg.kraft_fast_kr_per_mnd;
  let est = null;
  if (days.length < dim) {
    est = energiKr / days.length * dim + faste;
    faste = faste * days.length / dim;
  }
  return {
    kwh, energiKr, totalKr: energiKr + faste, kapKw, kapKr, kapGrense, kapTrinn, kapMetode,
    sisteDag: days[days.length - 1], antallDager: days.length, dagerIMnd: dim,
    estimatKr: est, manglerPris: pricedKwh === 0, snittpris: kwh ? energiKr * 100 / kwh : 0,
  };
}

function dayStats(cfg, cons, prices, dateStr) {
  const hrs = [...cons.keys()].filter((h) => osloParts(h).date === dateStr);
  if (!hrs.length) return null;
  let kwh = 0; let kr = 0; let peak = hrs[0];
  const hours = [];
  for (const h of hrs.sort((a, b) => a - b)) {
    const v = cons.get(h);
    kwh += v;
    if (prices.has(h)) kr += v * beregn(cfg, h, prices.get(h)).total / 100;
    if (v > cons.get(peak)) peak = h;
    hours.push({ t: h, kwh: v });
  }
  return { kwh, kr, toppKw: cons.get(peak), toppKl: osloParts(peak).h, hours };
}

/** Beste sammenhengende vindu på n timer fra listen [{t, total}]. */
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

module.exports = {
  HOUR, DEFAULT_CONFIG, osloParts, osloToUtc, hourKey, dateAdd, daysInMonth,
  loadConfig, saveConfig, migrateConfig, fetchDayPrices, getSourceError: () => lastSourceError, activeTariff, tariffSummary, mvaFactor, isHoliday, parseEntries, hourlyAvg,
  nettOre, beregn, kapasitet, parseElhubText, parseElhubFile, loadConsumption,
  consumptionSignature, importFromDownloads, monthStats, dayStats, cheapestWindow,
};
