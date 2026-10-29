const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseIncomingLine } = require('../src/protocol');

const samplePath = path.join(__dirname, '..', 'docs', 'references', 'device-sample.csv');
const sampleLines = fs.readFileSync(samplePath, 'utf8').split(/\r?\n/).filter(Boolean);

test('the supplied device sample remains parseable without conflating TOFR, TOFC, and PTC', () => {
  let mode = null;
  const records = sampleLines.map((raw) => {
    const record = parseIncomingLine(raw, mode);
    if (record.mode) mode = record.mode;
    return record;
  });

  assert.equal(records.filter((record) => record.type === 'tof_ratio').length, 7);
  assert.equal(records.filter((record) => record.type === 'tof_count').length, 7);
  assert.equal(records.filter((record) => record.type === 'ptc_count').length, 8);
  assert.equal(records.filter((record) => record.type === 'date_header').length, 2);
  assert.equal(records[0].sourceDate, '07:06:2000');
  assert.equal(records[1].type, 'tof_count');
  assert.equal(records[1].value, 0);
  assert.equal(records[1].denominator, 4);
  assert.equal(records.find((record) => record.raw === '23:10,13/20').type, 'ptc_count');
});

test('mode markers apply to subsequent count messages and remain events themselves', () => {
  const tofMarker = parseIncomingLine('T');
  const tofCount = parseIncomingLine('23:04,C,3/4', tofMarker.mode);
  const ptcMarker = parseIncomingLine('P', tofMarker.mode);
  const ptcCount = parseIncomingLine('23:10,13/20', ptcMarker.mode);

  assert.equal(tofMarker.type, 'mode');
  assert.equal(tofCount.type, 'tof_count');
  assert.equal(tofCount.value, 3);
  assert.equal(tofCount.denominator, 4);
  assert.equal(ptcMarker.type, 'mode');
  assert.equal(ptcCount.type, 'ptc_count');
  assert.equal(ptcCount.value, 13);
  assert.equal(ptcCount.denominator, 20);
});

test('unrecognized device messages retain their original text and are not plotted as measurements', () => {
  const raw = 'device-specific message, keep this text';
  const record = parseIncomingLine(raw, 'T');

  assert.equal(record.raw, raw);
  assert.equal(record.type, 'unparsed_message');
  assert.equal(record.value, null);
});

test('a TOF ratio is not inferred from a count fraction', () => {
  const record = parseIncomingLine('23:05,C,3/4', 'T');

  assert.equal(record.type, 'tof_count');
  assert.notEqual(record.type, 'tof_ratio');
  assert.equal(record.value, 3);
  assert.equal(record.denominator, 4);
});
