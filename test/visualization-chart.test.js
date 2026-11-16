const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { parseIncomingLine } = require('../src/protocol');

class FakeSvgNode {
  constructor(tagName, attributes = {}, textContent = '') {
    this.tagName = tagName;
    this.attributes = { ...attributes };
    this.textContent = textContent;
    this.children = [];
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(node) { this.children.push(node); }
  replaceChildren(...nodes) { this.children = nodes; }
}

function getSampleRecords() {
  const sample = fs.readFileSync(path.join(__dirname, '../docs/references/device-sample.csv'), 'utf8');
  let mode = null;
  return sample.split(/\r?\n/).filter(Boolean).map((raw, index) => {
    const parsed = parseIncomingLine(raw, mode);
    if (parsed.mode) mode = parsed.mode;
    return { ...parsed, raw, complete: true, sequence: index + 1, receivedAt: '2026-10-29T00:00:00.000Z' };
  });
}

test('sample chart uses stacked native-value regions and connects points in chronological order', () => {
  const nodes = new Map([
    ['#trend-chart', new FakeSvgNode('svg')],
    ['#chart-point-count', new FakeSvgNode('span')],
    ['#chart-start-label', new FakeSvgNode('span')],
    ['#chart-end-label', new FakeSvgNode('span')]
  ]);
  const document = {
    querySelector: (selector) => nodes.get(selector),
    createElementNS: (_namespace, tagName) => new FakeSvgNode(tagName)
  };
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '../src/visualization.js'), 'utf8');
  vm.runInNewContext(source, { document, window, Date, Map, Number, Math, String });
  window.renderSessionChart(getSampleRecords());

  const svg = nodes.get('#trend-chart');
  const descendants = [];
  const visit = (node) => { descendants.push(node); node.children.forEach(visit); };
  svg.children.forEach(visit);
  const marks = descendants.filter((node) => node.children.some((child) => child.tagName === 'title'));
  const counts = Object.fromEntries(['ptc', 'tofc', 'tofr'].map((metric) => [metric, marks.filter((node) => node.attributes['data-metric'] === metric).length]));
  assert.equal(nodes.get('#chart-point-count').textContent, '22 measurements');
  assert.deepEqual(counts, { ptc: 8, tofc: 7, tofr: 7 });
  const paths = descendants.filter((node) => node.attributes['data-series'] === 'chronological');
  assert.equal(paths.length, 20, 'the repeated date header starts a new segment, so the final point stays isolated');
  assert.ok(paths.every((node) => node.attributes.d.startsWith('M ') && node.attributes.d.includes(' L ')));
  assert.deepEqual([...new Set(paths.map((node) => node.attributes['data-metric']))].sort(), ['ptc', 'tofc', 'tofr']);
  assert.equal(paths.find((node) => node.attributes['data-metric'] === 'tofc').attributes.stroke, '#d99b00');
  assert.equal(marks.find((node) => node.attributes['data-metric'] === 'tofc').attributes.fill, '#d99b00');
  assert.ok(marks.some((node) => node.children.some((child) => child.textContent === 'TOFR (%) 100% · 23:52')));
  assert.ok(descendants.some((node) => node.textContent === 'PTC count'));
  assert.ok(descendants.some((node) => node.textContent === 'TOFC count'));
  assert.ok(descendants.some((node) => node.textContent === 'TOFR (%)'));
  assert.match(nodes.get('#chart-end-label').textContent, /Elapsed 52m/);
});
