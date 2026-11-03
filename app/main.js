'use strict';
const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeTheme, nativeImage, screen, safeStorage,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const lib = require('./lib');
const han = require('./han');
const updater = require('./updater');

let VERSION = '2.7.0';
try { VERSION = require('../package.json').version || VERSION; } catch (_) { /* behold */ }
const APP_DIR = __dirname;                       // programfilene
const ROOT = path.resolve(__dirname, '..');      // app-roten (package.json, strom.ico)
// Installert via Setup.exe: koden ligger i <installasjonsmappe>\resources\app, data i AppData.
const INSTALLED = path.basename(ROOT) === 'app' && path.basename(path.dirname(ROOT)) === 'resources';
app.setName('Strøm');
const DATA_DIR = process.env.STROM_DATA || (INSTALLED ? path.join(app.getPath('appData'), 'Strom') : ROOT);
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* finnes */ }
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const FORBRUK_DIR = path.join(DATA_DIR, 'forbruk');
const LOG_PATH = path.join(DATA_DIR, 'widget.log');
const ICON = path.join(ROOT, 'strom.ico');
const AUMID = 'no.robin.strom';

function log(msg) {
  const t = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Oslo' });
  try { fs.appendFileSync(LOG_PATH, `${t}  [app] ${msg}\n`); } catch (_) { /* ignorer */ }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.setAppUserModelId(AUMID);
nativeTheme.themeSource = 'dark';

let cfg = lib.loadConfig(CONFIG_PATH);
if (lib.migrateConfig(cfg)) lib.saveConfig(CONFIG_PATH, cfg);

// ---------------------------------------------------------------------------
// Nettselskaper (fri-nettleie). Medfølgende liste + ferskere kopi fra GitHub.
// ---------------------------------------------------------------------------
const BUNDLED_TARIFFS = path.join(APP_DIR, 'nettselskaper.json');
const RAW_URL = 'https://raw.githubusercontent.com/kraftsystemet/fri-nettleie/main/tariffer/';
let selskaper = [];
function loadSelskaper() {
  try { selskaper = JSON.parse(fs.readFileSync(BUNDLED_TARIFFS, 'utf8')).selskaper || []; } catch (e) { log(`Nettselskaper: ${e.message}`); selskaper = []; }
  for (const s of selskaper) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `nettleie_${s.id}.json`), 'utf8'));
      if (c && c.tariffer && (c.sist_oppdatert || '') >= (s.sist_oppdatert || '')) Object.assign(s, { tariffer: c.tariffer, sist_oppdatert: c.sist_oppdatert, kilder: c.kilder || s.kilder });
    } catch (_) { /* ingen ferskere kopi */ }
  }
}
function applySelskap() {
  cfg.__selskap = selskaper.find((s) => s.id === cfg.nettselskap_id) || null;
}
loadSelskaper();
applySelskap();

// ---------------------------------------------------------------------------
// HAN-leser
// ---------------------------------------------------------------------------
const HAN_HOURS = path.join(CACHE_DIR, 'han_timer.json');
let hanHours = new Map();
try { hanHours = new Map(JSON.parse(fs.readFileSync(HAN_HOURS, 'utf8')).map(([k, v]) => [Number(k), v])); } catch (_) { /* ingen ennå */ }
let hanLive = null;
let hanErr = null;
let hanFails = 0;
let hanScanning = false;
let hanPending = [];          // funnet, men krever passord
let lastHanHours = 0;
let lastAutoScan = 0;
const hanWarned = new Set();

function hanAuth() {
  const h = cfg.han;
  if (!h || !h.bruker) return null;
  let passord = '';
  try {
    passord = h.passord_kryptert && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(h.passord_kryptert, 'base64')) : (h.passord || '');
  } catch (_) { passord = ''; }
  return { bruker: h.bruker, passord };
}
function setHanAuth(h, auth) {
  delete h.passord; delete h.passord_kryptert; delete h.bruker;
  if (!auth || !auth.bruker) return;
  h.bruker = auth.bruker;
  if (safeStorage.isEncryptionAvailable()) h.passord_kryptert = safeStorage.encryptString(auth.passord || '').toString('base64');
  else h.passord = auth.passord || '';
}
function saveHanHours() {
  // behold 70 dager
  const cutoff = Date.now() - 70 * 86400000;
  for (const k of hanHours.keys()) if (k < cutoff) hanHours.delete(k);
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(HAN_HOURS, JSON.stringify([...hanHours])); } catch (e) { log(`HAN-lagring: ${e.message}`); }
}

function sendLive() {
  if (!win || win.isDestroyed()) return;
  let cap = null;
  if (hanLive && hanLive.topper && hanLive.topper.length) {
    const top = [...hanLive.topper].sort((a, b) => b - a).slice(0, 3);
    const kw = top.reduce((a, c) => a + c, 0) / top.length;
    cap = { kw, ...lib.kapasitet(cfg, kw, lib.osloParts(Date.now()).date), topper: top };
  }
  win.webContents.send('live', {
    tilkoblet: !!cfg.han,
    enhet: cfg.han ? { navn: cfg.han.navn, maaler: cfg.han.maaler, ip: cfg.han.ip } : null,
    data: hanLive,
    cap,
    feil: hanErr,
    soker: hanScanning,
    ventende: hanPending,
  });
}

async function pollHan() {
  if (!cfg.han) return;
  const d = han.driver(cfg.han.driver);
  if (!d) return;
  try {
    hanLive = await d.read(cfg.han, hanAuth());
    hanErr = null;
    hanFails = 0;
    if (Date.now() - lastHanHours > 5 * 60000) {
      lastHanHours = Date.now();
      const hrs = await d.hours(cfg.han, hanAuth(), lib.osloParts, lib.osloToUtc);
      let changed = false;
      for (const [k, v] of hrs) if (hanHours.get(k) !== v) { hanHours.set(k, v); changed = true; }
      if (changed) { saveHanHours(); refresh(true); }
    }
    checkCapacityWarning();
  } catch (e) {
    hanFails++;
    hanErr = e.code === 'AUTH' ? 'Feil brukernavn eller passord for HAN-leseren' : 'Får ikke kontakt med HAN-leseren';
    if (hanFails === 1) log(`HAN: ${e.message}`);
    // Ny IP-adresse (f.eks. etter omstart av ruteren)? Let etter samme leser.
    if (hanFails === 24 && cfg.han.id && e.code !== 'AUTH') relocateHan();
  }
  sendLive();
}

async function relocateHan() {
  if (hanScanning) return;
  hanScanning = true;
  try {
    const list = await han.scan({ auth: hanAuth() });
    const same = list.find((x) => x.id && x.id === cfg.han.id);
    if (same && same.ip !== cfg.han.ip) {
      log(`HAN-leseren har fått ny adresse: ${same.ip}`);
      cfg.han.ip = same.ip;
      persistConfig();
      hanFails = 0;
    }
  } catch (e) { log(`HAN-søk: ${e.message}`); }
  hanScanning = false;
}

async function connectHan(dev, auth) {
  const d = han.driver(dev.driver);
  if (!d) throw new Error('Ukjent lesertype');
  const info = dev.needsAuth ? await d.probe(dev.ip, auth) : dev;
  if (!info || info.needsAuth) throw Object.assign(new Error('Feil brukernavn eller passord'), { code: 'AUTH' });
  await d.read(info, auth);
  cfg.han = { driver: info.driver, ip: info.ip, id: info.id, navn: info.navn, maaler: info.maaler, hostname: info.hostname };
  setHanAuth(cfg.han, auth);
  persistConfig();
  hanPending = [];
  hanFails = 0;
  lastHanHours = 0;
  log(`Koblet til HAN-leser ${info.navn} (${info.ip})`);
  if (tray) tray.setContextMenu(buildTrayMenu());
  await pollHan();
  return cfg.han;
}

/** Automatisk søk: kobler til av seg selv hvis det finnes nøyaktig én leser uten passord. */
async function autoScanHan() {
  if (cfg.han || cfg.han_auto_sok === false || hanScanning) return;
  if (Date.now() - lastAutoScan < 30 * 60000) return;
  lastAutoScan = Date.now();
  hanScanning = true; sendLive();
  try {
    const list = await han.scan();
    const open = list.filter((x) => !x.needsAuth);
    hanPending = list.filter((x) => x.needsAuth);
    if (open.length === 1) {
      await connectHan(open[0], null);
      notify('HAN-leser funnet ⚡', `${open[0].navn} på ${open[0].maaler}. Forbruket hentes nå automatisk.`);
    } else if (open.length > 1 || hanPending.length) {
      notify('Fant HAN-leser på nettverket', 'Åpne Strøm for å koble den til.');
    }
  } catch (e) { log(`Automatisk HAN-søk: ${e.message}`); }
  hanScanning = false;
  sendLive();
}

/** Varsler hvis forbruket denne timen er på vei til å gi et dyrere kapasitetstrinn. */
function checkCapacityWarning() {
  if (!hanLive || cfg.varsler === false || !hanLive.topper || hanLive.topper.length < 3) return;
  const now = Date.now();
  const p = lib.osloParts(now);
  const top = [...hanLive.topper].sort((a, b) => b - a).slice(0, 3);
  const nowKap = lib.kapasitet(cfg, top.reduce((a, c) => a + c, 0) / 3, p.date);
  if (!nowKap.grense) return;
  const restAvTimen = (60 - p.min) / 60;
  const prognose = (hanLive.timeKwh || 0) + hanLive.kw * restAvTimen;
  if (prognose <= top[2]) return;
  const nyttSnitt = (top[0] + top[1] + Math.max(top[2], prognose)) / 3;
  const key = `${p.date}-${p.h}`;
  if (nyttSnitt >= nowKap.grense && !hanWarned.has(key) && p.min >= 5) {
    hanWarned.add(key);
    const ny = lib.kapasitet(cfg, nyttSnitt, p.date);
    notify('Høyt strømforbruk nå ⚠️',
      `Huset trekker ${hanLive.kw.toFixed(1).replace('.', ',')} kW. Fortsetter det ut timen, havner dere i neste kapasitetstrinn (+${Math.round(ny.kr - nowKap.kr)} kr denne måneden).`);
  }
}

function normYaml(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(normYaml);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = normYaml(x); return o; }
  return v;
}
let lastTariffCheck = 0;
/** Henter oppdaterte tariffer for valgt nettselskap fra GitHub (én gang i døgnet). */
async function updateTariffFromGithub(force = false) {
  const id = cfg.nettselskap_id;
  if (!id || id === 'egen') return;
  if (!force && Date.now() - lastTariffCheck < 12 * 3600 * 1000) return;
  lastTariffCheck = Date.now();
  let yaml;
  try { yaml = require('js-yaml'); } catch (_) { return; } // installeres av Installer.bat
  try {
    const r = await fetch(`${RAW_URL}${encodeURIComponent(id)}.yml`, { headers: { 'User-Agent': 'strom-app' } });
    if (!r.ok) return;
    const d = normYaml(yaml.load(await r.text()));
    const tariffer = (d.tariffer || []).filter((t) => (t.kundegrupper || []).includes('husholdning'));
    if (!tariffer.length) return;
    const s = selskaper.find((x) => x.id === id);
    if (!s || (d.sist_oppdatert || '') <= (s.sist_oppdatert || '')) return;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `nettleie_${id}.json`), JSON.stringify({ tariffer, sist_oppdatert: d.sist_oppdatert, kilder: d.kilder }));
    Object.assign(s, { tariffer, sist_oppdatert: d.sist_oppdatert });
    applySelskap();
    log(`Oppdaterte nettleie for ${s.navn} (${d.sist_oppdatert})`);
    refresh(true);
  } catch (e) { log(`Nettleie fra GitHub: ${e.message}`); }
}
let win = null;
let tray = null;
let quitting = false;
let state = null;            // siste data sendt til vinduet
let busy = false;
let lastFetch = 0;
let lastAttempt = 0;
let lastFetchDay = null;
let sig = null;
const dlSeen = new Set();
const notified = new Set();
let hadTomorrow = null;
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Vindu
// ---------------------------------------------------------------------------
function iconImage() {
  try { return nativeImage.createFromPath(ICON); } catch (_) { return undefined; }
}

function createWindow() {
  const b = cfg.electron_vindu || {};
  const opts = {
    width: b.width || 400,
    height: b.height || 760,
    minWidth: 340,
    minHeight: 560,
    title: 'Strøm',
    icon: iconImage(),
    backgroundColor: '#16181d',
    autoHideMenuBar: true,
    show: false,
    alwaysOnTop: !!cfg.alltid_overst,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    // bare gjenopprett posisjonen hvis den fortsatt er på en skjerm
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + 80 > a.x && b.x < a.x + a.width && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
    });
    if (onScreen) { opts.x = b.x; opts.y = b.y; }
  }
  win = new BrowserWindow(opts);
  win.setMenu(null);
  win.loadFile(path.join(APP_DIR, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    if (b.maximized) win.maximize();
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.webContents.on('did-finish-load', () => { if (state) win.webContents.send('state', state); });

  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const maximized = win.isMaximized();
      const nb = maximized ? (cfg.electron_vindu || {}) : win.getBounds();
      cfg.electron_vindu = { x: nb.x, y: nb.y, width: nb.width, height: nb.height, maximized };
      persistConfig();
    }, 500);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);

  win.on('close', (e) => {
    if (!quitting && cfg.lukk_til_systemstatusfelt && tray) {
      e.preventDefault();
      win.hide();
      if (!cfg._sett_tray_hint) {
        cfg._sett_tray_hint = true;
        persistConfig();
        notify('Strøm kjører fortsatt', 'Du finner den ved klokka nede til høyre. Høyreklikk lyn-ikonet for å avslutte.');
      }
    }
  });
  win.on('closed', () => { win = null; });

  // Lenker åpnes i nettleseren
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Lagrer config uten å trigge vår egen fil-overvåking
let selfWrite = 0;
function persistConfig() {
  selfWrite = Date.now();
  lib.saveConfig(CONFIG_PATH, cfg);
}

// ---------------------------------------------------------------------------
// Systemstatusfelt (tray)
// ---------------------------------------------------------------------------
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Vis Strøm', click: showWindow },
    { label: 'Oppdater nå', click: () => refresh(true) },
    { label: 'Endre sone, nettselskap og avtale …', click: () => { showWindow(); if (win) win.webContents.send('show-setup'); } },
    { type: 'separator' },
    {
      label: 'Spotpris + strømstøtte', type: 'radio', checked: cfg.ordning !== 'norgespris',
      click: () => setOrdning('stromstotte'),
    },
    {
      label: 'Norgespris', type: 'radio', checked: cfg.ordning === 'norgespris',
      click: () => setOrdning('norgespris'),
    },
    { type: 'separator' },
    {
      label: 'Alltid øverst', type: 'checkbox', checked: !!cfg.alltid_overst,
      click: (mi) => { cfg.alltid_overst = mi.checked; persistConfig(); if (win) win.setAlwaysOnTop(mi.checked); },
    },
    {
      label: 'Start med Windows', type: 'checkbox', checked: !!cfg.start_med_windows,
      click: (mi) => { cfg.start_med_windows = mi.checked; persistConfig(); applyLoginItem(); },
    },
    {
      label: 'Varsler om billige timer', type: 'checkbox', checked: cfg.varsler !== false,
      click: (mi) => { cfg.varsler = mi.checked; persistConfig(); },
    },
    { type: 'separator' },
    { label: 'Åpne forbruksmappe (Elhub-filer)', click: () => openPath(FORBRUK_DIR) },
    { label: 'Åpne innstillinger (config.json)', click: () => openPath(CONFIG_PATH) },
    { label: 'Åpne elhub.no', click: () => shell.openExternal('https://elhub.no') },
    { label: cfg.han ? `HAN-leser: ${cfg.han.navn} …` : 'Finn HAN-leser …', click: () => { showWindow(); if (win) win.webContents.send('show-han'); } },
    { type: 'separator' },
    { label: `Strøm ${VERSION}${INSTALLED ? ' – se etter oppdateringer' : ''}`, enabled: INSTALLED, click: () => checkUpdates(true) },
    { label: 'Avslutt', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(iconImage());
  tray.setToolTip('Strøm');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow();
  });
}

function applyLoginItem() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!cfg.start_med_windows,
      path: process.execPath,
      args: INSTALLED ? ['--hidden'] : [ROOT, '--hidden'],
    });
  } catch (e) { log(`Autostart: ${e.message}`); }
}

function setOrdning(o) {
  cfg.ordning = o;
  persistConfig();
  if (tray) tray.setContextMenu(buildTrayMenu());
  refresh(true);
}

function openPath(p) {
  try { if (p === FORBRUK_DIR) fs.mkdirSync(p, { recursive: true }); } catch (_) { /* ignorer */ }
  shell.openPath(p).then((err) => { if (err) log(`Kunne ikke åpne ${p}: ${err}`); });
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: iconImage(), silent: false });
    n.on('click', showWindow);
    n.show();
  } catch (e) { log(`Varsel: ${e.message}`); }
}

/** Lager snarveier (med riktig app-ID slik at varsler vises) første gang. */
function ensureShortcuts() {
  if (process.platform !== 'win32' || cfg._snarveier_mappe === ROOT) return;
  const opts = {
    target: process.execPath,
    args: INSTALLED ? '' : `"${ROOT}"`,
    cwd: ROOT,
    icon: ICON,
    iconIndex: 0,
    appUserModelId: AUMID,
    description: 'Strømpris og forbruk',
  };
  const places = [
    path.join(app.getPath('desktop'), 'Strøm.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Strøm.lnk'),
  ];
  for (const p of places) {
    // Installert: skrivebordssnarveien lages bare hvis brukeren valgte den i installasjonen
    if (INSTALLED && p.includes(app.getPath('desktop')) && !fs.existsSync(p)) continue;
    try { shell.writeShortcutLink(p, fs.existsSync(p) ? 'replace' : 'create', opts); } catch (e) { log(`Snarvei ${p}: ${e.message}`); }
  }
  cfg._snarveier_mappe = ROOT;
  delete cfg._snarveier_v2;
  persistConfig();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
function todayStr(ms = Date.now()) { return lib.osloParts(ms).date; }

/** Sammenligning: hva prisen ville vært med spotpris og strømstøtte. */
function altCfg() { return { ...cfg, ordning: 'stromstotte', kraft_paaslag_ore_inkl_mva: 0 }; }

function seriesFor(entries) {
  const hrs = lib.hourlyAvg(entries);
  const alt = altCfg();
  return [...hrs].sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t, spot: p, ...lib.beregn(cfg, t, p), altTotal: lib.beregn(alt, t, p).total }));
}

let lastPrune = 0;
/** Sletter prisfiler eldre enn 70 dager. */
function pruneCache() {
  if (Date.now() - lastPrune < 86400000) return;
  lastPrune = Date.now();
  const cutoff = lib.dateAdd(lib.osloParts(Date.now()).date, -70);
  try {
    for (const n of fs.readdirSync(CACHE_DIR)) {
      const m = n.match(/^(\d{4}-\d{2}-\d{2})_NO\d/);
      if (m && m[1] < cutoff) fs.rmSync(path.join(CACHE_DIR, n), { force: true });
    }
  } catch (_) { /* ignorer */ }
}

async function refresh(force = false) {
  if (busy) return;
  busy = true;
  lastAttempt = Date.now();
  if (win) win.webContents.send('busy', true);
  try {
    const zone = cfg.prissone;
    const now = Date.now();
    const p = lib.osloParts(now);
    const today = p.date;
    const todayEntries = lib.parseEntries(await lib.fetchDayPrices(today, zone, CACHE_DIR));
    let tomorrowEntries = [];
    if (p.h * 60 + p.min >= 12 * 60 + 45) {
      try {
        tomorrowEntries = lib.parseEntries(await lib.fetchDayPrices(lib.dateAdd(today, 1), zone, CACHE_DIR));
      } catch (e) { log(`Morgendagens priser: ${e.message}`); }
    }
    // Uke: kjente priser + anslag ut fra de siste 14 dagene
    const hist = [];
    for (let i = 14; i >= 1; i--) {
      const d = lib.dateAdd(today, -i);
      try { hist.push({ date: d, hours: lib.hourlyAvg(lib.parseEntries(await lib.fetchDayPrices(d, zone, CACHE_DIR))) }); } catch (_) { /* hopp over */ }
    }
    hist.push({ date: today, hours: lib.hourlyAvg(todayEntries) });
    if (tomorrowEntries.length) hist.push({ date: lib.dateAdd(today, 1), hours: lib.hourlyAvg(tomorrowEntries) });
    const known = tomorrowEntries.length ? 2 : 1;
    const targets = []; for (let i = known; i < 7; i++) targets.push(lib.dateAdd(today, i));
    const fc = lib.forecastSpot(hist, targets);
    const alt = altCfg();
    const week = [{ date: today, prognose: false, series: seriesFor(todayEntries) }];
    if (tomorrowEntries.length) week.push({ date: lib.dateAdd(today, 1), prognose: false, series: seriesFor(tomorrowEntries) });
    for (const d of targets) {
      const series = [...fc].filter(([t]) => lib.osloParts(t).date === d).sort((a, b) => a[0] - b[0])
        .map(([t, p]) => ({ t, spot: p, ...lib.beregn(cfg, t, p), altTotal: lib.beregn(alt, t, p).total }));
      if (series.length) week.push({ date: d, prognose: true, series });
    }
    pruneCache();

    const { cons, hourly, files, errors } = lib.loadConsumption(FORBRUK_DIR);
    for (const [k, v] of hanHours) if (!cons.has(k)) cons.set(k, v); // Elhub-tall går foran
    const prices = lib.hourlyAvg(todayEntries);
    const monthStart = `${today.slice(0, 7)}-01`;
    const prevStart = `${lib.dateAdd(monthStart, -1).slice(0, 7)}-01`;
    const days = [...new Set([...cons.keys()].map((h) => lib.osloParts(h).date))]
      .filter((d) => d >= prevStart && d < today).sort();
    for (const d of days) {
      try {
        for (const [k, v] of lib.hourlyAvg(lib.parseEntries(await lib.fetchDayPrices(d, zone, CACHE_DIR)))) prices.set(k, v);
      } catch (e) { log(`Pris for ${d}: ${e.message}`); }
    }

    const [y, m] = today.split('-').map(Number);
    const prevMonth = lib.dateAdd(monthStart, -1);
    const [py, pm] = prevMonth.split('-').map(Number);
    let lastDay = null; let yesterday = null;
    if (cons.size) {
      lastDay = lib.osloParts(Math.max(...cons.keys())).date;
      yesterday = lib.dayStats(cfg, cons, prices, lastDay);
    }

    state = {
      needsSetup: !cfg.oppsett_ferdig,
      selskap: cfg.nettselskap_id === 'egen' ? 'Egne priser' : (cfg.__selskap ? cfg.__selskap.navn : 'Nettselskap ikke valgt'),
      leverandor: cfg.stromleverandor || '',
      version: VERSION,
      now,
      today,
      zone,
      ordning: cfg.ordning,
      nettselskap: cfg.nettselskap,
      quarters: todayEntries.concat(tomorrowEntries).map((x) => ({ s: x.s, e: x.e, ...lib.beregn(cfg, x.s, x.p), altTotal: lib.beregn(altCfg(), x.s, x.p).total })),
      norgespris: cfg.ordning === 'norgespris',
      mva: lib.mvaFactor(cfg),
      kilde: todayEntries.length && todayEntries.every((x) => x.np) ? 'Nord Pool' : 'hvakosterstrommen.no',
      trinn: cfg.__selskap && cfg.nettselskap_id !== 'egen' ? (lib.tariffSummary(cfg, cfg.__selskap, today) || {}).trinn || [] : [],
      todaySeries: seriesFor(todayEntries),
      tomorrowSeries: seriesFor(tomorrowEntries),
      week,
      hasConsumption: cons.size > 0,
      hourly,
      files,
      errors,
      lastDay,
      yesterday,
      todayStats: lib.dayStats(cfg, cons, prices, today) || { kwh: 0, kr: 0 },
      month: lib.monthStats(cfg, cons, prices, y, m, hourly),
      monthAlt: cfg.ordning === 'norgespris' ? lib.monthStats(altCfg(), cons, prices, y, m, hourly) : null,
      prevAlt: cfg.ordning === 'norgespris' ? lib.monthStats(altCfg(), cons, prices, py, pm, hourly) : null,
      monthName: m,
      prev: lib.monthStats(cfg, cons, prices, py, pm, hourly),
      prevName: pm,
      lastFetch: Date.now(),
      han: !!cfg.han,
      error: null,
    };
    lastFetch = Date.now();
    lastFetchDay = today;
    afterRefresh();
  } catch (e) {
    log(`Feil ved oppdatering: ${e.stack || e}`);
    if (state) state.error = 'Klarte ikke oppdatere – viser forrige data';
    else state = { version: VERSION, needsSetup: !cfg.oppsett_ferdig, error: `Fikk ikke hentet priser (${e.message}). Prøver igjen snart.` };
  } finally {
    busy = false;
    if (win) { win.webContents.send('busy', false); win.webContents.send('state', state); }
    updateTray();
  }
}

function currentQuarter() {
  if (!state || !state.quarters) return null;
  const now = Date.now();
  return state.quarters.find((q) => q.s <= now && now < q.e) || null;
}

function fmt(ore) { return (ore / 100).toFixed(2).replace('.', ','); }

function updateTray() {
  if (!tray) return;
  const q = currentQuarter();
  const lines = ['Strøm'];
  if (q) lines.push(`Nå: ${fmt(q.total)} kr/kWh`);
  if (hanLive && cfg.han) lines.push(`Effekt nå: ${hanLive.kw.toFixed(1).replace('.', ',')} kW`);
  if (state && state.month) lines.push(`Denne mnd: ${Math.round(state.month.totalKr)} kr`);
  tray.setToolTip(lines.join('\n'));
  if (win && q) win.setTitle(`Strøm · ${fmt(q.total)} kr/kWh`);
}

function afterRefresh() {
  // Varsel når morgendagens priser kommer
  const hasT = state.tomorrowSeries.length > 0;
  if (hadTomorrow === false && hasT && cfg.varsler !== false && cfg.ordning !== 'norgespris') {
    const s = state.tomorrowSeries;
    const avg = s.reduce((a, c) => a + c.total, 0) / s.length;
    const w = lib.cheapestWindow(s, 3);
    notify('Morgendagens strømpriser er klare',
      `Snitt ${fmt(avg)} kr/kWh. Billigst kl. ${String(lib.osloParts(w.start).h).padStart(2, '0')}–${String(lib.osloParts(w.end).h).padStart(2, '0')} (${fmt(w.avg)}).`);
  }
  hadTomorrow = hasT;
}

/** Varsler når dagens billigste 3-timersvindu starter (hvis det er merkbart billigere). */
function checkCheapNotification() {
  if (!state || !state.todaySeries || cfg.varsler === false || cfg.ordning === 'norgespris') return;
  const all = state.todaySeries.concat(state.tomorrowSeries || []);
  const now = Date.now();
  const day = state.todaySeries;
  if (day.length < 3) return;
  const w = lib.cheapestWindow(day, 3);
  const avg = day.reduce((a, c) => a + c.total, 0) / day.length;
  const key = `billig-${w.start}`;
  if (notified.has(key)) return;
  if (now >= w.start - 5 * 60000 && now < w.start + 30 * 60000 && w.avg < avg * 0.85) {
    notified.add(key);
    const end = lib.osloParts(w.end).h;
    notify('Billig strøm nå ⚡',
      `${fmt(w.avg)} kr/kWh i snitt frem til kl. ${String(end).padStart(2, '0')} – fint tidspunkt for vask, oppvask og lading.`);
  }
  void all;
}

function tick() {
  try {
    if (cfg.importer_fra_nedlastinger !== false) {
      const imp = lib.importFromDownloads(app.getPath('downloads') || path.join(os.homedir(), 'Downloads'), FORBRUK_DIR, dlSeen);
      for (const n of imp) log(`Importerte ${n} fra Nedlastinger`);
    }
  } catch (e) { log(`Import: ${e.message}`); }
  const s = lib.consumptionSignature(FORBRUK_DIR);
  const now = Date.now();
  const p = lib.osloParts(now);
  const sinceOk = now - lastFetch;
  const sinceTry = now - lastAttempt;
  const waitingTomorrow = p.h * 60 + p.min >= 12 * 60 + 45 && state && state.tomorrowSeries && !state.tomorrowSeries.length;
  const due = sinceOk > Math.max(30, cfg.oppdater_sekunder || 60) * 1000
    || p.date !== lastFetchDay
    || (waitingTomorrow && sinceTry > 120000)
    || (!state && sinceTry > 60000);
  if (s !== sig || (due && sinceTry > 20000)) {
    sig = s;
    refresh();
  } else {
    updateTray();
  }
  checkCheapNotification();
  updateTariffFromGithub();
  if (Date.now() - startedAt > 20000) autoScanHan();
  if (Date.now() - startedAt > 30000) checkUpdates();
}

// ---------------------------------------------------------------------------
// Automatiske oppdateringer: overvåk programfilene
// ---------------------------------------------------------------------------
function syntaxOk(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    // eslint-disable-next-line no-new
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: file });
    return true;
  } catch (e) {
    log(`Ny versjon av ${path.basename(file)} har feil, venter på rettet fil: ${e.message}`);
    return false;
  }
}

function watchConfigOnly() {
  // config.json endret for hånd -> les inn på nytt
  let ct = null;
  try {
    fs.watch(DATA_DIR, (ev, name) => {
      if (name !== 'config.json' || Date.now() - selfWrite < 1500) return;
      clearTimeout(ct);
      ct = setTimeout(() => {
        const prevVindu = cfg.electron_vindu;
        cfg = lib.loadConfig(CONFIG_PATH);
        if (!cfg.electron_vindu) cfg.electron_vindu = prevVindu;
        applySelskap();
        if (win) win.setAlwaysOnTop(!!cfg.alltid_overst);
        if (tray) tray.setContextMenu(buildTrayMenu());
        log('Innstillinger lest inn på nytt');
        refresh(true);
      }, 600);
    });
  } catch (e) { log(`Overvåking config: ${e.message}`); }
}

function watchForUpdates() {
  let timer = null;
  const pending = new Set();
  const handle = () => {
    const files = [...pending];
    pending.clear();
    const mainFiles = files.filter((f) => /\.js$/.test(f) && !f.includes(`${path.sep}ui${path.sep}`));
    if (mainFiles.length) {
      if (!mainFiles.every((f) => !fs.existsSync(f) || syntaxOk(f))) return;
      log('Ny versjon funnet - starter på nytt');
      quitting = true;
      app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden').concat(win && win.isVisible() ? [] : ['--hidden']) });
      app.exit(0);
      return;
    }
    if (win && !win.isDestroyed()) {
      log('Nytt utseende funnet - laster inn på nytt');
      win.webContents.reloadIgnoringCache();
    }
  };
  const onChange = (dir) => (ev, name) => {
    if (!name) return;
    pending.add(path.join(dir, name));
    clearTimeout(timer);
    timer = setTimeout(handle, 800);
  };
  if (INSTALLED) { watchConfigOnly(); return; }
  try { fs.watch(APP_DIR, onChange(APP_DIR)); } catch (e) { log(`Overvåking: ${e.message}`); }
  // Reserve: sjekk endringstid hvert 15. sekund (fs.watch er ikke alltid pålitelig på Windows)
  const snap = () => {
    const m = new Map();
    for (const dir of [APP_DIR, path.join(APP_DIR, 'ui')]) {
      try { for (const n of fs.readdirSync(dir)) { const f = path.join(dir, n); const st = fs.statSync(f); if (st.isFile()) m.set(f, st.mtimeMs); } } catch (_) { /* ignorer */ }
    }
    return m;
  };
  let last = snap();
  setInterval(() => {
    const now = snap();
    for (const [f, mt] of now) if (last.get(f) !== mt) pending.add(f);
    last = now;
    if (pending.size) { clearTimeout(timer); timer = setTimeout(handle, 800); }
  }, 15000);
  try { fs.watch(path.join(APP_DIR, 'ui'), onChange(path.join(APP_DIR, 'ui'))); } catch (e) { log(`Overvåking ui: ${e.message}`); }

  watchConfigOnly();
}

// ---------------------------------------------------------------------------
// Automatiske oppdateringer (bare installert versjon)
// ---------------------------------------------------------------------------
let lastUpdateCheck = 0;
let updating = false;
async function checkUpdates(manual = false) {
  if (!INSTALLED || updating || (!manual && cfg.auto_oppdater === false)) return;
  if (!manual && Date.now() - lastUpdateCheck < 60 * 60000) return;
  lastUpdateCheck = Date.now();
  updating = true;
  try {
    const r = await updater.checkAndInstall({ currentVersion: VERSION, electronVersion: process.versions.electron, appRoot: ROOT, log });
    if (r.status === 'oppdatert') {
      log(`Oppdatert til ${r.versjon} – starter på nytt`);
      cfg._oppdatert_fra = VERSION;
      persistConfig();
      quitting = true;
      app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden').concat(win && win.isVisible() ? [] : ['--hidden']) });
      app.exit(0);
      return;
    }
    if (r.status === 'krever-installasjon' && cfg._varslet_installasjon !== r.versjon) {
      cfg._varslet_installasjon = r.versjon; persistConfig();
      const n = new Notification({ title: `Strøm ${r.versjon} er klar`, body: 'Denne versjonen må installeres på nytt. Klikk for å laste ned.', icon: iconImage() });
      n.on('click', () => shell.openExternal(r.side)); n.show();
    }
    if (manual) notify('Strøm', r.status === 'nyeste' ? `Du har nyeste versjon (${VERSION}).` : r.status === 'av' ? 'Automatiske oppdateringer er ikke satt opp.' : `Ny versjon: ${r.versjon}`);
  } catch (e) {
    log(`Oppdatering: ${e.message}`);
    if (manual) notify('Strøm', `Fant ikke oppdateringer: ${e.message}`);
  } finally { updating = false; }
}

// ---------------------------------------------------------------------------
// IPC fra vinduet
// ---------------------------------------------------------------------------
ipcMain.on('refresh', () => refresh(true));
ipcMain.on('set-ordning', (_e, o) => setOrdning(o === 'norgespris' ? 'norgespris' : 'stromstotte'));
ipcMain.on('open-forbruk', () => openPath(FORBRUK_DIR));
ipcMain.on('open-config', () => openPath(CONFIG_PATH));
ipcMain.on('open-elhub', () => shell.openExternal('https://elhub.no'));
ipcMain.handle('setup-data', () => ({
  selskaper: selskaper.map((x) => ({ id: x.id, navn: x.navn, soner: x.soner, fylker: x.fylker, kunder: x.kunder, sist_oppdatert: x.sist_oppdatert, kilde: (x.kilder || [])[0] || '' })),
  cfg: {
    oppsett_ferdig: !!cfg.oppsett_ferdig, prissone: cfg.prissone, nettselskap_id: cfg.nettselskap_id, avgiftssone: cfg.avgiftssone,
    ordning: cfg.ordning, stromleverandor: cfg.stromleverandor, kraft_paaslag_ore_inkl_mva: cfg.kraft_paaslag_ore_inkl_mva,
    kraft_fast_kr_per_mnd: cfg.kraft_fast_kr_per_mnd, egen_dag_ore: cfg.egen_dag_ore, egen_natt_ore: cfg.egen_natt_ore,
    egen_kapasitet_kr: cfg.egen_kapasitet_kr,
  },
}));
ipcMain.handle('tariff-summary', (_e, id, avgiftssone) => {
  const s = selskaper.find((x) => x.id === id);
  if (!s) return null;
  return lib.tariffSummary({ ...cfg, avgiftssone }, s, lib.osloParts(Date.now()).date);
});
ipcMain.on('save-setup', (_e, v) => {
  const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
  if (['NO1', 'NO2', 'NO3', 'NO4', 'NO5'].includes(v.prissone)) cfg.prissone = v.prissone;
  if (v.nettselskap_id === 'egen' || selskaper.some((x) => x.id === v.nettselskap_id)) cfg.nettselskap_id = v.nettselskap_id;
  if (['sor', 'nord', 'tiltak'].includes(v.avgiftssone)) cfg.avgiftssone = v.avgiftssone;
  cfg.ordning = v.ordning === 'norgespris' ? 'norgespris' : 'stromstotte';
  cfg.stromleverandor = String(v.stromleverandor || '').slice(0, 60);
  cfg.kraft_paaslag_ore_inkl_mva = num(v.kraft_paaslag_ore_inkl_mva, 0);
  cfg.kraft_fast_kr_per_mnd = num(v.kraft_fast_kr_per_mnd, 0);
  cfg.egen_dag_ore = num(v.egen_dag_ore, cfg.egen_dag_ore);
  cfg.egen_natt_ore = num(v.egen_natt_ore, cfg.egen_natt_ore);
  cfg.egen_kapasitet_kr = num(v.egen_kapasitet_kr, cfg.egen_kapasitet_kr);
  cfg.oppsett_ferdig = true;
  applySelskap();
  persistConfig();
  if (tray) tray.setContextMenu(buildTrayMenu());
  log(`Oppsett lagret: ${cfg.prissone}, ${cfg.nettselskap_id}, ${cfg.avgiftssone}, ${cfg.ordning}`);
  lastTariffCheck = 0;
  updateTariffFromGithub(true);
  refresh(true);
});
ipcMain.handle('han-scan', async () => {
  if (hanScanning) return { feil: 'Søker allerede …' };
  hanScanning = true; sendLive();
  try {
    const list = await han.scan({ onProgress: (a, b) => { if (win) win.webContents.send('han-progress', a, b); } });
    hanPending = list.filter((x) => x.needsAuth);
    return { enheter: list, nett: han.localSubnets() };
  } catch (e) {
    return { feil: e.message };
  } finally { hanScanning = false; sendLive(); }
});
ipcMain.handle('han-probe', async (_e, host, auth) => {
  const h = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+$/i.test(h)) return { feil: 'Ugyldig adresse' };
  const dev = await han.probeHost(h, auth);
  return dev ? { enheter: [dev] } : { feil: `Fant ingen HAN-leser på ${h}` };
});
ipcMain.handle('han-connect', async (_e, dev, auth) => {
  try { return { ok: true, han: await connectHan(dev, auth) }; } catch (e) { return { feil: e.message, auth: e.code === 'AUTH' }; }
});
ipcMain.on('han-disconnect', () => {
  log('Koblet fra HAN-leser');
  cfg.han = null; cfg.han_auto_sok = false; hanLive = null; hanErr = null;
  persistConfig(); sendLive();
  if (tray) tray.setContextMenu(buildTrayMenu());
});
ipcMain.on('han-live-request', () => sendLive());
ipcMain.on('menu', () => {
  const m = buildTrayMenu();
  if (win) m.popup({ window: win });
});

// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  log(`Starter v${VERSION} (Electron ${process.versions.electron})${INSTALLED ? ' – installert' : ''}`);
  createWindow();
  createTray();
  // Valg fra installasjonen ("Start Strøm når Windows starter")
  const flag = path.join(ROOT, 'autostart.flag');
  if (fs.existsSync(flag)) {
    cfg.start_med_windows = true; persistConfig();
    try { fs.unlinkSync(flag); } catch (_) { /* ignorer */ }
    if (tray) tray.setContextMenu(buildTrayMenu());
  }
  ensureShortcuts();
  applyLoginItem();
  if (cfg._oppdatert_fra && cfg._oppdatert_fra !== VERSION) {
    notify('Strøm er oppdatert ⚡', `Ny versjon ${VERSION} er installert.`);
    delete cfg._oppdatert_fra; persistConfig();
  }
  watchForUpdates();
  sig = lib.consumptionSignature(FORBRUK_DIR);
  refresh(true);
  setInterval(tick, 15000);
  setInterval(pollHan, 5000);
  setTimeout(pollHan, 1500);
  setTimeout(tick, 3000);
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (!cfg.lukk_til_systemstatusfelt || !tray) app.quit();
});
