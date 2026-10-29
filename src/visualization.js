(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const palette = { green: '#2daf57', yellow: '#e9bf25', orange: '#dc7936', red: '#d94c43', ink: '#364655', grid: '#d8e0e6' };

  function svgNode(name, attrs = {}, text = '') {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text) node.textContent = text;
    return node;
  }

  function clockMinutes(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]); const minutes = Number(match[2]);
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
  }

  function preparePoints(records) {
    let previousClock = null;
    let dayOffset = 0;
    let segment = 0;
    let headerCount = 0;
    return records.flatMap((record) => {
      if (record.type === 'date_header') {
        if (headerCount > 0) segment += 1;
        headerCount += 1;
        return [];
      }
      if (!record.complete) return [];
      const type = record.type;
      if (!['tof_ratio', 'tof_count', 'ptc_count'].includes(type) || !Number.isFinite(Number(record.value))) return [];
      const nativeValue = Number(record.value);
      let y;
      if (type === 'tof_ratio') y = 240 - Math.max(0, Math.min(nativeValue, 100)) * 1.55;
      else if (type === 'tof_count') {
        const denominator = Number(record.denominator) || 4;
        y = 310 - Math.max(0, Math.min(nativeValue, denominator)) / denominator * 65;
      } else {
        const denominator = Number(record.denominator) || 20;
        y = 365 - Math.max(0, Math.min(nativeValue, denominator)) / denominator * 95;
      }
      let x = clockMinutes(record.deviceTime);
      if (x !== null) {
        if (previousClock !== null && x < previousClock && previousClock - x > 720) dayOffset += 1440;
        previousClock = x;
        x += dayOffset;
      } else {
        const received = Date.parse(record.receivedAt);
        x = Number.isNaN(received) ? (record.sequence || 0) : received / 60000;
      }
      const valueLabel = type === 'tof_ratio' ? `TOFR ${nativeValue}%` : `${type === 'tof_count' ? 'TOFC' : 'PTC'} ${nativeValue}/${Number(record.denominator) || (type === 'tof_count' ? 4 : 20)}`;
      const timeLabel = record.deviceTime || (record.receivedAt ? new Date(record.receivedAt).toLocaleTimeString() : '');
      return [{ x, y, type, record, valueLabel, timeLabel, segment }];
    });
  }

  function colorAt(y) {
    if (y <= 190) return palette.green;
    if (y <= 240) return palette.yellow;
    if (y <= 315) return palette.orange;
    return palette.red;
  }

  function fmtElapsed(minutes) {
    const rounded = Math.max(0, Math.round(minutes));
    const hours = Math.floor(rounded / 60);
    const mins = rounded % 60;
    return hours ? `${hours}h ${String(mins).padStart(2, '0')}m` : `${mins}m`;
  }

  function render(records, pan = 100, zoom = 1) {
    const svg = document.querySelector('#trend-chart');
    const all = preparePoints(records);
    const countNode = document.querySelector('#chart-point-count');
    countNode.textContent = `${all.length} measurement${all.length === 1 ? '' : 's'}`;
    const firstHeader = records.find((record) => record.type === 'date_header')?.sourceDate;
    const startLabel = document.querySelector('#chart-start-label');
    const endLabel = document.querySelector('#chart-end-label');
    if (!all.length) {
      svg.replaceChildren();
      svg.append(svgNode('text', { x: 450, y: 200, 'text-anchor': 'middle', fill: '#748296', 'font-size': 15 }, 'No recognized TOFR, TOFC, or PTC measurements in this session.'));
      startLabel.textContent = firstHeader ? `Device date text: ${firstHeader} (unconfirmed)` : 'No device time';
      endLabel.textContent = '—';
      return;
    }

    const visibleCount = Math.max(5, Math.ceil(all.length / Math.max(1, zoom)));
    const maxStart = Math.max(0, all.length - Math.min(visibleCount, all.length));
    const begin = Math.round(maxStart * Math.max(0, Math.min(Number(pan) / 100, 1)));
    const points = all.slice(begin, begin + visibleCount);
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const xSpan = maxX - minX || 1;
    const left = 45; const right = 870; const top = 30; const bottom = 380;
    const xPos = (point) => left + ((point.x - minX) / xSpan) * (right - left);
    svg.replaceChildren();
    svg.append(svgNode('rect', { x: 0, y: 0, width: 900, height: 420, fill: '#fff' }));
    svg.append(svgNode('rect', { x: left, y: top, width: right - left, height: bottom - top, fill: '#fff', stroke: palette.ink, 'stroke-width': 1.4 }));
    const guides = [
      { y: 100, text: '90%' }, { y: 178, text: '40%' }, { y: 224, text: '10%' },
      { y: 255, text: 'TOFC > 0' }, { y: 310, text: 'PTC > 0' }, { y: 365, text: 'PTC = 0' }
    ];
    guides.forEach(({ y }) => svg.append(svgNode('line', { x1: left, x2: right, y1: y, y2: y, stroke: y < 240 ? '#42bc60' : y < 300 ? '#38a989' : '#d27b44', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' })));
    for (let i = 1; i < 5; i += 1) {
      const y = top + ((bottom - top) * i) / 5;
      svg.append(svgNode('line', { x1: left, x2: right, y1: y, y2: y, stroke: '#e6ebef', 'stroke-width': 1 }));
    }
    const mapped = points.map((point) => ({ ...point, px: xPos(point) }));
    for (let i = 1; i < mapped.length; i += 1) {
      const a = mapped[i - 1]; const b = mapped[i];
      if (a.segment === b.segment) svg.append(svgNode('line', { x1: a.px, y1: a.y, x2: b.px, y2: b.y, stroke: colorAt((a.y + b.y) / 2), 'stroke-width': 2, 'stroke-linecap': 'round' }));
    }
    mapped.forEach((point) => {
      const circle = svgNode('circle', { cx: point.px, cy: point.y, r: 3.2, fill: colorAt(point.y), stroke: '#fff', 'stroke-width': 1 });
      circle.append(svgNode('title', {}, `${point.timeLabel} · ${point.valueLabel} · received ${point.record.receivedAt || 'time unavailable'}`));
      svg.append(circle);
    });
    const first = points[0]; const last = points[points.length - 1];
    svg.append(svgNode('text', { x: left, y: 403, fill: '#627184', 'font-size': 11 }, first.timeLabel));
    svg.append(svgNode('text', { x: right, y: 403, fill: '#627184', 'font-size': 11, 'text-anchor': 'end' }, last.timeLabel));
    svg.append(svgNode('text', { x: right - 4, y: 393, fill: '#627184', 'font-size': 10, 'text-anchor': 'end' }, `Elapsed ${fmtElapsed(last.x - first.x)}`));
    startLabel.textContent = firstHeader ? `Device date text: ${firstHeader} (unconfirmed)` : `From ${first.timeLabel || 'start'}`;
    endLabel.textContent = `To ${last.timeLabel || 'end'} · elapsed ${fmtElapsed(last.x - first.x)}`;
  }

  window.renderSessionChart = render;
})();
