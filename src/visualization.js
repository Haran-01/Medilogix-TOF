(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COLORS = { tofr: '#239f3a', tofc: '#d99b00', ptc: '#ff790d' };
  const LABELS = { tofr: 'TOFR (%)', tofc: 'TOFC count', ptc: 'PTC count' };
  const PANELS = {
    tofr: { top: 40, bottom: 214, min: 0, max: 100, ticks: [0, 50, 100], label: 'TOFR (%)' },
    tofc: { top: 230, bottom: 278, min: 0, max: 4, ticks: [0, 2, 4], label: 'TOFC count (out of 4)' },
    ptc: { top: 294, bottom: 364, min: 0, max: 20, ticks: [0, 10, 20], label: 'PTC count (out of 20)' }
  };
  const plot = { left: 230, right: 1370, top: 40, bottom: 364 };

  function svg(tag, attrs = {}, text = '') {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text) node.textContent = text;
    return node;
  }

  function minuteValue(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function preparePoints(records) {
    let segment = 0;
    let previousMinute = null;
    let dayOffset = 0;
    const points = [];
    for (const record of records || []) {
      if (record.type === 'date_header') {
        segment += 1;
        previousMinute = null;
        dayOffset = 0;
        continue;
      }
      const metric = record.type === 'tof_ratio' ? 'tofr' : record.type === 'tof_count' ? 'tofc' : record.type === 'ptc_count' ? 'ptc' : null;
      const minute = minuteValue(record.deviceTime);
      if (!metric || minute === null || !Number.isFinite(Number(record.value))) continue;
      if (previousMinute !== null && minute < previousMinute) dayOffset += 1440;
      previousMinute = minute;
      points.push({ ...record, metric, xTime: minute + dayOffset, segment });
    }
    return points;
  }

  function formatTime(minutes) {
    const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  }

  function renderSessionChart(records, pan = 100, zoom = 1) {
    const chart = document.querySelector('#trend-chart');
    if (!chart) return;
    chart.replaceChildren();
    chart.setAttribute('viewBox', '0 0 1400 450');
    const points = preparePoints(records);
    const countLabel = document.querySelector('#chart-point-count');
    if (countLabel) countLabel.textContent = `${points.length} measurements`;
    if (!points.length) {
      chart.append(svg('text', { x: 700, y: 220, 'text-anchor': 'middle', fill: '#68798b', 'font-size': 16 }, 'No measurements to display'));
      const start = document.querySelector('#chart-start-label'); if (start) start.textContent = '—';
      const end = document.querySelector('#chart-end-label'); if (end) end.textContent = '—';
      return;
    }

    // Avoid spreading large recordings into function arguments; imported files can
    // contain enough measurements to exceed the engine's argument-count limit.
    let allStart = Infinity;
    let allEnd = -Infinity;
    for (const point of points) {
      if (point.xTime < allStart) allStart = point.xTime;
      if (point.xTime > allEnd) allEnd = point.xTime;
    }
    const total = Math.max(1, allEnd - allStart);
    const visibleDuration = Math.max(1, total / Math.max(1, Number(zoom) || 1));
    const availablePan = Math.max(0, total - visibleDuration);
    const viewStart = allStart + availablePan * (Math.min(100, Math.max(0, Number(pan) || 0)) / 100);
    const viewEnd = viewStart + visibleDuration;
    const visible = points.filter((point) => point.xTime >= viewStart && point.xTime <= viewEnd);
    const x = (value) => plot.left + ((value - viewStart) / Math.max(1, viewEnd - viewStart)) * (plot.right - plot.left);
    const y = (point) => {
      const panel = PANELS[point.metric];
      const max = Math.max(panel.max, Number(point.denominator) || 0);
      return panel.bottom - (Math.min(max, Math.max(0, Number(point.value))) / max) * (panel.bottom - panel.top);
    };

    // Each metric occupies its own native-value lane. All lanes share the same time scale.
    for (const [metric, panel] of Object.entries(PANELS)) {
      const compactLabel = metric === 'tofr' ? 'TOFR (%)' : `${metric.toUpperCase()} count`;
      chart.append(svg('text', { x: 14, y: (panel.top + panel.bottom) / 2, 'text-anchor': 'start', 'dominant-baseline': 'middle', fill: COLORS[metric], 'font-size': 14, 'font-weight': 700 }, compactLabel));
      for (const tick of panel.ticks) {
        const yy = panel.bottom - (tick / panel.max) * (panel.bottom - panel.top);
        chart.append(svg('line', { x1: plot.left, y1: yy, x2: plot.right, y2: yy, stroke: tick === panel.min ? '#c8cdd2' : '#d9dde1', 'stroke-width': tick === panel.min ? 2 : 1 }));
        chart.append(svg('text', { x: plot.left - 9, y: yy + 4, 'text-anchor': 'end', fill: '#596a79', 'font-size': 11 }, String(tick)));
      }
    }
    chart.append(svg('line', { x1: plot.left, y1: plot.top, x2: plot.left, y2: plot.bottom, stroke: '#465563', 'stroke-width': 1.5 }));
    chart.append(svg('line', { x1: plot.left, y1: 380, x2: plot.right, y2: 380, stroke: '#465563', 'stroke-width': 1.5 }));

    // Color each chronological interval by the metric of the point it reaches; date headers split sessions.
    const bySegment = new Map();
    for (const point of visible) {
      if (!bySegment.has(point.segment)) bySegment.set(point.segment, []);
      bySegment.get(point.segment).push(point);
    }
    for (const segmentPoints of bySegment.values()) {
      for (let index = 1; index < segmentPoints.length; index += 1) {
        const previous = segmentPoints[index - 1];
        const current = segmentPoints[index];
        const d = `M ${x(previous.xTime).toFixed(2)} ${y(previous).toFixed(2)} L ${x(current.xTime).toFixed(2)} ${y(current).toFixed(2)}`;
        chart.append(svg('path', { d, fill: 'none', stroke: COLORS[current.metric], 'stroke-width': 2.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-series': 'chronological', 'data-metric': current.metric }));
      }
    }

    // Time labels use actual observed timestamps at a restrained interval.
    const tickCandidates = visible.filter((point, index) => index === 0 || index === visible.length - 1 || point.xTime - visible[index - 1].xTime >= Math.max(1, visibleDuration / 12));
    const seen = new Set();
    for (const point of tickCandidates) {
      if (seen.has(point.xTime)) continue;
      seen.add(point.xTime);
      const xx = x(point.xTime);
      chart.append(svg('line', { x1: xx, y1: 380, x2: xx, y2: 385, stroke: '#465563', 'stroke-width': 1 }));
      chart.append(svg('text', { x: xx, y: 407, 'text-anchor': 'end', fill: '#526272', 'font-size': 11, transform: `rotate(-42 ${xx} 407)` }, formatTime(point.xTime)));
    }
    chart.append(svg('text', { x: plot.left, y: 438, fill: '#68798b', 'font-size': 12 }, formatTime(viewStart)));
    const duration = Math.max(0, Math.round(viewEnd - allStart));
    chart.append(svg('text', { x: plot.right, y: 438, 'text-anchor': 'end', fill: '#68798b', 'font-size': 12 }, `Elapsed ${Math.floor(duration / 60)}h ${String(duration % 60).padStart(2, '0')}m · ${formatTime(viewEnd)}`));

    for (const point of visible) {
      const denominator = point.denominator ? `/${point.denominator}` : '%';
      const title = `${LABELS[point.metric]} ${point.value}${point.metric === 'tofr' ? '%' : denominator} · ${point.deviceTime}`;
      const mark = svg('circle', { cx: x(point.xTime).toFixed(2), cy: y(point).toFixed(2), r: 4.8, fill: COLORS[point.metric], stroke: '#fff', 'stroke-width': 1.4, 'data-metric': point.metric });
      mark.append(svg('title', {}, title));
      chart.append(mark);
    }

    const startLabel = document.querySelector('#chart-start-label');
    const endLabel = document.querySelector('#chart-end-label');
    if (startLabel) startLabel.textContent = formatTime(viewStart);
    if (endLabel) endLabel.textContent = `Elapsed ${Math.max(0, Math.round(viewEnd - allStart))}m · ${formatTime(viewEnd)}`;
  }

  window.renderSessionChart = renderSessionChart;
})();
