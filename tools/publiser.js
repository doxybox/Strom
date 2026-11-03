#!/usr/bin/env node
/*
 * Lager en signert oppdateringspakke for Strøm.
 *   node tools/publiser.js <privat-nøkkel.pem> <utmappe> [node_modules-mappe]
 * Resultat: <utmappe>/latest.json og <utmappe>/strom-app-<versjon>.json.gz
 * Last dem opp som filer på en GitHub-release med tag v<versjon>.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { signedText, verifyManifest } = require('../app/updater');

const [keyFile, outDir, nodeModules = path.join(__dirname, '..', 'node_modules')] = process.argv.slice(2);
if (!keyFile || !outDir) { console.error('Bruk: node tools/publiser.js <privat.pem> <utmappe>'); process.exit(1); }
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const versjon = pkg.version;
const MIN_ELECTRON = '44.7.2';

const filer = {};
function add(abs, rel) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) { for (const n of fs.readdirSync(abs)) add(path.join(abs, n), path.posix.join(rel, n)); return; }
  if (/\.(bak|log)$/.test(abs)) return;
  filer[rel] = fs.readFileSync(abs).toString('base64');
}
add(path.join(root, 'app'), 'app');
add(path.join(root, 'strom.ico'), 'strom.ico');
// package.json slik den installerte appen trenger den
filer['package.json'] = Buffer.from(JSON.stringify({ name: 'strom', productName: 'Strøm', version: versjon, description: pkg.description, main: 'app/main.js', private: true, dependencies: pkg.dependencies }, null, 2)).toString('base64');
for (const m of ['js-yaml', 'argparse']) {
  const dir = path.join(nodeModules, m);
  for (const n of fs.readdirSync(dir)) if (n !== 'dist') add(path.join(dir, n), `node_modules/${m}/${n}`);
}

const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ versjon, filer })), { level: 9 });
const fil = `strom-app-${versjon}.json.gz`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, fil), gz);
const m = {
  versjon, fil,
  sha256: crypto.createHash('sha256').update(gz).digest('hex'),
  storrelse: gz.length,
  min_electron: MIN_ELECTRON,
  publisert: new Date().toISOString(),
};
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
m.signatur = crypto.sign(null, Buffer.from(signedText(m)), key).toString('base64');
if (!verifyManifest(m)) { console.error('Signaturen stemmer ikke med nøkkelen i app/updater.js!'); process.exit(2); }
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(m, null, 2));
console.log(`Strøm ${versjon}: ${Object.keys(filer).length} filer, ${(gz.length / 1024).toFixed(0)} KB, signatur OK`);
