'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strom', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onBusy: (cb) => ipcRenderer.on('busy', (_e, b) => cb(b)),
  refresh: () => ipcRenderer.send('refresh'),
  setOrdning: (o) => ipcRenderer.send('set-ordning', o),
  openForbruk: () => ipcRenderer.send('open-forbruk'),
  openConfig: () => ipcRenderer.send('open-config'),
  openElhub: () => ipcRenderer.send('open-elhub'),
  menu: () => ipcRenderer.send('menu'),
  setupData: () => ipcRenderer.invoke('setup-data'),
  tariffSummary: (id, sone) => ipcRenderer.invoke('tariff-summary', id, sone),
  saveSetup: (v) => ipcRenderer.send('save-setup', v),
  onShowSetup: (cb) => ipcRenderer.on('show-setup', () => cb()),
  onShowHan: (cb) => ipcRenderer.on('show-han', () => cb()),
  onLive: (cb) => ipcRenderer.on('live', (_e, d) => cb(d)),
  onHanProgress: (cb) => ipcRenderer.on('han-progress', (_e, a, b) => cb(a, b)),
  hanScan: () => ipcRenderer.invoke('han-scan'),
  hanProbe: (host, auth) => ipcRenderer.invoke('han-probe', host, auth),
  hanConnect: (dev, auth) => ipcRenderer.invoke('han-connect', dev, auth),
  hanDisconnect: () => ipcRenderer.send('han-disconnect'),
  hanLiveRequest: () => ipcRenderer.send('han-live-request'),
});
