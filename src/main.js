const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseIncomingLine } = require('./protocol');
const { createSupabaseBackend } = require('./backend/supabase');
const { normalizeDate, splitCapturedRecords, splitImportedFile } = require('./recording-import');
const { migrateLocalRecordings, readSecureText, writeSecureText } = require('./local-vault');


let window;
let activeSession;
let pendingCapture;
let lineBuffer = '';
let currentMode = null;
let recordSequence = 0;
let pendingPortPicker;
let pendingPortList = [];
let selectedPortInfo;
let closingSession = false;
let allowQuit = false;
let cloudBackend;
const pendingImports = new Map();
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
  window.on('close', (event) => {
    if (allowQuit || !hasUnsavedCapture()) return;
    event.preventDefault();
    if (confirmDiscardCapture()) {
      allowQuit = true;
      discardUnsavedCapture();
      window.close();
    }
  });
  window.loadFile(path.join(__dirname, 'index.html'));
  const appUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== appUrl && !navigationUrl.startsWith(`${appUrl}#`)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  const appSession = window.webContents.session;
  appSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === window.webContents && details.isMainFrame === true && permission === 'serial' && details.securityOrigin === 'file:///');
  appSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(contents === window.webContents && details.isMainFrame === true && permission === 'serial' && details.requestingUrl?.startsWith('file:///') === true));
  appSession.setDevicePermissionHandler((details) => details.deviceType === 'serial' && details.origin === 'file://');
  appSession.on('select-serial-port', (event, portList, webContents, callback) => {
    if (webContents !== window.webContents) return;
    event.preventDefault();
    if (pendingPortPicker) pendingPortPicker('');
    pendingPortPicker = callback;
    const ports = portList.map((port) => ({
      portId: port.portId,
      label: port.portName || port.displayName || 'USB instrument',
      portName: port.portName || port.displayName || null,
      vendorId: port.vendorId || null,
      productId: port.productId || null,
      serialNumber: port.serialNumber || null
    }));
    pendingPortList = ports;
    publish('serial:ports', ports);
  });
}

function hasUnsavedCapture() {
  return Boolean((activeSession && (activeSession.records.length || lineBuffer)) || pendingCapture?.records.length);
}

function confirmDiscardCapture() {
  if (!hasUnsavedCapture()) return true;
  const result = dialog.showMessageBoxSync(window && !window.isDestroyed() ? window : undefined, {
    type: 'warning',
    title: 'Unsaved readings',
    message: 'This recording has not been saved.',
    detail: 'If you close MedilogiX now, all readings in this capture will be deleted.',
    buttons: ['Keep the app open', 'Close without saving'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return result === 1;
}

function discardUnsavedCapture() {
  if (activeSession) endSession('interrupted', 'The app closed before this capture was saved.');
  pendingCapture = null;
}

function saveRecord(record) {
  if (!activeSession) return;
  record.sequence = ++recordSequence;
  record.receivedAt = new Date().toISOString();
  activeSession.records.push(record);
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
  publish('session:status', activeSession.metadata);
}

function createSession({ portInfo, baudRate, simulated = false, cloudOwnerId = null }) {
  if (activeSession) throw new Error('A recording is already active.');
  if (pendingCapture) throw new Error('Save or discard the previous unsaved capture before starting another session.');
  const now = new Date();
  const suffix = simulated ? 'demo' : `${portInfo.vendorId || 'usb'}-${portInfo.productId || 'serial'}`.replace(/[^a-zA-Z0-9-]/g, '');
  const sessionId = `${now.toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}_${suffix}`;
  activeSession = {
    records: [],
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
      cloudOwnerId: simulated ? null : cloudOwnerId,
      cloudSync: simulated ? 'demo' : 'unsaved',
      recordFormat: 'Unsaved in-memory capture; original instrument messages are retained in `raw` until the user chooses Save.'
    }
  };
  recordSequence = 0;
  lineBuffer = '';
  currentMode = null;
  publish('serial:state', { connected: true, session: activeSession.metadata });
  return activeSession.metadata;
}

function endSession(status, detail = null) {
  if (!activeSession || closingSession) return;
  closingSession = true;
  if (lineBuffer) {
    processLine(lineBuffer, false);
    lineBuffer = '';
  }
  updateSessionStatus(status, detail);
  const capture = activeSession;
  const metadata = capture.metadata;
  pendingCapture = capture.records.length ? capture : null;
  activeSession = null;
  currentMode = null;
  closingSession = false;
  publish('serial:state', { connected: false, session: metadata });
  return metadata;
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
    publish('app:notice', { kind: 'warning', message: 'One reading was unusually long and may be incomplete.' });
  }
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..' || path.basename(sessionId) !== sessionId) {
    throw new Error('Invalid recording ID.');
  }
  return sessionId;
}

function validatePatientDetails(patient) {
  if (!patient || typeof patient !== 'object') throw new Error('Patient details are required for every recording.');
  const patientName = String(patient.patientName || '').trim();
  const ageText = String(patient.age ?? '').trim();
  const age = Number(ageText);
  const patientGender = String(patient.gender || '').trim();
  const recordingDate = normalizeDate(patient.recordingDate);
  if (!patientName || patientName.length > 120) throw new Error('Enter a patient name of 1 to 120 characters for every recording.');
  if (!/^\d{1,3}$/.test(ageText) || !Number.isInteger(age) || age < 0 || age > 150) throw new Error('Patient age must be a whole number between 0 and 150.');
  if (!['Male', 'Female', 'Other', 'Prefer not to say', 'Unknown'].includes(patientGender)) throw new Error('Choose a valid gender for every recording.');
  if (!recordingDate) throw new Error('Choose a valid recording date for every recording.');
  return { patientName, age, patientGender, recordingDate };
}

function safeFileStem(value) {
  let stem = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 90).trim();
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `Patient ${stem || 'Record'}`;
  return stem;
}

function allocatePatientFile(patient, content) {
  const dateDir = path.join(recordingsRoot(), patient.recordingDate);
  fs.mkdirSync(dateDir, { recursive: true });
  const stem = safeFileStem(patient.patientName);
  for (let suffix = 1; suffix < 10000; suffix += 1) {
    const suffixLabel = suffix === 1 ? '' : ` (${suffix})`;
    const filePath = path.join(dateDir, `${stem}${suffixLabel}.csv`);
    try {
      writeSecureText(filePath, content, safeStorage, { flag: 'wx' });
      return filePath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not choose a unique patient file name for ${patient.patientName}.`);
}

function saveImportedSession(patient, sourceFileName, cloudOwnerId) {
  const importedAt = new Date().toISOString();
  const sessionId = `import_${randomUUID()}`;
  const sessionDir = path.join(recordingsRoot(), sessionId);
  const metadataPath = path.join(sessionDir, 'session.json');
  const recordsPath = path.join(sessionDir, 'records.jsonl');
  const dateText = patient.recordingDateText || patient.recordingDate;
  const fileHeader = [dateText, patient.patientName, String(patient.age), patient.patientGender].join('\n');
  const patientFileContent = `${fileHeader}\n\n${patient.entries.map((entry) => entry.raw).join('\n')}${patient.entries.length ? '\n' : ''}`;
  let patientFilePath;
  let sessionDirCreated = false;
  try {
    patientFilePath = allocatePatientFile(patient, patientFileContent);
    fs.mkdirSync(sessionDir, { recursive: false });
    sessionDirCreated = true;
    const records = patient.records.map((record, index) => ({
      ...record,
      sequence: index + 1,
      receivedAt: record.sourceReceivedAt && !Number.isNaN(Date.parse(record.sourceReceivedAt)) ? record.sourceReceivedAt : importedAt,
      complete: record.complete !== false
    }));
    const metadata = {
      sessionId,
      device: { label: 'Imported patient recording', portName: null },
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      startedAt: importedAt,
      endedAt: importedAt,
      status: 'completed',
      simulated: false,
      imported: true,
      sourceFileName,
      cloudOwnerId,
      cloudSync: cloudOwnerId ? 'pending' : 'local_only',
      patientName: patient.patientName,
      patientAge: patient.age,
      patientGender: patient.patientGender,
      recordingDate: patient.recordingDate,
      recordingDateText: dateText,
      patientFilePath,
      recordFormat: 'Imported patient recording; original message lines are retained in raw.'
    };
    writeSecureText(recordsPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, safeStorage);
    writeSecureText(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, safeStorage);
    return { metadata, records };
  } catch (error) {
    if (sessionDirCreated && fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    if (patientFilePath && fs.existsSync(patientFilePath)) fs.unlinkSync(patientFilePath);
    throw error;
  }
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
  return Promise.resolve(cloudBackend?.getUser?.()).catch(() => null).then((user) => {
    const session = createSession({ ...options, cloudOwnerId: user?.id || null });
    selectedPortInfo = null;
    return session;
  });
});
ipcMain.handle('session:append', (_event, { raw, complete }) => {
  if (!activeSession) throw new Error('There is no active recording.');
  acceptChunk(`${raw}${complete ? '\n' : ''}`);
});
async function syncStoredSession(sessionId) {
  validateSessionId(sessionId);
  const sessionDir = path.join(recordingsRoot(), sessionId);
  const metadataPath = path.join(sessionDir, 'session.json');
  const recordsPath = path.join(sessionDir, 'records.jsonl');
  if (!fs.existsSync(metadataPath) || !fs.existsSync(recordsPath)) throw new Error('This recording could not be found.');
  const metadata = JSON.parse(readSecureText(metadataPath, safeStorage));
  if (metadata.simulated) return { ...metadata, cloudSync: 'demo' };
  try {
    await cloudBackend.syncRecording(metadata, readSecureText(recordsPath, safeStorage).split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    metadata.cloudSync = 'synced';
    metadata.cloudSyncedAt = new Date().toISOString();
    delete metadata.cloudSyncError;
  } catch (error) {
    metadata.cloudSync = 'sync_error';
    metadata.cloudSyncError = error.message;
  }
  writeSecureText(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, safeStorage);
  publish('cloud:sync', { sessionId, cloudSync: metadata.cloudSync, message: metadata.cloudSyncError || null });
  return metadata;
}

ipcMain.handle('session:end', async (_event, status = 'completed') => {
  return endSession(status);
});
ipcMain.handle('session:sync', async (_event, sessionId) => syncStoredSession(sessionId));
ipcMain.handle('cloud:status', async () => cloudBackend.status());
ipcMain.handle('cloud:sign-in', async (_event, { email, password }) => cloudBackend.signInWithPassword(email, password));
ipcMain.handle('cloud:sign-up', async (_event, credentials) => cloudBackend.signUpWithPassword(credentials));
ipcMain.handle('cloud:update-profile', async (_event, profile) => cloudBackend.updateProfile(profile));
ipcMain.handle('cloud:sign-out', async () => cloudBackend.signOutUser());
ipcMain.handle('cloud:list-sessions', async () => cloudBackend.listSessions());
ipcMain.handle('cloud:get-records', async (_event, sessionId) => cloudBackend.getSessionRecords(sessionId));
ipcMain.handle('patient-import:stage-live', async () => {
  const capture = pendingCapture;
  if (!capture?.records.length) throw new Error('There is no completed live capture to save. Disconnect after receiving data, then try again.');
  const user = await cloudBackend.getUser();
  if (!user) throw new Error('Sign in to your doctor account before saving patient recordings.');
  if (capture.metadata.cloudOwnerId && capture.metadata.cloudOwnerId !== user.id) {
    throw new Error('This capture was started under a different doctor account. Sign in to that account to save it.');
  }
  const parsed = splitCapturedRecords(capture.records);
  const token = randomUUID();
  const sourceFileName = `Live capture ${capture.metadata.startedAt}`;
  for (const [key, value] of pendingImports) if (value.expiresAt < Date.now()) pendingImports.delete(key);
  while (pendingImports.size >= 5) pendingImports.delete(pendingImports.keys().next().value);
  pendingImports.set(token, { userId: user.id, sourceFileName, recordings: parsed.recordings, sourceFormat: parsed.sourceFormat, liveCaptureId: capture.metadata.sessionId, expiresAt: Date.now() + 15 * 60 * 1000 });
  return {
    canceled: false,
    token,
    sourceFileName,
    sourceFormat: parsed.sourceFormat,
    patients: parsed.recordings.map((patient) => ({
      recordingDate: patient.recordingDate || '',
      patientName: patient.patientName || '',
      age: patient.age == null ? '' : patient.age,
      gender: patient.gender || '',
      measurementCount: patient.measurementCount,
      headerReplacementCount: patient.headerReplacementCount
    }))
  };
});
ipcMain.handle('live-capture:discard', () => {
  if (activeSession) throw new Error('Disconnect from the instrument before discarding this capture.');
  pendingCapture = null;
  return { discarded: true };
});
ipcMain.handle('patient-import:open', async () => {
  const user = await cloudBackend.getUser();
  if (!user) throw new Error('Sign in to your doctor account before importing patient recordings.');
  const result = await dialog.showOpenDialog(window, {
    title: 'Import patient recordings',
    properties: ['openFile'],
    filters: [{ name: 'Recording files', extensions: ['csv', 'txt'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const sourcePath = result.filePaths[0];
  const stat = fs.statSync(sourcePath);
  if (stat.size > 10 * 1024 * 1024) throw new Error('Choose a recording file smaller than 10 MB.');
  const sourceFileName = path.basename(sourcePath);
  const parsed = splitImportedFile(fs.readFileSync(sourcePath, 'utf8'));
  const token = randomUUID();
  for (const [key, value] of pendingImports) if (value.expiresAt < Date.now()) pendingImports.delete(key);
  while (pendingImports.size >= 5) pendingImports.delete(pendingImports.keys().next().value);
  pendingImports.set(token, { userId: user.id, sourceFileName, recordings: parsed.recordings, sourceFormat: parsed.sourceFormat, expiresAt: Date.now() + 15 * 60 * 1000 });
  return {
    canceled: false,
    token,
    sourceFileName,
    sourceFormat: parsed.sourceFormat,
    patients: parsed.recordings.map((patient) => ({
      recordingDate: patient.recordingDate || '',
      patientName: patient.patientName || '',
      age: patient.age == null ? '' : patient.age,
      gender: patient.gender || '',
      measurementCount: patient.measurementCount,
      headerReplacementCount: patient.headerReplacementCount
    }))
  };
});
ipcMain.handle('patient-import:cancel', (_event, token) => pendingImports.delete(String(token || '')));
ipcMain.handle('patient-import:commit', async (_event, { token, patients }) => {
  const pending = pendingImports.get(String(token || ''));
  if (!pending || pending.expiresAt < Date.now()) {
    pendingImports.delete(String(token || ''));
    throw new Error('This import preview has expired. Select the file again.');
  }
  const user = await cloudBackend.getUser();
  if (!user || user.id !== pending.userId) throw new Error('Your signed-in account changed. Reopen the import under the correct doctor account.');
  if (pending.liveCaptureId && pendingCapture?.metadata.sessionId !== pending.liveCaptureId) throw new Error('This live capture is no longer available. Please capture the data again.');
  if (!Array.isArray(patients) || patients.length !== pending.recordings.length) throw new Error('The patient details no longer match this import preview.');
  const details = patients.map(validatePatientDetails);
  const saved = [];
  try {
    for (let index = 0; index < details.length; index += 1) {
      const sourcePatient = pending.recordings[index];
      const patient = {
        ...sourcePatient,
        ...details[index],
        recordingDateText: sourcePatient.recordingDate === details[index].recordingDate ? sourcePatient.recordingDateText : details[index].recordingDate
      };
      saved.push(saveImportedSession(patient, pending.sourceFileName, user.id));
    }
  } catch (error) {
    for (const item of saved) {
      const sessionDir = path.join(recordingsRoot(), item.metadata.sessionId);
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
      if (item.metadata.patientFilePath && fs.existsSync(item.metadata.patientFilePath)) fs.unlinkSync(item.metadata.patientFilePath);
    }
    throw error;
  }
  pendingImports.delete(String(token));
  if (pending.liveCaptureId) pendingCapture = null;
  const results = [];
  for (const item of saved) {
    const metadata = await syncStoredSession(item.metadata.sessionId);
    results.push({ sessionId: metadata.sessionId, patientName: metadata.patientName, recordingDate: metadata.recordingDate, recordCount: item.records.length, cloudSync: metadata.cloudSync });
  }
  return { importedCount: results.length, patients: results };
});
ipcMain.handle('session:list', async () => {
  fs.mkdirSync(recordingsRoot(), { recursive: true });
  const signedInUser = await Promise.resolve(cloudBackend?.getUser?.()).catch(() => null);
  const localSessions = fs.readdirSync(recordingsRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(recordingsRoot(), entry.name, 'session.json');
      try {
        const metadata = JSON.parse(readSecureText(file, safeStorage));
        const records = path.join(recordingsRoot(), entry.name, 'records.jsonl');
        const count = fs.existsSync(records) ? readSecureText(records, safeStorage).split('\n').filter(Boolean).length : 0;
        return { ...metadata, recordCount: count, startedLabel: safeDate(metadata.startedAt) };
      } catch { return null; }
    })
    .filter((session) => session && (!session.imported || session.cloudOwnerId === signedInUser?.id));
  try {
    const cloudRows = await cloudBackend.listSessions();
    const localById = new Map(localSessions.map((session) => [session.sessionId, session]));
    for (const remote of cloudRows) {
      const local = localById.get(remote.id);
      if (local) {
        continue;
      }
      localSessions.push({
        sessionId: remote.id,
        device: { label: remote.device_name || 'USB serial device' },
        baudRate: remote.baud_rate,
        startedAt: remote.started_at,
        endedAt: remote.ended_at,
        status: remote.status,
        simulated: remote.simulated,
        imported: Boolean(remote.imported),
        recordingDate: remote.recording_date || null,
        patientName: remote.patient_name || null,
        patientAge: remote.patient_age == null ? null : Number(remote.patient_age),
        patientGender: remote.patient_gender || null,
        sourceFileName: remote.source_file_name || null,
        recordCount: null,
        startedLabel: safeDate(remote.started_at),
        cloudSync: 'synced',
        remoteOnly: true
      });
    }
  } catch { /* Local recording access stays available when cloud sync is unavailable. */ }
  return localSessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
});

ipcMain.handle('session:get-records', (_event, sessionId) => {
  validateSessionId(sessionId);
  const sessionDir = path.join(recordingsRoot(), sessionId);
  const recordsPath = path.join(sessionDir, 'records.jsonl');
  if (!fs.existsSync(recordsPath)) throw new Error('This recording could not be found.');
  const metadataPath = path.join(sessionDir, 'session.json');
  if (!fs.existsSync(metadataPath)) throw new Error('Recording details could not be found.');
  const metadata = JSON.parse(readSecureText(metadataPath, safeStorage));
  if (metadata.sessionId !== sessionId) throw new Error('Recording details do not match this recording.');
  if (metadata.imported) {
    return Promise.resolve(cloudBackend.getUser()).then((user) => {
      if (!user || user.id !== metadata.cloudOwnerId) throw new Error('Sign in to the doctor account that owns this patient recording.');
      const records = readSecureText(recordsPath, safeStorage).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      return { metadata, records };
    });
  }
  const records = readSecureText(recordsPath, safeStorage).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { metadata, records };
});

ipcMain.handle('session:export', async (_event, sessionId) => {
  validateSessionId(sessionId);
  const dir = path.join(recordingsRoot(), sessionId);
  const recordsPath = path.join(dir, 'records.jsonl');
  let records;
  if (fs.existsSync(recordsPath)) {
    const metadata = JSON.parse(readSecureText(path.join(dir, 'session.json'), safeStorage));
    if (metadata.imported) {
      const user = await cloudBackend.getUser();
      if (!user || user.id !== metadata.cloudOwnerId) throw new Error('Sign in to the doctor account that owns this patient recording.');
    }
    records = readSecureText(recordsPath, safeStorage).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } else {
    records = (await cloudBackend.getSessionRecords(sessionId)).records;
  }
  const result = await dialog.showSaveDialog(window, {
    title: 'Export recording as CSV',
    defaultPath: path.join(app.getPath('documents'), `${sessionId}.csv`),
    filters: [{ name: 'CSV file', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = ['sequence,received_at,device_time,mode,event_type,value,denominator,raw,complete'];
  for (const record of records) {
    rows.push([record.sequence, record.receivedAt, record.deviceTime, record.mode, record.type, record.value, record.denominator, record.raw, record.complete].map(escapeCsv).join(','));
  }
  fs.writeFileSync(result.filePath, `\uFEFF${rows.join('\r\n')}\r\n`, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('session:show-folder', async (_event, sessionId) => {
  validateSessionId(sessionId);
  const dir = path.join(recordingsRoot(), sessionId);
  if (!fs.existsSync(dir)) throw new Error('This recording could not be found.');
  const metadata = JSON.parse(readSecureText(path.join(dir, 'session.json'), safeStorage));
  if (metadata.imported) {
    const user = await cloudBackend.getUser();
    if (!user || user.id !== metadata.cloudOwnerId) throw new Error('Sign in to the doctor account that owns this patient recording.');
  }
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
  cloudBackend = createSupabaseBackend({
    app,
    safeStorage,
    onAuthChange: (status) => publish('cloud:auth', status)
  });
  fs.mkdirSync(recordingsRoot(), { recursive: true });
  let localEncryptionWarning = null;
  try { migrateLocalRecordings(recordingsRoot(), safeStorage); }
  catch (error) { localEncryptionWarning = error.message; }
  for (const entry of fs.readdirSync(recordingsRoot(), { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const metadataPath = path.join(recordingsRoot(), entry.name, 'session.json');
    try {
      const metadata = JSON.parse(readSecureText(metadataPath, safeStorage));
      if (metadata.status === 'recording') {
        metadata.status = 'interrupted';
        metadata.endedAt = new Date().toISOString();
        metadata.endDetail = 'The application closed before the session ended.';
        writeSecureText(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, safeStorage);
      }
    } catch { /* Preserve unreadable session files for manual recovery. */ }
  }
  makeWindow();
  if (localEncryptionWarning) window.webContents.once('did-finish-load', () => publish('app:notice', { kind: 'error', message: `Local patient records could not be protected: ${localEncryptionWarning}` }));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) makeWindow(); });
});
app.on('before-quit', (event) => {
  if (allowQuit) return;
  if (hasUnsavedCapture()) {
    event.preventDefault();
    if (confirmDiscardCapture()) {
      allowQuit = true;
      discardUnsavedCapture();
      app.quit();
    }
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
