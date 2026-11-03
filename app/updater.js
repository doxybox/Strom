'use strict';
/*
 * Automatiske oppdateringer fra GitHub Releases.
 *
 * Hver versjon publiseres med:
 *   latest.json                 – manifest: versjon, filnavn, SHA-256 og ed25519-signatur
 *   strom-app-<versjon>.json.gz – programfilene (bare koden, ikke Electron)
 *
 * Appen godtar bare oppdateringer som er signert med den private nøkkelen til utgiveren.
 * Den offentlige nøkkelen under er bygget inn i appen.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = 'doxybox/strom';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8A/p7Vk3OOlRPf0UK+OqqIK5Fx6A35O31PX3NxVvio=
-----END PUBLIC KEY-----`;

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/** Teksten som signeres. Endres aldri uten å endre alle utgaver samtidig. */
function signedText(m) {
  return ['strom-oppdatering-v1', m.versjon, m.fil, m.sha256, m.storrelse, m.min_electron || ''].join('\n');
}

function verifyManifest(m) {
  if (!m || !m.versjon || !m.fil || !m.sha256 || !m.signatur) return false;
  if (!/^[\w.-]+$/.test(m.fil) || !/^[0-9a-f]{64}$/.test(m.sha256)) return false;
  try {
    return crypto.verify(null, Buffer.from(signedText(m)), PUBLIC_KEY, Buffer.from(m.signatur, 'base64'));
  } catch (_) { return false; }
}

async function fetchBuf(url, maxBytes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'strom-updater' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('For stor fil');
    return buf;
  } finally { clearTimeout(t); }
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignorer */ } }

/**
 * Sjekker etter ny versjon og installerer den i appRoot (resources\app).
 * Returnerer { status: 'oppdatert'|'nyeste'|'krever-installasjon'|'av', versjon, side }.
 */
async function checkAndInstall({ currentVersion, electronVersion, appRoot, log }) {
  if (REPO.startsWith('EIER/') || PUBLIC_KEY.includes('NOKKEL')) return { status: 'av' };
  const testBase = process.env.STROM_UPDATE_BASE; // brukes bare til testing
  const base = testBase || `https://github.com/${REPO}/releases/latest/download`;
  const raw = await fetchBuf(`${base}/latest.json`, 64 * 1024);
  if (!raw) return { status: 'nyeste' };
  const m = JSON.parse(raw.toString('utf8'));
  if (!verifyManifest(m)) throw new Error('Ugyldig signatur på oppdateringen – ignorert');
  if (cmpVersion(m.versjon, currentVersion) <= 0) return { status: 'nyeste', versjon: m.versjon };
  const side = `https://github.com/${REPO}/releases/latest`;
  if (m.min_electron && cmpVersion(electronVersion, m.min_electron) < 0) {
    return { status: 'krever-installasjon', versjon: m.versjon, side };
  }

  const gz = await fetchBuf(testBase ? `${testBase}/${m.fil}` : `https://github.com/${REPO}/releases/download/v${m.versjon}/${m.fil}`, 20 * 1024 * 1024);
  if (!gz) throw new Error('Fant ikke oppdateringsfilen');
  if (gz.length !== Number(m.storrelse)) throw new Error('Feil størrelse på oppdateringen');
  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  if (sha !== m.sha256) throw new Error('Feil kontrollsum på oppdateringen');
  const bundle = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  if (bundle.versjon !== m.versjon || !bundle.filer) throw new Error('Ugyldig oppdateringspakke');

  // Pakk ut til en ny mappe først, og bytt ut filene når alt er på plass
  const stage = `${appRoot}.ny`;
  const backup = `${appRoot}.forrige`;
  rmrf(stage);
  for (const [rel, b64] of Object.entries(bundle.filer)) {
    const norm = path.normalize(rel);
    if (path.isAbsolute(norm) || norm.startsWith('..')) throw new Error(`Ugyldig filsti: ${rel}`);
    const dest = path.join(stage, norm);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
  }
  // Behold valg fra installasjonen
  for (const keep of ['autostart.flag']) {
    if (fs.existsSync(path.join(appRoot, keep))) fs.copyFileSync(path.join(appRoot, keep), path.join(stage, keep));
  }
  rmrf(backup);
  fs.cpSync(appRoot, backup, { recursive: true });
  try {
    // Skriv over filene på plass (mappen er i bruk og kan ikke byttes ut mens appen kjører)
    const wanted = new Set();
    const walk = (dir, rel = '') => {
      for (const n of fs.readdirSync(dir)) {
        const a = path.join(dir, n); const r = path.join(rel, n);
        if (fs.statSync(a).isDirectory()) walk(a, r); else wanted.add(r);
      }
    };
    walk(stage);
    for (const r of wanted) {
      fs.mkdirSync(path.dirname(path.join(appRoot, r)), { recursive: true });
      fs.copyFileSync(path.join(stage, r), path.join(appRoot, r));
    }
    // Fjern filer som ikke lenger finnes i ny versjon (utenom node_modules)
    const existing = new Set();
    const walk2 = (dir, rel = '') => {
      for (const n of fs.readdirSync(dir)) {
        const a = path.join(dir, n); const r = path.join(rel, n);
        if (fs.statSync(a).isDirectory()) walk2(a, r); else existing.add(r);
      }
    };
    walk2(path.join(appRoot, 'app'), 'app');
    for (const r of existing) if (!wanted.has(r)) fs.rmSync(path.join(appRoot, r), { force: true });
  } catch (e) {
    log(`Oppdatering feilet, gjenoppretter: ${e.message}`);
    fs.cpSync(backup, appRoot, { recursive: true, force: true });
    throw e;
  } finally {
    rmrf(stage);
  }
  return { status: 'oppdatert', versjon: m.versjon };
}

module.exports = { checkAndInstall, verifyManifest, signedText, cmpVersion, REPO };
