const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseIncomingLine } = require('./protocol');


let window;
let activeSession;
let lineBuffer = '';
let currentMode = null;
let recordSequence = 0;
let pendingPortPicker;
let pendingPortList = [];
let selectedPortInfo;
let closingSession = false;
let demoTimer;
let demoIndex = 0;
let demoLines = [];
const recordingsRoot = () => path.join(app.getPath('userData'), 'recordings');

function publish(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function makeWindow() {
  window = new BrowserWindow({
    width: 1340,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#f4f7fb',
    title: 'Medilogix TOF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.loadFile(path.join(__dirname, 'index.html'));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  const appSession = window.webContents.session;
  appSession.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    permission === 'serial' && details.securityOrigin === 'file:///');
  appSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'serial'));
  appSession.setDevicePermissionHandler((details) => details.deviceType === 'serial' && details.origin === 'file://');
  appSession.on('select-serial-port', (event, portList, webContents, callback) => {
    if (webContents !== window.webContents) return;
    event.preventDefault();
    if (pendingPortPicker) pendingPortPicker('');
    pendingPortPicker = callback;
    const ports = portList.map((port) => ({
      portId: port.portId,
      label: [port.portName || port.displayName || 'USB serial device', port.vendorId && `VID ${port.vendorId}`, port.productId && `PID ${port.productId}`].filter(Boolean).join(' · '),
      portName: port.portName || port.displayName || null,
      vendorId: port.vendorId || null,
      productId: port.productId || null,
      serialNumber: port.serialNumber || null
    }));
    pendingPortList = ports;
    publish('serial:ports', ports);
  });
}

function saveRecord(record) {
  if (!activeSession) return;
  record.sequence = ++recordSequence;
  record.receivedAt = new Date().toISOString();
  fs.appendFileSync(activeSession.recordsPath, `${JSON.stringify(record)}\n`, 'utf8');
  publish('serial:record', record);
}

function processLine(raw, complete = true) {
  const parsed = parseIncomingLine(raw, currentMode);
  if (parsed.mode) currentMode = parsed.mode;
  saveRecord({ ...parsed, raw, complete });
}

function updateSessionStatus(status, detail = null) {
  if (!activeSession) return;
  activeSession.metadata.status = status;
  activeSession.metadata.endedAt = new Date().toISOString();
  if (detail) activeSession.metadata.endDetail = detail;
  fs.writeFileSync(activeSession.metadataPath, `${JSON.stringify(activeSession.metadata, null, 2)}\n`, 'utf8');
  publish('session:status', activeSession.metadata);
}

function createSession({ portInfo, baudRate, simulated = false }) {
  if (activeSession) throw new Error('A recording is already active.');
  const now = new Date();
  const suffix = simulated ? 'demo' : `${portInfo.vendorId || 'usb'}-${portInfo.productId || 'serial'}`.replace(/[^a-zA-Z0-9-]/g, '');
  const sessionId = `${now.toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}_${suffix}`;
  const sessionDir = path.join(recordingsRoot(), sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  activeSession = {
    recordsPath: path.join(sessionDir, 'records.jsonl'),
    metadataPath: path.join(sessionDir, 'session.json'),
    metadata: {
      sessionId,
      device: { ...selectedPortInfo, ...portInfo },
      baudRate: Number(baudRate),
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      startedAt: now.toISOString(),
      status: 'recording',
      simulated,
      recordFormat: 'JSON Lines; original instrument messages are retained in `raw`.'
    }
  };
  fs.writeFileSync(activeSession.recordsPath, '', 'utf8');
  fs.writeFileSync(activeSession.metadataPath, `${JSON.stringify(activeSession.metadata, null, 2)}\n`, 'utf8');
  recordSequence = 0;
  lineBuffer = '';
  currentMode = null;
  publish('serial:state', { connected: true, session: activeSession.metadata });
  return activeSession.metadata;
}

function endSession(status, detail = null) {
  if (!activeSession || closingSession) return;
  closingSession = true;
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = null;
  if (lineBuffer) {
    processLine(lineBuffer, false);
    lineBuffer = '';
  }
  updateSessionStatus(status, detail);
  const metadata = activeSession.metadata;
  activeSession = null;
  currentMode = null;
  closingSession = false;
  publish('serial:state', { connected: false, session: metadata });
}

function acceptChunk(chunk) {
  lineBuffer += chunk;
  let newline;
  while ((newline = lineBuffer.indexOf('\n')) !== -1) {
    const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
    lineBuffer = lineBuffer.slice(newline + 1);
    processLine(line);
  }
  if (lineBuffer.length > 65536) {
    processLine(lineBuffer, false);
    lineBuffer = '';
    publish('app:notice', { kind: 'warning', message: 'A serial message exceeded 64 KB and was saved as an incomplete line.' });
  }
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

ipcMain.handle('serial:choose-port', (_event, portId) => {
  if (!pendingPortPicker) throw new Error('The device picker is no longer active.');
  const callback = pendingPortPicker;
  pendingPortPicker = null;
  selectedPortInfo = pendingPortList.find((port) => port.portId === portId) || null;
  if (portId && !selectedPortInfo) throw new Error('That device is no longer available. Refresh the picker and try again.');
  pendingPortList = [];
  callback(portId || '');
});
ipcMain.handle('session:start', (_event, options) => {
  const session = createSession(options);
  selectedPortInfo = null;
  return session;
});
ipcMain.handle('session:append', (_event, { raw, complete }) => {
  if (!activeSession) throw new Error('There is no active recording.');
  acceptChunk(`${raw}${complete ? '\n' : ''}`);
});
ipcMain.handle('session:end', (_event, status = 'completed') => endSession(status));
ipcMain.handle('demo:start', (_event, { baudRate }) => {
  if (activeSession) throw new Error('Finish the current recording before starting the sample demo.');
  const samplePath = path.join(__dirname, '..', 'docs', 'references', 'device-sample.csv');
  demoLines = fs.readFileSync(samplePath, 'utf8').split(/\r?\n/).filter(Boolean);
  demoIndex = 0;
  const session = createSession({
    baudRate,
    portInfo: { label: 'Sample data replay (demo)', portName: 'DEMO' },
    simulated: true
  });
  demoTimer = setInterval(() => {
    if (!activeSession || demoIndex >= demoLines.length) {
      endSession('completed');
      publish('app:notice', { kind: 'info', message: 'Sample replay finished. You can review or export the demo session.' });
      return;
    }
    acceptChunk(`${demoLines[demoIndex]}\n`);
    demoIndex += 1;
  }, 420);
  return activeSession.metadata;
});
ipcMain.handle('demo:stop', () => endSession('completed'));

ipcMain.handle('session:list', async () => {
  fs.mkdirSync(recordingsRoot(), { recursive: true });
  return fs.readdirSync(recordingsRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(recordingsRoot(), entry.name, 'session.json');
      try {
        const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
        const records = path.join(recordingsRoot(), entry.name, 'records.jsonl');
        const count = fs.existsSync(records) ? fs.readFileSync(records, 'utf8').split('\n').filter(Boolean).length : 0;
        return { ...metadata, recordCount: count, startedLabel: safeDate(metadata.startedAt) };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
});

ipcMain.handle('session:get-records', (_event, sessionId) => {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..' || path.basename(sessionId) !== sessionId) throw new Error('Invalid recording ID.');
  const sessionDir = path.join(recordingsRoot(), sessionId);
  const recordsPath = path.join(sessionDir, 'records.jsonl');
  if (!fs.existsSync(recordsPath)) throw new Error('This recording could not be found.');
  const metadataPath = path.join(sessionDir, 'session.json');
  if (!fs.existsSync(metadataPath)) throw new Error('Recording details could not be found.');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.sessionId !== sessionId) throw new Error('Recording details do not match this recording.');
  const records = fs.readFileSync(recordsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { metadata, records };
});

ipcMain.handle('session:export', async (_event, sessionId) => {
  const dir = path.join(recordingsRoot(), path.basename(sessionId));
  const recordsPath = path.join(dir, 'records.jsonl');
  if (!fs.existsSync(recordsPath)) throw new Error('This recording could not be found.');
  const result = await dialog.showSaveDialog(window, {
    title: 'Export recording as CSV',
    defaultPath: path.join(app.getPath('documents'), `${path.basename(sessionId)}.csv`),
    filters: [{ name: 'CSV file', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = ['sequence,received_at,device_time,mode,event_type,value,denominator,raw,complete'];
  for (const line of fs.readFileSync(recordsPath, 'utf8').split('\n').filter(Boolean)) {
    const record = JSON.parse(line);
    rows.push([record.sequence, record.receivedAt, record.deviceTime, record.mode, record.type, record.value, record.denominator, record.raw, record.complete].map(escapeCsv).join(','));
  }
  fs.writeFileSync(result.filePath, `\uFEFF${rows.join('\r\n')}\r\n`, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('session:show-folder', async (_event, sessionId) => {
  const dir = path.join(recordingsRoot(), path.basename(sessionId));
  if (!fs.existsSync(dir)) throw new Error('This recording could not be found.');
  const error = await shell.openPath(dir);
  if (error) throw new Error(error);
});
ipcMain.handle('session:show-root', async () => {
  fs.mkdirSync(recordingsRoot(), { recursive: true });
  const error = await shell.openPath(recordingsRoot());
  if (error) throw new Error(error);
});
ipcMain.handle('app:recordings-path', () => recordingsRoot());

app.whenReady().then(() => {
  fs.mkdirSync(recordingsRoot(), { recursive: true });
  for (const entry of fs.readdirSync(recordingsRoot(), { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const metadataPath = path.join(recordingsRoot(), entry.name, 'session.json');
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (metadata.status === 'recording') {
        metadata.status = 'interrupted';
        metadata.endedAt = new Date().toISOString();
        metadata.endDetail = 'The application closed before the session ended.';
        fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      }
    } catch { /* Preserve unreadable session files for manual recovery. */ }
  }
  makeWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) makeWindow(); });
});
app.on('before-quit', (event) => {
  if (activeSession && !closingSession) {
    event.preventDefault();
    endSession('interrupted', 'Application closed while recording.');
    app.quit();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
