const $ = (selector) => document.querySelector(selector);
const output = $('#serial-output');
const notice = $('#notice');
const pickerDialog = $('#device-dialog');
let visibleCount = 0;
let captureMessageCount = 0;
let liveCaptureReady = false;
let currentSession = null;
let serialPort = null;
let reader = null;
let readTask = null;
let stopRequested = false;
let noticeTimer;
let reviewedRecords = [];
let chartZoom = 1;
let pendingImportToken = null;
let pendingImportOwnerId = null;
let pendingImportIsLive = false;
let signedInUserId = null;
let reviewedImported = false;
let reviewedOwnerId = null;
let patientFolders = new Map();
let activePatientFolder = null;
let reviewReturnToFolder = false;
let reviewedSessionId = null;
let allPatientRecordings = [];
let recordingSearchQuery = '';

function showNotice(message, kind = 'info') {
  notice.textContent = message;
  notice.className = `notice ${kind === 'error' ? 'error' : ''}`;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 5200);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function setConnected(connected, session = currentSession) {
  $('#connect-button').disabled = connected;
  $('#disconnect-button').disabled = !connected;
  $('#baud-select').disabled = connected;
  $('#session-chip').classList.toggle('connected', connected);
  $('#monitor-dot').classList.toggle('connected', connected);
  $('#session-state').textContent = connected ? 'Connected · receiving readings' : session?.status === 'interrupted' ? 'Connection interrupted · not saved' : liveCaptureReady ? 'Ready to save' : 'Ready to connect';
  $('#monitor-subtitle').textContent = connected ? 'Readings are arriving from your instrument.' : liveCaptureReady ? 'Your readings are ready. Save them to create patient records.' : 'Your instrument readings will appear here.';
  $('#recording-pill').textContent = connected ? 'RECEIVING' : 'READY';
  $('#recording-pill').classList.toggle('on', connected);
  if (session) {
    currentSession = session;
    $('#detail-device').textContent = 'Connected';
    $('#detail-baud').textContent = session.baudRate ? `${Number(session.baudRate).toLocaleString()} bits/s` : '—';
    $('#detail-start').textContent = formatDate(session.startedAt);
    $('#active-session-id').textContent = connected || liveCaptureReady ? 'Not saved yet' : 'Saved';
    $('#detail-cloud-sync').textContent = cloudSyncLabel(session.cloudSync);
  } else if (!connected) {
    $('#detail-device').textContent = '—';
    $('#detail-baud').textContent = '—';
    $('#detail-start').textContent = '—';
    $('#active-session-id').textContent = 'No recording in progress';
    $('#detail-cloud-sync').textContent = 'On this computer';
  }
  updateLiveCaptureButtons();
}

function cloudSyncLabel(status) {
  return ({ synced: 'Saved to account', pending: 'Saving to account…', sync_error: 'Could not save to account', local_only: 'On this computer', unsaved: 'Not saved yet' })[status] || 'On this computer';
}

function updateLiveCaptureButtons() {
  const available = liveCaptureReady && captureMessageCount > 0;
  $('#save-live-recording').hidden = !available;
  $('#discard-live-recording').hidden = !available;
}

function showDeviceOptions(ports, onSelect, allowCancel = true) {
  const options = $('#device-options');
  options.replaceChildren();
  if (!ports.length) {
    const empty = document.createElement('p');
    empty.className = 'device-empty';
    empty.textContent = 'No instrument found. Connect it using USB and try again.';
    options.append(empty);
  }
  ports.forEach((port) => {
    const button = document.createElement('button');
    button.className = 'device-option';
    button.type = 'button';
    const icon = document.createElement('span'); icon.className = 'device-option-icon'; icon.textContent = '↔';
    const copy = document.createElement('span'); copy.className = 'device-option-copy';
  const title = document.createElement('strong'); title.textContent = port.portName || port.label || 'USB instrument';
    const details = document.createElement('small'); details.textContent = port.portName ? `Port ${port.portName}` : 'Connected by USB';
    copy.append(title, details);
    const chevron = document.createElement('span'); chevron.className = 'device-option-chevron'; chevron.textContent = '›';
    button.append(icon, copy, chevron);
    button.addEventListener('click', () => { pickerDialog.close(); onSelect(port.portId); });
    options.append(button);
  });
  $('#cancel-device-picker').hidden = !allowCancel;
  if (!pickerDialog.open) pickerDialog.showModal();
}

function appendRecord(record) {
  if (visibleCount === 0) output.replaceChildren();
  visibleCount += 1;
  captureMessageCount += 1;
  const row = document.createElement('div');
  row.className = `serial-line${record.complete ? '' : ' incomplete'}`;
  const index = document.createElement('span'); index.className = 'line-index'; index.textContent = String(record.sequence).padStart(4, '0');
  const raw = document.createElement('span'); raw.className = 'line-raw'; raw.textContent = record.raw || ' ';
  row.append(index, raw);
  output.append(row);
  while (output.children.length > 1800) output.firstElementChild.remove();
  output.scrollTop = output.scrollHeight;
  $('#received-count').textContent = `${visibleCount.toLocaleString()} reading${visibleCount === 1 ? '' : 's'}`;
  $('#detail-record-count').textContent = captureMessageCount.toLocaleString();
}

async function endCapture(status, serial = serialPort) {
  if (reader) {
    try { reader.releaseLock(); } catch { /* The device may already have closed. */ }
  }
  reader = null;
  if (serial?.readable) {
    try { await serial.close(); } catch { /* A removed device cannot be closed cleanly. */ }
  }
  serialPort = null;
  readTask = null;
  stopRequested = false;
  await window.medilogix.endSession(status);
  if (captureMessageCount > 0) showNotice('Capture ended. Choose Save recordings to review and store the patient segments.');
  await refreshSessions();
}

async function readStream(serial) {
  const decoder = new TextDecoder();
  let pending = '';
  try {
    reader = serial.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const raw = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        await window.medilogix.appendRecord({ raw, complete: true });
      }
      if (pending.length > 65536) {
        await window.medilogix.appendRecord({ raw: pending, complete: false });
        pending = '';
      }
    }
    pending += decoder.decode();
  } catch {
    if (!stopRequested) showNotice('The instrument connection was interrupted. Check the USB cable, then reconnect.', 'error');
  } finally {
    if (pending) await window.medilogix.appendRecord({ raw: pending, complete: false }).catch(() => {});
    await endCapture(stopRequested ? 'completed' : 'interrupted', serial);
  }
}

async function connect() {
  if (typeof window.medilogix?.startSession !== 'function') {
    showNotice('The app needs to restart before it can connect to your instrument. Close and reopen the app, then try again.', 'error');
    return;
  }
  $('#connect-button').disabled = true;
  $('#connect-button').textContent = 'Choosing instrument…';
  try {
    if (!('serial' in navigator)) throw new Error('Instrument connection is unavailable. Restart the app and try again.');
    // Keep requestPort directly inside the user gesture so Chromium can show its device permission picker.
    const port = await navigator.serial.requestPort();
    const info = port.getInfo();
    const display = (number) => number ? `0x${number.toString(16).padStart(4, '0').toUpperCase()}` : null;
    const portInfo = {
      label: 'USB instrument',
      portName: null,
      vendorId: display(info.usbVendorId),
      productId: display(info.usbProductId)
    };
    const baudRate = Number($('#baud-select').value);
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    serialPort = port;
    try {
      currentSession = await window.medilogix.startSession({ portInfo, baudRate });
    } catch (error) {
      await port.close();
      serialPort = null;
      throw error;
    }
    visibleCount = 0;
    captureMessageCount = 0;
    liveCaptureReady = false;
    output.replaceChildren();
    $('#received-count').textContent = '0 readings';
    $('#detail-record-count').textContent = '0';
    setConnected(true, currentSession);
    $('#connect-button').innerHTML = '<span class="connect-icon">●</span> Receiving readings…';
    showNotice('Connected. Readings will appear here as they arrive.');
    await refreshSessions();
    stopRequested = false;
    readTask = readStream(port);
  } catch (error) {
    if (error.name !== 'NotFoundError' && error.name !== 'AbortError') showNotice('Could not connect. Check the USB cable and connection speed, then try again.', 'error');
    $('#connect-button').innerHTML = '<span class="connect-icon">↔</span> Connect &amp; record';
    $('#connect-button').disabled = false;
  }
}

async function disconnect() {
  if (!reader || !readTask) return;
  $('#disconnect-button').disabled = true;
  stopRequested = true;
  try { await reader.cancel(); } catch { /* The device may have disconnected already. */ }
  await readTask;
}

async function refreshSessions() {
  const sessions = await window.medilogix.listSessions();
  allPatientRecordings = sessions.filter((session) => session.imported);
  $('#session-count').textContent = String(allPatientRecordings.length);
  renderPatientRecordings(allPatientRecordings);
  if (activePatientFolder && !$('#patient-folder-page').hidden) {
    const refreshedFolder = patientFolders.get(activePatientFolder);
    $('#patient-folder-meta').textContent = `${refreshedFolder?.length || 0} patient ${refreshedFolder?.length === 1 ? 'recording' : 'recordings'} match this folder/search`;
    renderPatientFolderFiles(refreshedFolder || []);
  }
}

function renderPatientRecordings(sessions) {
  const container = $('#patient-recordings-list');
  container.replaceChildren();
  patientFolders = new Map();
  if (!sessions.length) {
    const empty = document.createElement('div'); empty.className = 'recordings-empty';
    empty.textContent = 'No patient files imported yet.'; container.append(empty); updateRecordingSearchCounts(); return;
  }
  const groups = new Map();
  for (const session of sessions) {
    const date = session.recordingDate || String(session.startedAt || '').slice(0, 10) || 'Date not set';
    const dateMatches = !recordingSearchQuery || date.toLocaleLowerCase().includes(recordingSearchQuery);
    const patientMatches = matchesPatientSearch(session, recordingSearchQuery);
    if (!dateMatches && !patientMatches) continue;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(session);
  }
  if (recordingSearchQuery && !groups.size) {
    const empty = document.createElement('div'); empty.className = 'recordings-empty';
    empty.textContent = 'No matching folders or patient recordings. Try a date, name, age, or gender.'; container.append(empty); updateRecordingSearchCounts(); return;
  }
  for (const [date, records] of [...groups.entries()].sort(([a], [b]) => b.localeCompare(a))) {
    records.sort((a, b) => String(a.patientName || '').localeCompare(String(b.patientName || '')));
    patientFolders.set(date, records);
    const folder = document.createElement('article'); folder.className = 'patient-date-folder';
    const heading = document.createElement('button'); heading.type = 'button'; heading.className = 'patient-date-heading';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('patient-folder-icon'); icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('aria-hidden', 'true');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iconPath.setAttribute('d', 'M2.5 5.5h5l1.8 2h8.2v7.8a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2zM2.5 5.5V4.7a1.2 1.2 0 0 1 1.2-1.2h4l1.8 2');
    iconPath.setAttribute('fill', 'none'); iconPath.setAttribute('stroke', 'currentColor'); iconPath.setAttribute('stroke-width', '1.5'); iconPath.setAttribute('stroke-linejoin', 'round'); icon.append(iconPath);
    const info = document.createElement('span'); info.className = 'patient-folder-info';
    const dateLabel = document.createElement('span'); dateLabel.className = 'patient-folder-date'; dateLabel.textContent = date;
    const count = document.createElement('span'); count.className = 'patient-folder-count'; count.textContent = `${records.length} ${records.length === 1 ? 'recording' : 'recordings'}`;
    info.append(dateLabel, count);
    const chevron = document.createElement('span'); chevron.className = 'patient-folder-chevron'; chevron.setAttribute('aria-hidden', 'true');
    heading.append(icon, info, chevron);
    heading.addEventListener('click', () => openPatientFolder(date));
    folder.append(heading);
    container.append(folder);
  }
  updateRecordingSearchCounts();
}

function canonicalGender(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  if (['m', 'male', 'man'].includes(normalized)) return 'male';
  if (['f', 'female', 'woman'].includes(normalized)) return 'female';
  if (['other', 'non-binary', 'nonbinary'].includes(normalized)) return 'other';
  return normalized;
}

function matchesPatientSearch(session, query) {
  if (!query) return true;
  const name = String(session.patientName ?? session.patient_name ?? '').toLocaleLowerCase();
  const age = String(session.patientAge ?? session.patient_age ?? '').toLocaleLowerCase();
  const gender = String(session.patientGender ?? session.patient_gender ?? session.gender ?? '').trim().toLocaleLowerCase();
  const genderQuery = canonicalGender(query);
  const normalizedGender = canonicalGender(gender);
  if (['male', 'female', 'other'].includes(genderQuery)) return normalizedGender === genderQuery;
  return name.includes(query) || age.includes(query) || gender.includes(query);
}

function updateRecordingSearchCounts() {
  const matchingFolders = patientFolders.size;
  const matchingRecordings = [...patientFolders.values()].reduce((total, records) => total + records.length, 0);
  $('#recording-search-count-home').textContent = recordingSearchQuery
    ? `${matchingFolders} date ${matchingFolders === 1 ? 'folder' : 'folders'} · ${matchingRecordings} matching ${matchingRecordings === 1 ? 'recording' : 'recordings'}`
    : `${matchingFolders} date ${matchingFolders === 1 ? 'folder' : 'folders'} · ${matchingRecordings} ${matchingRecordings === 1 ? 'recording' : 'recordings'}`;
  if (activePatientFolder) {
    const folderTotal = allPatientRecordings.filter((session) => (session.recordingDate || String(session.startedAt || '').slice(0, 10) || 'Date not set') === activePatientFolder).length;
    const folderMatches = patientFolders.get(activePatientFolder)?.length || 0;
    $('#recording-search-count-folder').textContent = recordingSearchQuery
      ? `${folderMatches} of ${folderTotal} recordings in this folder match`
      : `${folderTotal} ${folderTotal === 1 ? 'recording' : 'recordings'} in this folder`;
  }
}

function showRecordingsPage(page) {
  $('#recordings-home-page').hidden = page !== 'home';
  $('#patient-folder-page').hidden = page !== 'folder';
  $('#recording-detail-page').hidden = page !== 'detail';
  $('#recordings-privacy').hidden = page !== 'home';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function openPatientFolder(date) {
  const records = patientFolders.get(date);
  if (!records) return;
  activePatientFolder = date;
  $('#patient-folder-title').textContent = date;
  $('#patient-folder-meta').textContent = `${records.length} patient ${records.length === 1 ? 'recording' : 'recordings'} in this date folder`;
  $('#recording-back-label').textContent = date;
  renderPatientFolderFiles(records);
  updateRecordingSearchCounts();
  showRecordingsPage('folder');
}

function updateRecordingSearch(value) {
  recordingSearchQuery = value.trim().toLocaleLowerCase();
  $('#recording-search-home').value = value;
  $('#recording-search-folder').value = value;
  renderPatientRecordings(allPatientRecordings);
  updateRecordingSearchCounts();
  if (!$('#patient-folder-page').hidden && activePatientFolder) {
    const records = patientFolders.get(activePatientFolder) || [];
    $('#patient-folder-meta').textContent = `${records.length} patient ${records.length === 1 ? 'recording' : 'recordings'} match this folder/search`;
    renderPatientFolderFiles(records);
  }
}

function renderPatientFolderFiles(records) {
  const container = $('#patient-folder-files');
  container.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('div'); empty.className = 'recordings-empty';
    empty.textContent = 'No patient files match this search.'; container.append(empty); return;
  }
  for (const session of records) {
    const row = document.createElement('article'); row.className = 'patient-file-row';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'patient-file-open';
    const icon = document.createElement('span'); icon.className = 'patient-file-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '▤';
    const identity = document.createElement('span'); identity.className = 'patient-file-identity';
    const name = document.createElement('strong'); name.textContent = session.patientName || 'Patient recording';
    const details = document.createElement('small'); details.textContent = [session.patientAge == null ? null : `${session.patientAge} years`, session.patientGender].filter(Boolean).join(' · ') || 'Patient details not provided';
    identity.append(name, details);
    const meta = document.createElement('span'); meta.className = 'patient-file-meta';
    meta.textContent = session.recordCount == null
      ? cloudSyncLabel(session.cloudSync)
      : `${Number(session.recordCount).toLocaleString()} readings · ${cloudSyncLabel(session.cloudSync)}`;
    const status = document.createElement('span'); status.className = `table-status ${session.status || 'completed'}`; status.textContent = session.cloudSync === 'sync_error' ? 'Could not save' : session.status === 'interrupted' ? 'Incomplete' : 'Complete';
    const arrow = document.createElement('span'); arrow.className = 'patient-file-arrow'; arrow.setAttribute('aria-hidden', 'true');
    open.append(icon, identity, meta, status, arrow);
    open.addEventListener('click', () => { void openReview(session.sessionId, session.remoteOnly, 'graph', true); });
    const actions = document.createElement('div'); actions.className = 'patient-file-actions';
    const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.className = 'table-action'; exportButton.textContent = 'Export spreadsheet';
    exportButton.addEventListener('click', async () => {
      try { const result = await window.medilogix.exportSession(session.sessionId); if (!result.canceled) showNotice('Patient record exported.'); }
      catch (error) { showNotice(`Export failed: ${error.message}`, 'error'); }
    });
    actions.append(exportButton);
    if (!session.remoteOnly && session.cloudOwnerId && ['pending', 'sync_error'].includes(session.cloudSync)) {
      const sync = document.createElement('button'); sync.type = 'button'; sync.className = 'table-action'; sync.textContent = 'Save to account';
      sync.addEventListener('click', async () => {
        sync.disabled = true;
        try {
          const updated = await window.medilogix.syncSession(session.sessionId);
          await refreshSessions();
          openPatientFolder(activePatientFolder);
          showNotice(updated.cloudSync === 'synced' ? 'Patient record saved to your account.' : 'Patient record is on this computer. Try saving to your account again.', updated.cloudSync === 'synced' ? 'info' : 'error');
        } catch { showNotice('Could not save this patient record to your account. Try again.', 'error'); }
        finally { sync.disabled = false; }
      });
      actions.append(sync);
    }
    row.append(open, actions); container.append(row);
  }
}

function renderReviewRecords(records) {
  const tbody = $('#review-records');
  tbody.replaceChildren();
  for (const record of records) {
    const row = document.createElement('tr');
    const displayType = ({ date_header: 'Recording date', tof_count: 'TOF count', tof_ratio: 'TOF ratio', ptc_count: 'PTC count', mode: 'Reading type', unparsed_message: 'Other' })[record.type] || record.type || 'Other';
    const values = [
      String(record.sequence ?? '—'),
      record.receivedAt ? formatDate(record.receivedAt) : '—',
      record.deviceTime || record.sourceDate || '—',
      displayType,
      record.value == null ? '—' : record.denominator == null ? String(record.value) : `${record.value}/${record.denominator}`,
      record.raw || (record.complete ? '' : '[Reading incomplete]')
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === values.length - 1) cell.className = 'review-raw';
      row.append(cell);
    });
    if (!record.complete) row.classList.add('record-incomplete');
    tbody.append(row);
  }
}

async function openReview(sessionId, remoteOnly = false, viewMode = 'graph', fromPatientFolder = false) {
  if (reviewedImported) clearImportedReview();
  reviewedSessionId = sessionId;
  reviewReturnToFolder = fromPatientFolder;
  const panel = $('#review-panel');
  const requestingUserId = signedInUserId;
  showRecordingsPage('detail');
  $('#review-title').textContent = 'Loading recording…';
  $('#review-meta').textContent = '';
  try {
    const result = remoteOnly ? await window.medilogix.getCloudRecords(sessionId) : await window.medilogix.getSessionRecords(sessionId);
    reviewedRecords = result.records;
    chartZoom = 1;
    $('#chart-pan').value = '100';
    const metadata = result.metadata;
    if (metadata.imported && (!requestingUserId || requestingUserId !== signedInUserId || (metadata.cloudOwnerId && metadata.cloudOwnerId !== requestingUserId))) {
      throw new Error('Your account changed while this patient recording was opening. Select it again under the owning doctor account.');
    }
    reviewedImported = Boolean(metadata.imported);
    reviewedOwnerId = reviewedImported ? signedInUserId : null;
    $('#review-title').textContent = 'Recording overview';
    $('#review-meta').textContent = `${metadata.recordingDate || formatDate(metadata.startedAt)} · ${result.records.length.toLocaleString()} readings${metadata.status === 'interrupted' ? ' · Incomplete recording' : ''}`;
    $('#review-patient-name').textContent = metadata.patientName || 'Not provided';
    $('#review-patient-age').textContent = metadata.patientAge == null ? 'Not provided' : `${metadata.patientAge} years`;
    $('#review-patient-gender').textContent = metadata.patientGender || 'Not provided';
    $('#review-visualization').hidden = false;
    renderReviewRecords(reviewedRecords);
    window.renderSessionChart(reviewedRecords, $('#chart-pan').value, chartZoom);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    showRecordingsPage(fromPatientFolder ? 'folder' : 'home');
    showNotice('Could not open this patient record. Please try again.', 'error');
  }
}

function clearImportedReview() {
  if (!reviewedImported) return;
  showRecordingsPage('home');
  $('#review-visualization').hidden = false;
  $('#review-raw-data').hidden = false;
  $('#review-records').replaceChildren();
  $('#review-title').textContent = 'Recording overview';
  $('#review-meta').textContent = '';
  $('#review-patient-name').textContent = '—';
  $('#review-patient-age').textContent = '—';
  $('#review-patient-gender').textContent = '—';
  $('#trend-chart').replaceChildren();
  reviewedRecords = [];
  reviewedImported = false;
  reviewedOwnerId = null;
  reviewedSessionId = null;
}

function closeImportPreview() {
  const token = pendingImportToken;
  pendingImportToken = null;
  pendingImportOwnerId = null;
  pendingImportIsLive = false;
  if ($('#import-dialog').open) $('#import-dialog').close();
  if (token) void window.medilogix.cancelPatientImport(token).catch(() => {});
}

function showRecordingPreview(preview, isLive = false) {
  pendingImportToken = preview.token;
  pendingImportOwnerId = signedInUserId;
  pendingImportIsLive = isLive;
  renderImportPreview(preview);
  $('#confirm-import').disabled = false;
  $('#confirm-import').textContent = 'Save recordings';
  $('#import-dialog').showModal();
}

function renderImportPreview(preview) {
  const container = $('#import-patient-fields');
  container.replaceChildren();
  $('#import-description').textContent = `${preview.sourceFileName} · ${preview.patients.length} recording${preview.patients.length === 1 ? '' : 's'} detected. Review the patient details and dates before saving.`;
  preview.patients.forEach((patient, index) => {
    const card = document.createElement('section'); card.className = 'import-patient-card';
    const cardHeading = document.createElement('div'); cardHeading.className = 'import-patient-card-heading';
    const title = document.createElement('strong'); title.textContent = `Patient recording ${index + 1}`;
    const count = document.createElement('span'); count.textContent = `${Number(patient.measurementCount).toLocaleString()} readings`;
    cardHeading.append(title, count);
    const inputs = document.createElement('div'); inputs.className = 'import-patient-inputs';
    const field = (labelText, name, type, value, attrs = {}) => {
      const label = document.createElement('label'); label.textContent = labelText;
      const input = document.createElement('input'); input.name = name; input.type = type; input.value = value ?? ''; input.required = true;
      for (const [key, attrValue] of Object.entries(attrs)) input.setAttribute(key, String(attrValue));
      label.append(input); inputs.append(label);
    };
    field('Recording date', 'recordingDate', 'date', patient.recordingDate);
    field('Patient name', 'patientName', 'text', patient.patientName, { maxlength: 120, autocomplete: 'off' });
    field('Age', 'age', 'number', patient.age, { min: 0, max: 150, step: 1 });
    const genderLabel = document.createElement('label'); genderLabel.textContent = 'Gender';
    const gender = document.createElement('select'); gender.name = 'gender'; gender.required = true;
    for (const [value, text] of [['', 'Choose'], ['Male', 'Male'], ['Female', 'Female'], ['Other', 'Other'], ['Prefer not to say', 'Prefer not to say'], ['Unknown', 'Unknown']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; gender.append(option);
    }
    gender.value = patient.gender || '';
    genderLabel.append(gender); inputs.append(genderLabel);
    card.append(cardHeading, inputs); container.append(card);
  });
}

$('#import-recordings').addEventListener('click', async () => {
  const button = $('#import-recordings'); button.disabled = true;
  try {
    const preview = await window.medilogix.openPatientImport();
    if (preview.canceled) return;
    showRecordingPreview(preview, false);
  } catch { showNotice('Could not open the selected file. Please check it and try again.', 'error'); }
  finally { button.disabled = false; }
});
$('#save-live-recording').addEventListener('click', async () => {
  const button = $('#save-live-recording');
  button.disabled = true;
  try {
    const preview = await window.medilogix.stageLiveCapture();
    showRecordingPreview(preview, true);
  } catch { showNotice('Could not prepare these readings for saving. Please try again.', 'error'); }
  finally { button.disabled = false; }
});
$('#discard-live-recording').addEventListener('click', async () => {
  if (!window.confirm('Discard these unsaved readings? They cannot be recovered.')) return;
  const button = $('#discard-live-recording'); button.disabled = true;
  try {
    await window.medilogix.discardLiveCapture();
    liveCaptureReady = false;
    captureMessageCount = 0;
    visibleCount = 0;
    currentSession = null;
    output.replaceChildren();
    $('#received-count').textContent = '0 readings';
    $('#detail-record-count').textContent = '0';
    setConnected(false, null);
    showNotice('Unsaved capture discarded.');
  } catch { showNotice('Could not discard these readings. Please try again.', 'error'); }
  finally { button.disabled = false; }
});
$('#import-patients-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingImportToken) return;
  const token = pendingImportToken;
  const patients = [...$('#import-patient-fields').querySelectorAll('.import-patient-card')].map((card) => ({
    recordingDate: card.querySelector('[name="recordingDate"]').value,
    patientName: card.querySelector('[name="patientName"]').value,
    age: card.querySelector('[name="age"]').value,
    gender: card.querySelector('[name="gender"]').value
  }));
  const button = $('#confirm-import'); button.disabled = true; button.textContent = 'Saving…';
  const savingLive = pendingImportIsLive;
  try {
    const result = await window.medilogix.importPatientRecordings({ token, patients });
    pendingImportToken = null;
    pendingImportOwnerId = null;
    pendingImportIsLive = false;
    $('#import-dialog').close();
    if (savingLive) {
      liveCaptureReady = false;
      captureMessageCount = 0;
      currentSession = null;
      setConnected(false, null);
    }
    await refreshSessions();
    const syncFailed = result.patients.filter((patient) => patient.cloudSync !== 'synced').length;
    const action = savingLive ? 'Saved' : 'Imported';
    showNotice(syncFailed ? `${action} ${result.importedCount} patient records on this computer. Some could not be saved to your account.` : `${action} ${result.importedCount} patient records to your account.` , syncFailed ? 'error' : 'info');
  } catch { showNotice('Could not save the patient records. Please try again.', 'error'); }
  finally { button.disabled = false; button.textContent = 'Save recordings'; }
});
$('#cancel-import').addEventListener('click', closeImportPreview);
$('#close-import-dialog').addEventListener('click', closeImportPreview);
$('#import-dialog').addEventListener('cancel', () => {
  const token = pendingImportToken; pendingImportToken = null; pendingImportOwnerId = null; pendingImportIsLive = false;
  if (token) void window.medilogix.cancelPatientImport(token).catch(() => {});
});

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
  $('#live-view').hidden = button.dataset.view !== 'live';
  $('#recordings-view').hidden = button.dataset.view !== 'recordings';
  if (button.dataset.view === 'recordings') { showRecordingsPage('home'); void refreshSessions(); }
}));
$('#connect-button').addEventListener('click', connect);
$('#disconnect-button').addEventListener('click', disconnect);
$('#clear-monitor').addEventListener('click', () => { output.replaceChildren(); visibleCount = 0; $('#received-count').textContent = '0 visible readings'; });
$('#refresh-sessions').addEventListener('click', refreshSessions);
$('#open-recordings-folder').addEventListener('click', () => window.medilogix.showRecordingsRoot().catch(() => showNotice('Could not open the recordings folder. Please try again.', 'error')));
$('#back-to-folders').addEventListener('click', () => showRecordingsPage('home'));
$('#recording-search-home').addEventListener('input', (event) => updateRecordingSearch(event.target.value));
$('#recording-search-folder').addEventListener('input', (event) => updateRecordingSearch(event.target.value));
$('#back-to-patient-folder').addEventListener('click', () => {
  if (reviewReturnToFolder && activePatientFolder) showRecordingsPage('folder');
  else showRecordingsPage('home');
});
$('#export-patient-recording').addEventListener('click', async () => {
  if (!reviewedSessionId) return;
  try { const result = await window.medilogix.exportSession(reviewedSessionId); if (!result.canceled) showNotice('Patient record exported.'); }
  catch { showNotice('Could not export this patient record. Please try again.', 'error'); }
});
$('#chart-pan').addEventListener('input', (event) => window.renderSessionChart(reviewedRecords, event.target.value, chartZoom));
$('#zoom-in').addEventListener('click', () => { chartZoom = Math.min(10, chartZoom * 1.5); window.renderSessionChart(reviewedRecords, $('#chart-pan').value, chartZoom); });
$('#zoom-out').addEventListener('click', () => { chartZoom = Math.max(1, chartZoom / 1.5); window.renderSessionChart(reviewedRecords, $('#chart-pan').value, chartZoom); });
$('#cancel-device-picker').addEventListener('click', () => { pickerDialog.close(); void window.medilogix.choosePort(''); });
let accountMode = 'sign-in';
async function refreshCloudStatus(status = null) {
  try { status ||= await window.medilogix.getCloudStatus(); }
  catch { status = { configured: false, email: null, reason: 'unavailable' }; }
  const nextUserId = status.userId || null;
  if (pendingImportToken && nextUserId !== pendingImportOwnerId) closeImportPreview();
  if (reviewedImported && nextUserId !== reviewedOwnerId) clearImportedReview();
  signedInUserId = nextUserId;
  const button = $('#account-button');
  const accountName = status.doctorName || '';
  $('#account-button-label').textContent = !status.configured ? 'Account unavailable' : status.email ? accountName || 'Complete profile' : 'Sign in';
  const initials = accountName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  $('#account-avatar').textContent = status.email ? initials || '?' : '●';
  button.title = status.email ? `Open profile for ${accountName || status.email}` : 'Sign in to your account';
  $('#account-heading').textContent = status.email ? 'Your profile' : accountMode === 'sign-up' ? 'Create an account' : 'Sign in to your account';
  $('#account-description').textContent = status.configured
    ? status.email ? 'Your account and contact details.' : 'Sign in to back up your records to your account. You can record without signing in.'
    : 'Your account is temporarily unavailable. Please try again later.';
  $('#account-form').hidden = !status.configured || Boolean(status.email);
  $('#profile-form').hidden = !status.email;
  $('#account-mode-toggle').hidden = !status.configured || Boolean(status.email);
  $('#account-signout').hidden = !status.email;
  $('#profile-name').value = accountName;
  $('#profile-email').value = status.email || '';
  $('#profile-phone').value = status.phoneNumber || '';
  if (status.email) $('#account-state').textContent = 'You are signed in.';
  else if (!status.configured) $('#account-state').textContent = 'Account service is unavailable.';
  else $('#account-state').textContent = '';
  return status;
}

$('#account-button').addEventListener('click', async () => {
  await refreshCloudStatus();
  $('#account-dialog').showModal();
});
$('#close-account-dialog').addEventListener('click', () => $('#account-dialog').close());
function setAccountMode(mode) {
  accountMode = mode;
  const signingUp = mode === 'sign-up';
  $('#account-heading').textContent = signingUp ? 'Create an account' : 'Sign in to your account';
  $('#account-submit').textContent = signingUp ? 'Create account' : 'Sign in';
  $('#account-password').autocomplete = signingUp ? 'new-password' : 'current-password';
  $('#signup-name-field').hidden = !signingUp;
  $('#signup-phone-field').hidden = !signingUp;
  $('#signup-name').required = signingUp;
  $('#signup-phone').required = signingUp;
  $('#account-mode-toggle').textContent = signingUp ? 'Already have an account? Sign in' : 'New here? Create an account';
  $('#account-state').textContent = '';
  $('#account-state').classList.remove('error');
}
$('#account-mode-toggle').addEventListener('click', () => setAccountMode(accountMode === 'sign-in' ? 'sign-up' : 'sign-in'));
$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#account-submit');
  const state = $('#account-state');
  submit.disabled = true;
  state.classList.remove('error');
  const signingUp = accountMode === 'sign-up';
  state.textContent = signingUp ? 'Creating account…' : 'Signing in…';
  try {
    const credentials = { email: $('#account-email').value.trim(), password: $('#account-password').value };
    if (signingUp) {
      credentials.doctorName = $('#signup-name').value.trim();
      credentials.phoneNumber = $('#signup-phone').value.trim();
      const result = await window.medilogix.signUp(credentials);
      $('#account-password').value = '';
      if (result.confirmationRequired) {
        state.textContent = `If this email can register, check its inbox for a confirmation link. Then return here to sign in.`;
        return;
      }
      setAccountMode('sign-in');
      await refreshCloudStatus();
      await refreshSessions();
      showNotice('Account created. New patient records will be saved to your account.');
      return;
    }
    await window.medilogix.signIn(credentials);
    $('#account-password').value = '';
    await refreshCloudStatus();
    await refreshSessions();
    showNotice('Signed in. New patient records will be saved to your account.');
  } catch (error) {
    state.textContent = signingUp ? 'Could not create your account. Check the details and try again.' : 'Could not sign in. Check your email and password, then try again.';
    state.classList.add('error');
  } finally { submit.disabled = false; }
});
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#profile-save');
  const state = $('#account-state');
  submit.disabled = true;
  state.classList.remove('error');
  state.textContent = 'Saving profile…';
  try {
    await window.medilogix.updateProfile({
      doctorName: $('#profile-name').value.trim(),
      phoneNumber: $('#profile-phone').value.trim()
    });
    await refreshCloudStatus();
    state.textContent = 'Profile details saved.';
  } catch (error) {
    state.textContent = 'Could not save your profile. Please try again.';
    state.classList.add('error');
  } finally { submit.disabled = false; }
});
$('#account-signout').addEventListener('click', async () => {
  try { await window.medilogix.signOut(); await refreshCloudStatus(); await refreshSessions(); showNotice('You are signed out. New records will be saved on this computer.'); }
  catch { $('#account-state').textContent = 'Could not sign out. Please try again.'; $('#account-state').classList.add('error'); }
});
window.medilogix.onAvailablePorts((ports) => showDeviceOptions(ports, (portId) => { void window.medilogix.choosePort(portId); }));
window.medilogix.onRecord(appendRecord);
window.medilogix.onSerialState(({ connected, session }) => {
  if (connected) liveCaptureReady = false;
  else liveCaptureReady = Boolean(session && session.status !== 'recording' && captureMessageCount > 0);
  setConnected(connected, session);
  if (!connected) {
    $('#connect-button').innerHTML = '<span class="connect-icon">↔</span> Connect &amp; record';
    if (session?.status === 'interrupted') showNotice('The instrument disconnected unexpectedly. Readings received so far are not saved yet.', 'error');
    void refreshSessions();
  }
});
window.medilogix.onNotice(({ kind, message }) => showNotice(message, kind));
window.medilogix.onSessionStatus((session) => { currentSession = session; });
window.medilogix.onCloudAuth((status) => { void refreshCloudStatus(status); void refreshSessions(); });
window.medilogix.onCloudSync(({ sessionId, cloudSync }) => {
  if (currentSession?.sessionId === sessionId) {
    currentSession.cloudSync = cloudSync;
    $('#detail-cloud-sync').textContent = cloudSyncLabel(cloudSync);
  }
  if (cloudSync === 'synced') showNotice('Recording saved to your account.');
  else showNotice('Recording is on this computer, but could not be saved to your account.', 'error');
  void refreshSessions();
});

void refreshSessions();
void refreshCloudStatus();
