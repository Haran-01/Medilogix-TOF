const $ = (selector) => document.querySelector(selector);
const output = $('#serial-output');
const notice = $('#notice');
const pickerDialog = $('#device-dialog');
let visibleCount = 0;
let currentSession = null;
let serialPort = null;
let reader = null;
let readTask = null;
let stopRequested = false;
let noticeTimer;
let reviewedRecords = [];
let chartZoom = 1;

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
  $('#demo-button').disabled = connected;
  $('#disconnect-button').disabled = !connected;
  $('#baud-select').disabled = connected;
  $('#session-chip').classList.toggle('connected', connected);
  $('#monitor-dot').classList.toggle('connected', connected);
  $('#session-state').textContent = connected ? session.simulated ? 'Demo replay · recording' : 'Connected · recording' : session?.status === 'interrupted' ? 'Connection interrupted' : 'Ready to connect';
  $('#monitor-subtitle').textContent = connected ? session.simulated ? 'Replaying the saved example data. This is a simulation.' : `Receiving live data from ${session.device.portName || session.device.label}.` : 'Incoming messages will appear here when connected.';
  $('#recording-pill').textContent = connected ? session.simulated ? 'DEMO' : 'RECORDING' : 'STANDBY';
  $('#recording-pill').classList.toggle('on', connected);
  if (session) {
    currentSession = session;
    $('#detail-device').textContent = session.device?.portName || session.device?.label || 'USB serial device';
    $('#detail-baud').textContent = session.baudRate ? `${session.baudRate} baud` : '—';
    $('#detail-start').textContent = formatDate(session.startedAt);
    $('#active-session-id').textContent = session.sessionId;
  } else if (!connected) {
    $('#detail-device').textContent = '—';
    $('#detail-baud').textContent = '—';
    $('#detail-start').textContent = '—';
    $('#active-session-id').textContent = 'No active session';
  }
}

function showDeviceOptions(ports, onSelect, allowCancel = true) {
  const options = $('#device-options');
  options.replaceChildren();
  if (!ports.length) {
    const empty = document.createElement('p');
    empty.className = 'device-empty';
    empty.textContent = 'No compatible serial devices were detected. Connect the instrument and try again.';
    options.append(empty);
  }
  ports.forEach((port) => {
    const button = document.createElement('button');
    button.className = 'device-option';
    button.type = 'button';
    const icon = document.createElement('span'); icon.className = 'device-option-icon'; icon.textContent = '↔';
    const copy = document.createElement('span'); copy.className = 'device-option-copy';
    const title = document.createElement('strong'); title.textContent = port.label;
    const details = document.createElement('small'); details.textContent = port.serialNumber ? `Device serial ${port.serialNumber}` : 'USB serial device';
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
  const row = document.createElement('div');
  row.className = `serial-line${record.complete ? '' : ' incomplete'}`;
  const index = document.createElement('span'); index.className = 'line-index'; index.textContent = String(record.sequence).padStart(4, '0');
  const raw = document.createElement('span'); raw.className = 'line-raw'; raw.textContent = record.raw || ' ';
  row.append(index, raw);
  output.append(row);
  while (output.children.length > 1800) output.firstElementChild.remove();
  output.scrollTop = output.scrollHeight;
  $('#received-count').textContent = `${visibleCount.toLocaleString()} message${visibleCount === 1 ? '' : 's'}`;
  $('#detail-record-count').textContent = record.sequence.toLocaleString();
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
  if (status === 'completed') showNotice('Recording saved. The device is disconnected.');
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
  } catch (error) {
    if (!stopRequested) showNotice(`The instrument connection was interrupted: ${error.message}`, 'error');
  } finally {
    if (pending) await window.medilogix.appendRecord({ raw: pending, complete: false }).catch(() => {});
    await endCapture(stopRequested ? 'completed' : 'interrupted', serial);
  }
}

async function connect() {
  if (typeof window.medilogix?.startSession !== 'function') {
    showNotice('This window is not connected to the Medilogix desktop app. Close it and relaunch the current project with npm start.', 'error');
    return;
  }
  $('#connect-button').disabled = true;
  $('#demo-button').disabled = true;
  $('#connect-button').textContent = 'Opening device picker…';
  try {
    if (!('serial' in navigator)) throw new Error('Web Serial is unavailable in this runtime. Restart the application and try again.');
    // Keep requestPort directly inside the user gesture so Chromium can show its device permission picker.
    const port = await navigator.serial.requestPort();
    const info = port.getInfo();
    const display = (number) => number ? `0x${number.toString(16).padStart(4, '0').toUpperCase()}` : null;
    const portInfo = {
      label: 'USB Serial Device',
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
    output.replaceChildren();
    $('#received-count').textContent = '0 messages';
    $('#detail-record-count').textContent = '0';
    setConnected(true, currentSession);
    $('#connect-button').innerHTML = '<span class="connect-icon">●</span> Recording…';
    showNotice('Connected. Incoming data is being saved on this computer.');
    await refreshSessions();
    stopRequested = false;
    readTask = readStream(port);
  } catch (error) {
    if (error.name !== 'NotFoundError' && error.name !== 'AbortError') showNotice(`Could not connect: ${error.message}`, 'error');
    $('#connect-button').innerHTML = '<span class="connect-icon">↔</span> Connect &amp; record';
    $('#connect-button').disabled = false;
    $('#demo-button').disabled = false;
  }
}

async function startDemo() {
  if (typeof window.medilogix?.startDemo !== 'function') {
    showNotice('This window is not connected to the current Medilogix desktop build. Close it and relaunch the project with npm start, then try the demo again.', 'error');
    return;
  }
  $('#connect-button').disabled = true;
  $('#demo-button').disabled = true;
  $('#demo-button').textContent = 'Preparing sample…';
  try {
    visibleCount = 0;
    output.replaceChildren();
    $('#received-count').textContent = '0 messages';
    $('#detail-record-count').textContent = '0';
    currentSession = await window.medilogix.startDemo({ baudRate: Number($('#baud-select').value) });
    setConnected(true, currentSession);
    showNotice('Demo started. Sample lines will replay into a saved session.');
    await refreshSessions();
  } catch (error) {
    $('#connect-button').disabled = false;
    $('#demo-button').disabled = false;
    showNotice(`Could not start demo: ${error.message}`, 'error');
  } finally {
    $('#demo-button').innerHTML = '<span class="demo-icon">▷</span> Try sample data';
  }
}

async function disconnect() {
  if (currentSession?.simulated) {
    $('#disconnect-button').disabled = true;
    await window.medilogix.stopDemo();
    showNotice('Demo recording saved.');
    await refreshSessions();
    return;
  }
  if (!reader || !readTask) return;
  $('#disconnect-button').disabled = true;
  stopRequested = true;
  try { await reader.cancel(); } catch { /* The device may have disconnected already. */ }
  await readTask;
}

async function refreshSessions() {
  const sessions = await window.medilogix.listSessions();
  $('#session-count').textContent = String(sessions.length);
  const tbody = $('#sessions-table');
  tbody.replaceChildren();
  if (!sessions.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 6; cell.className = 'table-empty';
    cell.textContent = 'No recordings yet. Connect an instrument or try the sample replay to create a session.';
    row.append(cell); tbody.append(row); return;
  }
  for (const session of sessions) {
    const row = document.createElement('tr');
    const name = document.createElement('td'); name.className = 'session-name'; name.textContent = session.sessionId;
    const device = document.createElement('td'); device.textContent = session.device?.portName || session.device?.label || 'USB serial device';
    const started = document.createElement('td'); started.textContent = formatDate(session.startedAt);
    const count = document.createElement('td'); count.textContent = Number(session.recordCount).toLocaleString();
    const status = document.createElement('td'); const pill = document.createElement('span');
    pill.className = `table-status ${session.status}`; pill.textContent = session.status; status.append(pill);
    const actions = document.createElement('td');
    const reviewButton = document.createElement('button'); reviewButton.className = 'table-action'; reviewButton.textContent = 'Review';
    reviewButton.addEventListener('click', () => { void openReview(session.sessionId); });
    const exportButton = document.createElement('button'); exportButton.className = 'table-action'; exportButton.textContent = 'Export CSV';
    exportButton.addEventListener('click', async () => {
      try { const result = await window.medilogix.exportSession(session.sessionId); if (!result.canceled) showNotice('CSV export saved.'); }
      catch (error) { showNotice(`Export failed: ${error.message}`, 'error'); }
    });
    const folderButton = document.createElement('button'); folderButton.className = 'table-action'; folderButton.textContent = 'Folder';
    folderButton.addEventListener('click', () => window.medilogix.showSessionFolder(session.sessionId).catch((error) => showNotice(error.message, 'error')));
    actions.append(reviewButton, exportButton, folderButton); row.append(name, device, started, count, status, actions); tbody.append(row);
  }
}

function renderReviewRecords(records) {
  const tbody = $('#review-records');
  tbody.replaceChildren();
  for (const record of records) {
    const row = document.createElement('tr');
    const values = [
      String(record.sequence ?? '—'),
      record.receivedAt ? formatDate(record.receivedAt) : '—',
      record.deviceTime || record.sourceDate || '—',
      record.type || 'unknown',
      record.value == null ? '—' : record.denominator == null ? String(record.value) : `${record.value}/${record.denominator}`,
      record.raw || (record.complete ? '' : '[incomplete line]')
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

async function openReview(sessionId) {
  const panel = $('#review-panel');
  panel.hidden = false;
  $('#review-title').textContent = 'Loading recording…';
  $('#review-meta').textContent = '';
  try {
    const result = await window.medilogix.getSessionRecords(sessionId);
    reviewedRecords = result.records;
    chartZoom = 1;
    $('#chart-pan').value = '100';
    $('#review-title').textContent = result.metadata.simulated ? 'Sample replay · simulated' : (result.metadata.device?.portName || result.metadata.device?.label || 'USB serial recording');
    $('#review-meta').textContent = `${formatDate(result.metadata.startedAt)} · ${result.records.length.toLocaleString()} messages · ${result.metadata.status}`;
    renderReviewRecords(reviewedRecords);
    window.renderSessionChart(reviewedRecords, $('#chart-pan').value, chartZoom);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    panel.hidden = true;
    showNotice(`Could not open recording: ${error.message}`, 'error');
  }
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
  $('#live-view').hidden = button.dataset.view !== 'live';
  $('#recordings-view').hidden = button.dataset.view !== 'recordings';
  if (button.dataset.view === 'recordings') void refreshSessions();
}));
$('#connect-button').addEventListener('click', connect);
$('#demo-button').addEventListener('click', startDemo);
$('#disconnect-button').addEventListener('click', disconnect);
$('#clear-monitor').addEventListener('click', () => { output.replaceChildren(); visibleCount = 0; $('#received-count').textContent = '0 visible messages'; });
$('#refresh-sessions').addEventListener('click', refreshSessions);
$('#open-recordings-folder').addEventListener('click', () => window.medilogix.showRecordingsRoot().catch((error) => showNotice(`Could not open recordings folder: ${error.message}`, 'error')));
$('#close-review').addEventListener('click', () => { $('#review-panel').hidden = true; });
$('#chart-pan').addEventListener('input', (event) => window.renderSessionChart(reviewedRecords, event.target.value, chartZoom));
$('#zoom-in').addEventListener('click', () => { chartZoom = Math.min(10, chartZoom * 1.5); window.renderSessionChart(reviewedRecords, $('#chart-pan').value, chartZoom); });
$('#zoom-out').addEventListener('click', () => { chartZoom = Math.max(1, chartZoom / 1.5); window.renderSessionChart(reviewedRecords, $('#chart-pan').value, chartZoom); });
$('#cancel-device-picker').addEventListener('click', () => { pickerDialog.close(); void window.medilogix.choosePort(''); });
window.medilogix.onAvailablePorts((ports) => showDeviceOptions(ports, (portId) => { void window.medilogix.choosePort(portId); }));
window.medilogix.onRecord(appendRecord);
window.medilogix.onSerialState(({ connected, session }) => {
  setConnected(connected, session);
  if (!connected) {
    $('#connect-button').innerHTML = '<span class="connect-icon">↔</span> Connect &amp; record';
    if (session?.status === 'interrupted') showNotice('The instrument connection was interrupted. Data received so far has been saved.', 'error');
    void refreshSessions();
  }
});
window.medilogix.onNotice(({ kind, message }) => showNotice(message, kind));
window.medilogix.onSessionStatus((session) => { currentSession = session; });

void refreshSessions();
