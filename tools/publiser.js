#!/usr/bin/env node
/*
 * Lager en signert oppdateringspakke for Strøm.
 *   node tools/publiser.js <privat-nøkkel.pem> <utmappe> [node_modules-mappe]
 * Resultat: <utmappe>/latest.json og <utmappe>/strom-app-<versjon>.json.gz
 * Publiser begge filene under oppdateringer/ på main-branchen.
 * Den private nøkkelen brukes bare lokalt og skal aldri legges i repoet.
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
// App-only updates support the Electron runtime shipped in existing 2.7.x installs.
// Updating Electron itself requires a full installer, not this code bundle.
const MIN_ELECTRON = '44.7.2';

const filer = {};
const EXPECTED_APP_FILES = [
  'app/han.js',
  'app/lib.js',
  'app/main.js',
  'app/nettselskaper.json',
  'app/preload.js',
  'app/updater.js',
  'app/ui/app.js',
  'app/ui/han.js',
  'app/ui/index.html',
  'app/ui/setup.js',
  'app/ui/style.css',
];
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|config\.json|credentials?(?:[._-][^/]*)?|secrets?(?:[._-][^/]*)?)$|\.(?:pem|key|p12|pfx|keystore)$/i;
const PRIVATE_KEY_MARKER = /-----BEGIN (?:(?:RSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/;

function add(abs, rel) {
  if (SENSITIVE_PATH.test(rel)) throw new Error(`Refusing to package a sensitive file: ${rel}`);
  const st = fs.statSync(abs);
  if (st.isDirectory()) { for (const n of fs.readdirSync(abs)) add(path.join(abs, n), path.posix.join(rel, n)); return; }
  if (/\.(bak|log)$/.test(abs)) return;
  const content = fs.readFileSync(abs);
  if (PRIVATE_KEY_MARKER.test(content.toString('utf8'))) throw new Error(`Refusing to package private-key material: ${rel}`);
  filer[rel] = content.toString('base64');
}
const actualAppFiles = [];
function listAppFiles(dir, rel = 'app') {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const child = path.posix.join(rel, name);
    if (fs.statSync(abs).isDirectory()) listAppFiles(abs, child);
    else actualAppFiles.push(child);
  }
}
listAppFiles(path.join(root, 'app'));
const unexpectedAppFiles = actualAppFiles.filter((name) => !EXPECTED_APP_FILES.includes(name));
const missingAppFiles = EXPECTED_APP_FILES.filter((name) => !actualAppFiles.includes(name));
if (unexpectedAppFiles.length || missingAppFiles.length) {
  throw new Error(`Unexpected app file set. Review before publishing. Unexpected: ${unexpectedAppFiles.join(', ') || 'none'}; missing: ${missingAppFiles.join(', ') || 'none'}`);
}
for (const rel of EXPECTED_APP_FILES) add(path.join(root, rel), rel);
add(path.join(root, 'strom.ico'), 'strom.ico');
// package.json slik den installerte appen trenger den
filer['package.json'] = Buffer.from(JSON.stringify({ name: 'strom', productName: 'Strøm', version: versjon, description: pkg.description, author: pkg.author, main: 'app/main.js', private: true, dependencies: pkg.dependencies }, null, 2)).toString('base64');
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

