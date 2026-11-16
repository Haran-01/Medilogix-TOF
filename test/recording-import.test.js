const assert = require('node:assert/strict');
const test = require('node:test');
const { splitCapturedRecords, splitImportedFile } = require('../src/recording-import');

test('separates date/name/age/gender text blocks and retains only each patient portion', () => {
  const input = [
    '2026-11-02 10:30:00', 'John Doe', '45', 'Male', 'T', '23:00,100', '23:01,C,3/4',
    '2026-11-02 11:15:00', 'Sarah', '52', 'Female', 'T', '23:10,75',
    '2026-11-02 12:40:00', 'P', '23:20,13/20'
  ].join('\n');
  const result = splitImportedFile(input);

  assert.equal(result.recordings.length, 3);
  assert.deepEqual(result.recordings.map(({ patientName, age, gender, recordingDate, measurementCount }) => ({ patientName, age, gender, recordingDate, measurementCount })), [
    { patientName: 'John Doe', age: 45, gender: 'Male', recordingDate: '2026-11-02', measurementCount: 2 },
    { patientName: 'Sarah', age: 52, gender: 'Female', recordingDate: '2026-11-02', measurementCount: 1 },
    { patientName: '', age: null, gender: '', recordingDate: '2026-11-02', measurementCount: 1 }
  ]);
  assert.deepEqual(result.recordings[0].entries.map((entry) => entry.raw), ['T', '23:00,100', '23:01,C,3/4']);
  assert.ok(result.recordings[1].records.every((record) => !record.raw.includes('John Doe')));
});

test('a later header replaces an incomplete header before measurements begin', () => {
  const input = [
    '02/11/2026', 'First candidate', '45', 'Male',
    '02/11/2026', 'Latest patient', '22', 'Female',
    'T', '15:00,74'
  ].join('\n');
  const result = splitImportedFile(input);
  assert.equal(result.recordings.length, 1);
  assert.equal(result.recordings[0].patientName, 'Latest patient');
  assert.equal(result.recordings[0].age, 22);
  assert.equal(result.recordings[0].measurementCount, 1);
});

test('partial demographics are kept for preview completion instead of becoming measurement messages', () => {
  const result = splitImportedFile(['2026-11-02', 'Jane Doe', 'T', '15:00,74'].join('\n'));
  assert.equal(result.recordings.length, 1);
  assert.equal(result.recordings[0].patientName, 'Jane Doe');
  assert.equal(result.recordings[0].age, null);
  assert.equal(result.recordings[0].measurementCount, 1);
  assert.deepEqual(result.recordings[0].entries.map((entry) => entry.raw), ['T', '15:00,74']);
});

test('consumes available demographics without treating a gender line as a reading when age is missing', () => {
  const result = splitImportedFile(['2026-11-02', 'Jane Doe', 'Female', 'T', '15:00,74'].join('\n'));
  const patient = result.recordings[0];

  assert.equal(patient.patientName, 'Jane Doe');
  assert.equal(patient.age, null);
  assert.equal(patient.gender, 'Female');
  assert.deepEqual(patient.entries.map((entry) => entry.raw), ['T', '15:00,74']);
});

test('recognizes day-first date headers with times as patient boundaries', () => {
  const result = splitImportedFile([
    '02/11/2026 10:30:00', 'John Doe', '45', 'Male', 'T', '23:00,74',
    '03/11/2026 11:15:00', 'Sarah', '52', 'Female', 'T', '23:10,75'
  ].join('\n'));

  assert.equal(result.recordings.length, 2);
  assert.deepEqual(result.recordings.map(({ recordingDate, patientName, measurementCount }) => ({ recordingDate, patientName, measurementCount })), [
    { recordingDate: '2026-11-02', patientName: 'John Doe', measurementCount: 1 },
    { recordingDate: '2026-11-03', patientName: 'Sarah', measurementCount: 1 }
  ]);
});

test('recognizes a compact day-first timestamp and demographics header', () => {
  const result = splitImportedFile(['02/11/2026 10:30:00 John Doe 45 Male', 'T', '23:00,74'].join('\n'));

  assert.equal(result.recordings.length, 1);
  assert.deepEqual({
    recordingDate: result.recordings[0].recordingDate,
    patientName: result.recordings[0].patientName,
    age: result.recordings[0].age,
    gender: result.recordings[0].gender
  }, { recordingDate: '2026-11-02', patientName: 'John Doe', age: 45, gender: 'Male' });
});

test('splits app CSV exports at repeated date headers and attaches date markers to pending patient headers', () => {
  const rows = [
    'sequence,received_at,device_time,mode,event_type,value,denominator,raw,complete',
    '1,2026-10-31T10:00:00Z,,T,date_header,,,"07:06:2000,T",true',
    '2,2026-10-31T10:00:01Z,23:00,T,tof_ratio,100,,"23:00,100",true',
    '3,2026-10-31T10:00:02Z,,T,date_header,,,"07:06:2000,T",true',
    '4,2026-10-31T10:00:03Z,23:52,T,tof_ratio,100,,"23:52,100",true',
    '5,2026-10-31T10:00:04Z,,T,unparsed_message,,,"31:10:2026 BAAAA 000 M",true',
    '6,2026-10-31T10:00:05Z,,T,unparsed_message,,,"31:10:2026 BCDEF 022 M",true',
    '7,2026-10-31T10:00:06Z,,T,date_header,,,"31:10:2026,T",true',
    '8,2026-10-31T10:00:07Z,15:24,T,tof_ratio,74,,"15:24,74",true',
    '9,2026-10-31T10:00:08Z,,T,unparsed_message,,,"31:10:2026 HARAN 022 M",true',
    '10,2026-10-31T10:00:09Z,,T,date_header,,,"31:10:2026,T",true',
    '11,2026-10-31T10:00:10Z,15:37,T,tof_ratio,96,,"15:37,96",true'
  ].join('\n');
  const result = splitImportedFile(rows);

  assert.equal(result.sourceFormat, 'medilogix-export');
  assert.equal(result.recordings.length, 4);
  assert.deepEqual(result.recordings.map((record) => record.measurementCount), [1, 1, 1, 1]);
  assert.equal(result.recordings[0].records.filter((record) => record.type === 'date_header').length, 1);
  assert.equal(result.recordings[1].records.filter((record) => record.type === 'date_header').length, 1);
  assert.equal(result.recordings[1].patientName, '');
  assert.equal(result.recordings[2].patientName, 'BCDEF');
  assert.equal(result.recordings[2].age, 22);
  assert.equal(result.recordings[2].records.filter((record) => record.type === 'date_header').length, 1);
  assert.equal(result.recordings[3].patientName, 'HARAN');
  assert.equal(result.recordings[3].records.filter((record) => record.type === 'date_header').length, 1);
});

test('manual live-capture save uses the same four-segment parser as a structured export', () => {
  const rawMessages = [
    ['date_header', '07:06:2000,T', 'T'],
    ['tof_count', '23:00,C,0/4', 'T'],
    ['tof_ratio', '23:01,100', 'T'],
    ['date_header', '07:06:2000,T', 'T'],
    ['tof_ratio', '23:52,100', 'T'],
    ['unparsed_message', '31:10:2026 BAAAA 000 M', 'T'],
    ['unparsed_message', '31:10:2026 BCDEF 022 M', 'T'],
    ['date_header', '31:10:2026,T', 'T'],
    ['tof_ratio', '15:24,74', 'T'],
    ['unparsed_message', '31:10:2026 HARAN 022 M', 'T'],
    ['date_header', '31:10:2026,T', 'T'],
    ['tof_ratio', '15:37,96', 'T']
  ];
  const result = splitCapturedRecords(rawMessages.map(([type, raw, mode], index) => ({
    sequence: index + 1,
    receivedAt: `2026-10-31T10:00:${String(index).padStart(2, '0')}Z`,
    type,
    raw,
    mode,
    complete: true
  })));

  assert.deepEqual(result.recordings.map((record) => record.measurementCount), [2, 1, 1, 1]);
  assert.deepEqual(result.recordings.map((record) => record.patientName), ['', '', 'BCDEF', 'HARAN']);
  assert.equal(result.recordings[2].headerReplacementCount, 1);
  assert.ok(result.recordings.every((record) => record.records.every((message) => message.sourceReceivedAt)));
});

test('manual live-capture parsing preserves an unterminated final line as incomplete', () => {
  const result = splitCapturedRecords([
    { sequence: 1, receivedAt: '2026-11-02T10:00:00Z', type: 'date_header', raw: '02:11:2026,T', mode: 'T', complete: true },
    { sequence: 2, receivedAt: '2026-11-02T10:00:01Z', type: 'tof_ratio', raw: '15:24,74', mode: 'T', complete: false }
  ]);

  const reading = result.recordings[0].records.find((record) => record.raw === '15:24,74');
  assert.equal(reading.type, 'tof_ratio');
  assert.equal(reading.value, 74);
  assert.equal(reading.complete, false);
});

test('live capture separates a different patient sequence without mixing TOF and PTC readings', () => {
  const messages = [
    ['date_header', '02:11:2026,T', 'T'],
    ['tof_count', '23:00,C,0/4', 'T'],
    ['tof_ratio', '23:01,78', 'T'],
    ['unparsed_message', '02:11:2026 Ana 40 F', 'T'],
    ['unparsed_message', '02:11:2026 Bob 55 M', 'T'],
    ['date_header', '02:11:2026,T', 'T'],
    ['tof_count', '23:04,C,3/4', 'T'],
    ['mode', 'P', 'P'],
    ['ptc_count', '23:05,8/20', 'P'],
    ['unparsed_message', '02:11:2026 Cara 33 Female', 'P'],
    ['date_header', '02:11:2026,T', 'T'],
    ['tof_count', '23:08,C,2/4', 'T'],
    ['tof_ratio', '23:09,66', 'T']
  ];
  const result = splitCapturedRecords(messages.map(([type, raw, mode], index) => ({
    sequence: index + 1,
    receivedAt: `2026-11-02T10:00:${String(index).padStart(2, '0')}Z`,
    type,
    mode,
    raw,
    complete: true
  })));

  assert.deepEqual(result.recordings.map(({ patientName, age, gender, measurementCount }) => ({ patientName, age, gender, measurementCount })), [
    { patientName: '', age: null, gender: '', measurementCount: 2 },
    { patientName: 'Bob', age: 55, gender: 'Male', measurementCount: 2 },
    { patientName: 'Cara', age: 33, gender: 'Female', measurementCount: 2 }
  ]);
  assert.deepEqual(result.recordings[1].records.filter((record) => record.type.endsWith('_count')).map((record) => record.type), ['tof_count', 'ptc_count']);
  assert.ok(result.recordings[1].records.every((record) => !record.raw.includes('Cara')));
  assert.ok(result.recordings[2].records.every((record) => !record.raw.includes('Bob')));
});

test('rejects input without recognized measurements', () => {
  assert.throws(() => splitImportedFile('2026-11-02\nJohn Doe\n45\nMale'), /No recognized measurement/);
});
