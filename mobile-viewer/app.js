(() => {
  'use strict';

  const config = window.MEDILOGIX_CONFIG || {};
  const $ = (selector) => document.querySelector(selector);
  const COLORS = { tofr: '#239f3a', tofc: '#e0a100', ptc: '#f27816' };
  const LABELS = { tofr: 'TOFR (%)', tofc: 'TOFC count', ptc: 'PTC count' };
  const LANES = {
    tofr: { top: 34, bottom: 145, max: 100, ticks: [0, 50, 100], label: 'TOFR (%)' },
    tofc: { top: 177, bottom: 253, max: 4, ticks: [0, 2, 4], label: 'TOFC' },
    ptc: { top: 285, bottom: 377, max: 20, ticks: [0, 10, 20], label: 'PTC' }
  };
  const PLOT = { left: 132, right: 875 };
  const sessionKey = 'medilogix-mobile-session';
  let authSession = readSession();
  let recordings = [];
  let currentFolder = null;
  let currentPage = 'home';
  let noticeTimer = null;

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); }
    catch { return null; }
  }

  function saveSession(value) {
    authSession = value;
    if (value) sessionStorage.setItem(sessionKey, JSON.stringify(value));
    else sessionStorage.removeItem(sessionKey);
  }

  function apiUrl(path) { return `${String(config.url || '').replace(/\/$/, '')}${path}`; }

  function ensureConfig() {
    if (!/^https:\/\//i.test(config.url || '') || !config.anonKey) {
      throw new Error('Recordings are temporarily unavailable. Please try again later.');
    }
  }

  async function authenticate(path, payload) {
    ensureConfig();
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.msg || body.message || body.error_description || 'Sign in could not be completed. Check your details and try again.');
    return body;
  }

  async function refreshSession() {
    if (!authSession?.refresh_token) throw new Error('Your session has ended. Sign in again.');
    try {
      const next = await authenticate('/auth/v1/token?grant_type=refresh_token', { refresh_token: authSession.refresh_token });
      saveSession({ ...next, expires_at: Date.now() + Number(next.expires_in || 3600) * 1000 });
    } catch {
      saveSession(null);
      updateAuthView();
      throw new Error('Your session has ended. Sign in again.');
    }
  }

  async function request(path, retry = true, extraHeaders = {}) {
    ensureConfig();
    if (!authSession?.access_token) throw new Error('Sign in to view your recordings.');
    if (authSession.expires_at && authSession.expires_at < Date.now() + 30000) await refreshSession();
    const response = await fetch(apiUrl(path), {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${authSession.access_token}`, Accept: 'application/json', ...extraHeaders }
    });
    if (response.status === 401 && retry) {
      await refreshSession();
      return request(path, false, extraHeaders);
    }
    if (!response.ok) {
      if (response.status === 401) { saveSession(null); updateAuthView(); }
      throw new Error(response.status === 401 ? 'Your session has ended. Sign in again.' : 'Could not load recordings. Please try again.');
    }
    return response.json();
  }

  async function requestAllRows(path) {
    const allRows = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = await request(path, true, { Range: `${offset}-${offset + pageSize - 1}`, 'Range-Unit': 'items' });
      if (!Array.isArray(page)) throw new Error('Could not load recordings. Please try again.');
      allRows.push(...page);
      if (page.length < pageSize) return allRows;
    }
  }

  function setBusy(button, busy, busyLabel) {
    button.disabled = busy;
    if (busy) { button.dataset.originalText = button.textContent; button.textContent = busyLabel; }
    else if (button.dataset.originalText) { button.textContent = button.dataset.originalText; delete button.dataset.originalText; }
  }

  function showNotice(message, success = false) {
    const node = $('#notice');
    node.textContent = message;
    node.classList.toggle('ok', success);
    node.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { node.hidden = true; }, 4500);
  }

  function updateAuthView() {
    const signedIn = Boolean(authSession?.access_token);
    $('#auth-view').hidden = signedIn;
    $('#content-view').hidden = !signedIn;
    $('#account-area').hidden = !signedIn;
    $('#account-email').textContent = authSession?.user?.email || '';
    if (signedIn) void loadRecordings();
    else showPage('home');
  }

  async function loadRecordings() {
    $('#folder-list').replaceChildren();
    $('#empty-state').hidden = true;
    $('#result-count').textContent = 'Loading recordings…';
    try {
      const rows = await requestAllRows('/rest/v1/recording_sessions?select=id,recording_date,patient_name,patient_age,patient_gender,started_at,ended_at,status,imported&imported=eq.true&order=recording_date.desc,started_at.desc');
      if (!authSession?.access_token) return;
      recordings = Array.isArray(rows) ? rows : [];
      renderFolders($('#search').value);
    } catch (error) {
      $('#result-count').textContent = '';
      $('#empty-state').hidden = false;
      $('#empty-state').textContent = error.message;
      if (!authSession?.access_token) updateAuthView();
    }
  }

  function dateKey(record) {
    return record.recording_date || String(record.started_at || '').slice(0, 10) || 'Undated';
  }

  function formatDate(date) {
    const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return date || 'Date not provided';
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  function matchesSearch(record, query) {
    if (!query) return true;
    return [dateKey(record), record.patient_name, record.patient_age, record.patient_gender]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(query));
  }

  function folderMap() {
    const folders = new Map();
    for (const record of recordings) {
      const date = dateKey(record);
      if (!folders.has(date)) folders.set(date, []);
      folders.get(date).push(record);
    }
    return [...folders.entries()].sort(([dateA], [dateB]) => dateB.localeCompare(dateA));
  }

  function makeFolderIcon() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('class', 'folder-icon'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3 6.5h7l2 2H21v10.8a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 19.3V6.5Z');
    icon.append(path);
    return icon;
  }

  function renderFolders(searchText = '') {
    const query = String(searchText || '').trim().toLocaleLowerCase();
    const target = $('#folder-list');
    target.replaceChildren();
    let matched = 0;
    let folderCount = 0;
    for (const [date, recordsForDate] of folderMap()) {
      const dateMatch = date.toLocaleLowerCase().includes(query);
      const matchingRecords = query && !dateMatch ? recordsForDate.filter((record) => matchesSearch(record, query)) : recordsForDate;
      if (!matchingRecords.length) continue;
      folderCount += 1; matched += matchingRecords.length;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'folder-card';
      button.append(makeFolderIcon());
      const info = document.createElement('span'); info.className = 'folder-info';
      const title = document.createElement('strong'); title.textContent = formatDate(date);
      const count = document.createElement('small'); count.textContent = `${matchingRecords.length} ${matchingRecords.length === 1 ? 'recording' : 'recordings'}`;
      info.append(title, count);
      const arrow = document.createElement('span'); arrow.className = 'chevron'; arrow.setAttribute('aria-hidden', 'true');
      button.append(info, arrow);
      button.addEventListener('click', () => openFolder(date));
      target.append(button);
    }
    $('#result-count').textContent = query ? `${folderCount} ${folderCount === 1 ? 'date' : 'dates'} · ${matched} matching ${matched === 1 ? 'recording' : 'recordings'}` : `${folderCount} ${folderCount === 1 ? 'date folder' : 'date folders'} · ${matched} ${matched === 1 ? 'recording' : 'recordings'}`;
    $('#empty-state').hidden = folderCount > 0;
  }

  function showPage(page) {
    currentPage = page;
    $('#recordings-page').hidden = page !== 'home';
    $('#folder-page').hidden = page !== 'folder';
    $('#detail-page').hidden = page !== 'detail';
  }

  function openFolder(date) {
    currentFolder = date;
    $('#folder-date').textContent = formatDate(date);
    $('#folder-search').value = $('#search').value;
    renderFolderRecords();
    showPage('folder');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderFolderRecords() {
    const query = $('#folder-search').value.trim().toLocaleLowerCase();
    const folderRecords = recordings.filter((record) => dateKey(record) === currentFolder);
    const results = query && !currentFolder.toLocaleLowerCase().includes(query) ? folderRecords.filter((record) => matchesSearch(record, query)) : folderRecords;
    $('#folder-count').textContent = `${folderRecords.length} patient ${folderRecords.length === 1 ? 'recording' : 'recordings'}`;
    $('#folder-result-count').textContent = query ? `${results.length} matching ${results.length === 1 ? 'recording' : 'recordings'}` : '';
    $('#record-list').replaceChildren();
    for (const record of results) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'record-card';
      const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = '▤'; icon.setAttribute('aria-hidden', 'true');
      const identity = document.createElement('span'); identity.className = 'record-identity';
      const name = document.createElement('strong'); name.textContent = record.patient_name || 'Patient recording';
      const demographics = document.createElement('small'); demographics.textContent = [record.patient_age == null ? null : `${record.patient_age} years`, record.patient_gender].filter(Boolean).join(' · ') || 'Patient details not provided';
      identity.append(name, demographics);
      const count = document.createElement('span'); count.className = 'record-readings'; count.textContent = 'Open recording ›';
      button.append(icon, identity, count);
      button.addEventListener('click', () => void openRecording(record));
      $('#record-list').append(button);
    }
    $('#folder-empty').hidden = results.length > 0;
  }

  async function openRecording(record) {
    showPage('detail');
    $('#detail-title').textContent = record.patient_name || 'Patient recording';
    $('#detail-date').textContent = formatDate(dateKey(record));
    $('#detail-back-label').textContent = formatDate(currentFolder);
    $('#patient-facts').replaceChildren();
    for (const [label, value] of [['Name', record.patient_name || 'Not provided'], ['Age', record.patient_age == null ? 'Not provided' : `${record.patient_age} years`], ['Gender', record.patient_gender || 'Not provided']]) {
      const card = document.createElement('div'); card.className = 'fact-card';
      const heading = document.createElement('span'); heading.textContent = label;
      const content = document.createElement('strong'); content.textContent = value;
      card.append(heading, content); $('#patient-facts').append(card);
    }
    $('#measurement-count').textContent = 'Loading measurements…';
    $('#reading-count').textContent = '';
    $('#reading-list').replaceChildren();
    $('#trend-chart').replaceChildren();
    try {
      const records = await requestAllRows(`/rest/v1/recording_events?select=sequence,received_at,raw,complete,event_type,mode,device_time,source_date,value,denominator,parsed_fields&session_id=eq.${encodeURIComponent(record.id)}&order=sequence.asc`);
      if (currentPage !== 'detail') return;
      const mapped = records.map((item) => ({ ...item, ...(item.parsed_fields || {}), type: item.event_type, deviceTime: item.device_time, sourceDate: item.source_date }));
      renderChart(mapped);
      renderReadings(mapped);
      const count = mapped.filter((item) => metricFor(item)).length;
      $('#measurement-count').textContent = `${count.toLocaleString()} ${count === 1 ? 'measurement' : 'measurements'}`;
      $('#reading-count').textContent = `${mapped.length.toLocaleString()} ${mapped.length === 1 ? 'reading' : 'readings'}`;
    } catch (error) {
      $('#measurement-count').textContent = error.message;
      showNotice(error.message);
    }
  }

  function metricFor(record) {
    if (record.type === 'tof_ratio') return 'tofr';
    if (record.type === 'tof_count') return 'tofc';
    if (record.type === 'ptc_count') return 'ptc';
    return null;
  }

  function minuteValue(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function preparePoints(records) {
    let segment = 0; let previous = null; let dayOffset = 0;
    const points = [];
    for (const record of records) {
      if (record.type === 'date_header') { segment += 1; previous = null; dayOffset = 0; continue; }
      const metric = metricFor(record); const minute = minuteValue(record.device_time);
      if (!metric || minute === null || !Number.isFinite(Number(record.value))) continue;
      if (previous !== null && minute < previous) dayOffset += 1440;
      previous = minute;
      points.push({ ...record, metric, xTime: minute + dayOffset, segment });
    }
    return points;
  }

  function addSvg(tag, attributes = {}, text = '') {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text) node.textContent = text;
    return node;
  }

  function renderChart(records) {
    const svg = $('#trend-chart'); svg.replaceChildren();
    const points = preparePoints(records);
    if (!points.length) {
      svg.append(addSvg('text', { x: 450, y: 225, 'text-anchor': 'middle', fill: '#78889c', 'font-size': 16 }, 'No measurements to display'));
      return;
    }
    let start = Infinity; let end = -Infinity;
    for (const point of points) { start = Math.min(start, point.xTime); end = Math.max(end, point.xTime); }
    const span = Math.max(1, end - start);
    const x = (time) => PLOT.left + ((time - start) / span) * (PLOT.right - PLOT.left);
    const y = (point) => {
      const lane = LANES[point.metric]; const max = Math.max(lane.max, Number(point.denominator) || 0);
      return lane.bottom - (Math.min(max, Math.max(0, Number(point.value))) / max) * (lane.bottom - lane.top);
    };
    for (const [metric, lane] of Object.entries(LANES)) {
      svg.append(addSvg('text', { x: 12, y: (lane.top + lane.bottom) / 2 + 4, fill: COLORS[metric], 'font-size': 13, 'font-weight': 700 }, lane.label));
      for (const tick of lane.ticks) {
        const yy = lane.bottom - tick / lane.max * (lane.bottom - lane.top);
        svg.append(addSvg('line', { x1: PLOT.left, y1: yy, x2: PLOT.right, y2: yy, stroke: tick === 0 ? '#c8d0d7' : '#e1e6eb', 'stroke-width': tick === 0 ? 1.6 : 1 }));
        svg.append(addSvg('text', { x: PLOT.left - 9, y: yy + 4, 'text-anchor': 'end', fill: '#718096', 'font-size': 10 }, tick));
      }
    }
    const groups = new Map();
    for (const point of points) { if (!groups.has(point.segment)) groups.set(point.segment, []); groups.get(point.segment).push(point); }
    for (const group of groups.values()) {
      for (let index = 1; index < group.length; index += 1) {
        const previous = group[index - 1]; const current = group[index];
        svg.append(addSvg('path', { d: `M ${x(previous.xTime)} ${y(previous)} L ${x(current.xTime)} ${y(current)}`, fill: 'none', stroke: COLORS[current.metric], 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      }
    }
    const tickCount = Math.min(8, points.length);
    const shown = new Set();
    for (let index = 0; index < tickCount; index += 1) {
      const point = points[Math.round(index * (points.length - 1) / Math.max(1, tickCount - 1))];
      if (shown.has(point.xTime)) continue;
      shown.add(point.xTime);
      const xx = x(point.xTime);
      svg.append(addSvg('line', { x1: xx, y1: 391, x2: xx, y2: 397, stroke: '#53677b' }));
      svg.append(addSvg('text', { x: xx, y: 416, 'text-anchor': 'middle', fill: '#63758a', 'font-size': 10 }, point.device_time || ''));
    }
    for (const point of points) {
      const mark = addSvg('circle', { cx: x(point.xTime), cy: y(point), r: 4.2, fill: COLORS[point.metric], stroke: '#fff', 'stroke-width': 1.4 });
      const value = point.metric === 'tofr' ? `${point.value}%` : `${point.value}${point.denominator == null ? '' : `/${point.denominator}`}`;
      mark.append(addSvg('title', {}, `${LABELS[point.metric]} ${value} · ${point.device_time || ''}`));
      svg.append(mark);
    }
  }

  function displayReading(record) {
    const metric = metricFor(record);
    if (metric) {
      const value = metric === 'tofr' ? `${record.value}%` : `${record.value}${record.denominator == null ? '' : `/${record.denominator}`}`;
      return `${LABELS[metric]} · ${value}`;
    }
    if (record.type === 'date_header') return 'Recording date';
    if (record.type === 'mode') return `Reading type · ${record.mode || ''}`;
    if (record.type === 'blank') return 'Blank line';
    return 'Other message';
  }

  function renderReadings(records) {
    const target = $('#reading-list'); target.replaceChildren();
    for (const record of records) {
      const row = document.createElement('div'); row.className = 'reading-row';
      const seq = document.createElement('span'); seq.className = 'reading-seq'; seq.textContent = `#${record.sequence}`;
      const time = document.createElement('span'); time.className = 'reading-time'; time.textContent = record.device_time || '—';
      const copy = document.createElement('span'); copy.className = 'reading-copy';
      const label = document.createElement('strong'); label.textContent = displayReading(record);
      const raw = document.createElement('small'); raw.textContent = record.raw || (record.complete ? '' : 'Reading incomplete');
      copy.append(label, raw); row.append(seq, time, copy); target.append(row);
    }
  }

  $('#sign-in-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#sign-in'); const message = $('#auth-message');
    message.textContent = '';
    setBusy(button, true, 'Signing in…');
    try {
      const data = await authenticate('/auth/v1/token?grant_type=password', { email: $('#email').value.trim(), password: $('#password').value });
      saveSession({ ...data, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 });
      $('#password').value = '';
      updateAuthView();
    } catch (error) { message.textContent = error.message; }
    finally { setBusy(button, false); }
  });

  $('#sign-out').addEventListener('click', async () => {
    const token = authSession?.access_token;
    saveSession(null); recordings = []; updateAuthView();
    if (token && config.url && config.anonKey) {
      try { await fetch(apiUrl('/auth/v1/logout'), { method: 'POST', headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` } }); }
      catch { /* The local viewer session is cleared even when offline. */ }
    }
  });

  $('#search').addEventListener('input', (event) => {
    $('#clear-search').hidden = !event.target.value;
    renderFolders(event.target.value);
  });
  $('#clear-search').addEventListener('click', () => { $('#search').value = ''; $('#clear-search').hidden = true; renderFolders(); $('#search').focus(); });
  $('#folder-search').addEventListener('input', (event) => { $('#clear-folder-search').hidden = !event.target.value; renderFolderRecords(); });
  $('#clear-folder-search').addEventListener('click', () => { $('#folder-search').value = ''; $('#clear-folder-search').hidden = true; renderFolderRecords(); $('#folder-search').focus(); });
  $('#back-folders').addEventListener('click', () => { showPage('home'); window.scrollTo({ top: 0, behavior: 'instant' }); });
  $('#back-folder').addEventListener('click', () => { showPage('folder'); window.scrollTo({ top: 0, behavior: 'instant' }); });

  if (!config.url || !config.anonKey) $('#auth-message').textContent = 'Recordings are temporarily unavailable. Please try again later.';
  updateAuthView();
})();
