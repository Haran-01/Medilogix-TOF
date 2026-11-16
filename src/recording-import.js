const { parseIncomingLine } = require('./protocol');

const GENDERS = new Map([
  ['m', 'Male'], ['male', 'Male'],
  ['f', 'Female'], ['female', 'Female'],
  ['other', 'Other'], ['non-binary', 'Other'], ['nonbinary', 'Other'],
  ['prefer not to say', 'Prefer not to say'], ['unknown', 'Unknown']
]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

function normalizeDate(raw) {
  const value = String(raw || '').trim();
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  let year; let month; let day;
  if (iso) [, year, month, day] = iso;
  else {
    const dmy = value.match(/^(\d{1,2})[:\/-](\d{1,2})[:\/-](\d{4})(?:\s+.*)?$/);
    if (!dmy) return null;
    [, day, month, year] = dmy;
  }
  const y = Number(year); const m = Number(month); const d = Number(day);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseCompactPatientHeader(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/^(\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}[:\/-]\d{1,2}[:\/-]\d{4}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\s+(.+?)\s+(\d{1,3})\s+([A-Za-z][A-Za-z -]*)$/);
  if (!match) return null;
  const gender = GENDERS.get(match[4].trim().toLowerCase());
  const age = Number(match[3]);
  const patientName = match[2].trim();
  const recordingDate = normalizeDate(match[1]);
  if (!recordingDate || !gender || !patientName || age > 150) return null;
  return { recordingDate, recordingDateText: match[1], patientName, age, gender, sourceHeader: value };
}

function parseDateOnlyHeader(raw) {
  const value = String(raw || '').trim().replace(/,\s*[TP]$/i, '');
  const match = value.match(/^(\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}[:\/-]\d{1,2}[:\/-]\d{4}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)$/);
  if (!match) return null;
  const recordingDate = normalizeDate(match[1]);
  return recordingDate ? { recordingDate, recordingDateText: match[1], sourceHeader: value } : null;
}

function normalizeGender(value) {
  return GENDERS.get(String(value || '').trim().toLowerCase()) || '';
}

function makeEntry(raw, source = {}) {
  return { raw: String(raw ?? '').replace(/\r$/, ''), sourceSequence: source.sequence || null, sourceReceivedAt: source.receivedAt || null, mode: source.mode || null, eventType: source.eventType || null, complete: source.complete };
}

function importRows(text) {
  const rows = parseCsv(text);
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) || [];
  const rawColumn = header.indexOf('raw');
  const structuredExport = rawColumn >= 0 && header.includes('event_type') && header.includes('sequence');
  if (structuredExport) {
    return { structuredExport, entries: rows.slice(1).map((cells) => {
      const get = (name) => { const index = header.indexOf(name); return index < 0 ? '' : cells[index] || ''; };
      const completeValue = get('complete').trim().toLowerCase();
      const complete = completeValue === '' ? undefined : !['false', '0', 'no'].includes(completeValue);
      return makeEntry(get('raw'), { sequence: get('sequence'), receivedAt: get('received_at'), mode: get('mode'), eventType: get('event_type'), complete });
    }).filter((entry) => entry.raw.trim()) };
  }
  // A non-export CSV is treated as a line-oriented serial file, one source row per line.
  const looksLikeHeader = header.some((cell) => ['date', 'name', 'age', 'gender', 'sequence', 'raw'].includes(cell));
  const sourceRows = looksLikeHeader ? rows.slice(1) : rows;
  return { structuredExport: false, entries: sourceRows.map((cells) => makeEntry(cells.join(','))).filter((entry) => entry.raw.trim()) };
}

function splitCapturedRecords(records) {
  if (!Array.isArray(records) || !records.length) throw new Error('There is no captured serial data to save.');
  const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = ['sequence,received_at,device_time,mode,event_type,value,denominator,raw,complete'];
  for (const record of records) {
    rows.push([
      record.sequence, record.receivedAt, record.deviceTime, record.mode,
      record.type || 'unparsed_message', record.value, record.denominator,
      record.raw, record.complete
    ].map(escapeCsv).join(','));
  }
  return splitImportedFile(rows.join('\r\n'));
}

function splitImportedFile(text) {
  const { entries, structuredExport } = importRows(text);
  if (!entries.length) throw new Error('The selected file contains no recording data.');
  const segments = [];
  let current = null;
  let mode = null;

  const create = (header = {}) => ({
    recordingDate: header.recordingDate || null,
    recordingDateText: header.recordingDateText || null,
    patientName: header.patientName || '',
    age: header.age ?? null,
    gender: header.gender || '',
    sourceHeader: header.sourceHeader || null,
    entries: [],
    records: [],
    measurementCount: 0,
    headerReplacementCount: 0
  });
  const finish = () => {
    if (current?.measurementCount) segments.push(current);
    current = null;
    mode = null;
  };
  const ensureCurrent = (header) => {
    if (!current) current = create(header);
    else if (!current.recordingDate && header?.recordingDate) {
      current.recordingDate = header.recordingDate;
      current.recordingDateText = header.recordingDateText || null;
    }
  };
  const addEntry = (entry) => {
    ensureCurrent();
    const parsed = parseIncomingLine(entry.raw, entry.mode || mode);
    if (parsed.mode) mode = parsed.mode;
    const record = { ...parsed, raw: entry.raw, complete: entry.complete ?? true };
    if (entry.sourceSequence) record.sourceSequence = Number(entry.sourceSequence) || null;
    if (entry.sourceReceivedAt) record.sourceReceivedAt = entry.sourceReceivedAt;
    current.records.push(record);
    if ((parsed.type !== 'date_header' || structuredExport) && parsed.type !== 'blank') current.entries.push(entry);
    if (['tof_ratio', 'tof_count', 'ptc_count', 'unclassified_count'].includes(parsed.type)) current.measurementCount += 1;
    if (!current.recordingDate && parsed.sourceDate) {
      current.recordingDate = normalizeDate(parsed.sourceDate);
      current.recordingDateText = parsed.sourceDate;
    }
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const compact = parseCompactPatientHeader(entry.raw);
    if (compact) {
      if (current?.measurementCount) finish();
      // If a second patient header arrives before the new record has measurements,
      // treat it as a correction/replacement of that pending header.
      const replaced = current && !current.measurementCount ? current.headerReplacementCount + 1 : 0;
      current = create(compact);
      current.headerReplacementCount = replaced;
      mode = null;
      continue;
    }

    const dateHeader = parseDateOnlyHeader(entry.raw);
    if (dateHeader && structuredExport && entry.eventType === 'date_header') {
      if (current?.measurementCount) {
        finish();
        current = create(dateHeader);
      } else if (!current) {
        current = create(dateHeader);
      } else if (!(current.patientName && current.recordingDate === dateHeader.recordingDate)) {
        const replaced = current.headerReplacementCount + 1;
        current = create(dateHeader);
        current.headerReplacementCount = replaced;
      }
      addEntry(entry);
      continue;
    }
    const explicitPatientDate = dateHeader && (!structuredExport || entry.eventType !== 'date_header');
    if (explicitPatientDate) {
      if (current?.measurementCount) finish();
      const replaced = current && !current.measurementCount ? current.headerReplacementCount + 1 : 0;
      current = create(dateHeader);
      current.headerReplacementCount = replaced;
      mode = null;
      let next = index + 1;
      while (next < entries.length && !entries[next].raw.trim()) next += 1;
      const name = entries[next]?.raw.trim();
      const nameRecord = name ? parseIncomingLine(name, mode) : null;
      if (name && !parseDateOnlyHeader(name) && !name.includes(',') && !/^\d{1,3}$/.test(name) && !normalizeGender(name) && !['mode', 'tof_ratio', 'tof_count', 'ptc_count'].includes(nameRecord.type)) {
        current.patientName = name;
        let consumedThrough = next;
        // Demographic fields may be incomplete or arrive in either order. Consume
        // only recognized metadata so it cannot leak into the patient's readings.
        for (let fieldCount = 0; fieldCount < 2; fieldCount += 1) {
          const field = entries[consumedThrough + 1]?.raw.trim();
          if (!field || parseDateOnlyHeader(field) || parseCompactPatientHeader(field)) break;
          if (current.age == null && /^\d{1,3}$/.test(field) && Number(field) <= 150) {
            current.age = Number(field);
            consumedThrough += 1;
            continue;
          }
          const gender = normalizeGender(field);
          if (!current.gender && gender) {
            current.gender = gender;
            consumedThrough += 1;
            continue;
          }
          break;
        }
        current.sourceHeader = [dateHeader.sourceHeader, name, current.age == null ? null : String(current.age), current.gender || null].filter(Boolean).join('\n');
        index = consumedThrough;
      }
      continue;
    }

    // In app exports, a device date marker after measurements starts a new segment.
    // A marker after a compact demographics header with the same date belongs to
    // that pending patient header and must not create an empty duplicate segment.
    addEntry(entry);
  }
  finish();
  if (!segments.length) throw new Error('No recognized measurement readings were found in the selected file.');
  return { sourceFormat: structuredExport ? 'medilogix-export' : 'text-or-csv', recordings: segments };
}

module.exports = { normalizeDate, parseCsv, parseCompactPatientHeader, splitCapturedRecords, splitImportedFile };
