'use strict';
/*
 * HAN-lesere på hjemmenettet: søk, identifisering og avlesning.
 *
 * Hver lesertype er en "driver" med probe/read/hours. Nye typer legges til i DRIVERS.
 * I dag støttes lesere med amsreader-firmware (AmsLeser Pow-K/Pow-K+/Pow-U/Pow-P1 og
 * hjemmelagde ESP-lesere): https://github.com/UtilitechAS/amsreader-firmware
 */
const os = require('os');

const HOUR = 3600 * 1000;

async function get(url, { timeout = 1500, auth = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = { Accept: 'application/json' };
  if (auth && auth.bruker) headers.Authorization = `Basic ${Buffer.from(`${auth.bruker}:${auth.passord || ''}`).toString('base64')}`;
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers, redirect: 'manual' });
    let json = null;
    if (r.status === 200) {
      const text = await r.text();
      try { json = JSON.parse(text); } catch (_) { json = null; }
    }
    return { status: r.status, json, auth: r.headers.get('www-authenticate') || '' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Driver: amsreader-firmware (AmsLeser)
// ---------------------------------------------------------------------------
const BOARDS = {
  5: { esp8266: 'Pow-K', esp32s2: 'Pow-K+' }, 7: { esp8266: 'Pow-U', esp32s2: 'Pow-U+' }, 6: 'Pow-P1',
  3: 'Pow-K', 4: 'Pow-U', 2: 'HAN Reader 2.0', 1: 'Kamstrup-modul', 8: 'µHAN mosquito',
};
const METERS = { 1: 'Aidon', 2: 'Kaifa', 3: 'Kamstrup', 8: 'Iskra', 9: 'Landis+Gyr', 10: 'Sagemcom' };

function boardName(board, chip) {
  const b = BOARDS[board];
  if (!b) return 'AMS-leser';
  return typeof b === 'string' ? b : (b[chip] || Object.values(b)[0]);
}

const amsleser = {
  id: 'amsleser',
  navn: 'AmsLeser (Pow-K, Pow-U, Pow-P1) og andre amsreader-lesere',

  async probe(ip, auth) {
    const r = await get(`http://${ip}/sysinfo.json`, { auth });
    if (r.status === 401 && /basic/i.test(r.auth)) {
      return { ip, driver: 'amsleser', id: null, navn: 'HAN-leser (krever passord)', needsAuth: true };
    }
    const j = r.json;
    if (r.status !== 200 || !j || !j.chipId || !j.meter || typeof j.hostname !== 'string') return null;
    const mfg = METERS[j.meter.mfg] || '';
    return {
      ip,
      driver: 'amsleser',
      id: `ams-${j.chipId}`,
      hostname: j.hostname,
      navn: boardName(j.board, j.chip),
      maaler: [mfg, j.meter.model].filter(Boolean).join(' ') || 'ukjent måler',
      versjon: j.version,
      needsAuth: false,
    };
  },

  async read(dev, auth) {
    const r = await get(`http://${dev.ip}/data.json`, { auth, timeout: 3000 });
    if (r.status === 401) throw Object.assign(new Error('Feil brukernavn eller passord'), { code: 'AUTH' });
    if (r.status !== 200 || !r.json) throw new Error(`HTTP ${r.status}`);
    const d = r.json;
    const ea = d.ea || {};
    return {
      tid: Date.now(),
      kw: (Number(d.i) || 0) / 1000,
      eksportKw: (Number(d.e) || 0) / 1000,
      timeKwh: ea.h ? Number(ea.h.u) : null,
      idagKwh: ea.d ? Number(ea.d.u) : null,
      maanedKwh: ea.m ? Number(ea.m.u) : null,
      topper: Array.isArray(ea.p) ? ea.p.map(Number).filter(Number.isFinite) : [],
      maalerKwh: Number(d.ic) || null,
      faser: [d.l1, d.l2, d.l3].filter((l) => l && Number(l.u) > 0).map((l) => ({ v: Number(l.u), a: Number(l.i) })),
      hovedsikring: Number(d.mf) || null,
    };
  },

  /** Timeforbruk siste døgn: Map(timeKey UTC -> kWh) for hele timer. */
  async hours(dev, auth, osloParts, osloToUtc) {
    const r = await get(`http://${dev.ip}/dayplot.json`, { auth, timeout: 3000 });
    if (r.status !== 200 || !r.json) return new Map();
    const now = Date.now();
    const p = osloParts(now);
    const out = new Map();
    for (let i = 0; i < 24; i++) {
      const v = Number(r.json[`i${String(i).padStart(2, '0')}`]);
      if (!Number.isFinite(v) || i === p.h) continue; // inneværende time er ikke ferdig
      // Timer før nå er fra i dag, timer etter nå er fra i går
      const base = i < p.h ? p : osloParts(now - 24 * HOUR);
      out.set(osloToUtc(base.y, base.m, base.d, i, 0), v);
    }
    return out;
  },
};

const DRIVERS = [amsleser];
function driver(id) { return DRIVERS.find((d) => d.id === id); }

// ---------------------------------------------------------------------------
// Søk på hjemmenettet
// ---------------------------------------------------------------------------
function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** De lokale /24-nettene PC-en er koblet til (bare private adresser). */
function localSubnets() {
  const nets = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal || !isPrivate(n.address)) continue;
      nets.add(n.address.split('.').slice(0, 3).join('.'));
    }
  }
  if (process.env.STROM_HAN_NETT) nets.add(process.env.STROM_HAN_NETT); // brukes til testing
  return [...nets].slice(0, 3);
}

/**
 * Søker etter HAN-lesere. Prøver kjente vertsnavn først, deretter alle adresser i nettet.
 * onProgress(ferdig, totalt) kalles underveis.
 */
async function scan({ onProgress = () => {}, auth = null, extraHosts = [] } = {}) {
  const hosts = [...extraHosts];
  for (const net of localSubnets()) for (let i = 1; i < 255; i++) hosts.push(`${net}.${i}`);
  const unique = [...new Set(hosts)];
  const found = new Map();
  let done = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < unique.length) {
      const ip = unique[idx++];
      for (const d of DRIVERS) {
        try {
          const dev = await d.probe(ip, auth);
          if (dev) { found.set(dev.id || ip, dev); break; }
        } catch (_) { /* ingen leser her */ }
      }
      done++;
      if (done % 8 === 0 || done === unique.length) onProgress(done, unique.length);
    }
  };
  await Promise.all(Array.from({ length: 48 }, worker));
  return [...found.values()].sort((a, b) => Number(a.needsAuth) - Number(b.needsAuth));
}

async function probeHost(host, auth) {
  for (const d of DRIVERS) {
    try {
      const dev = await d.probe(host, auth);
      if (dev) return dev;
    } catch (_) { /* prøv neste */ }
  }
  return null;
}

module.exports = { DRIVERS, driver, scan, probeHost, localSubnets };
