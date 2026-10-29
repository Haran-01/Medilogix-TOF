function parseIncomingLine(raw, currentMode = null) {
  const text = String(raw).trim();
  const result = { raw, mode: currentMode, type: 'unknown', deviceTime: null, value: null, denominator: null, interpretationConfirmed: false };
  if (!text) return { ...result, type: 'blank' };

  const modeOnly = text.match(/^(T|P)$/i);
  if (modeOnly) return { ...result, type: 'mode', mode: modeOnly[1].toUpperCase(), event: 'mode_change' };

  const dateHeader = text.match(/^(\d{1,2}:\d{2}:\d{4}),\s*([TP])$/i);
  if (dateHeader) return { ...result, type: 'date_header', sourceDate: dateHeader[1], mode: dateHeader[2].toUpperCase(), event: 'date_and_mode' };

  const countWithMarker = text.match(/^(\d{1,2}:\d{2}),\s*C,\s*(\d+)\s*\/\s*(\d+)$/i);
  if (countWithMarker) return {
    ...result, type: 'tof_count', deviceTime: countWithMarker[1], mode: 'T',
    value: Number(countWithMarker[2]), denominator: Number(countWithMarker[3]),
    sourceMarker: 'C'
  };

  const fraction = text.match(/^(\d{1,2}:\d{2}),\s*(\d+)\s*\/\s*(\d+)$/i);
  if (fraction) {
    const type = currentMode === 'P' ? 'ptc_count' : currentMode === 'T' ? 'tof_count' : 'unclassified_count';
    return {
      ...result, type, deviceTime: fraction[1],
      value: Number(fraction[2]), denominator: Number(fraction[3]),
      mode: currentMode, interpretationConfirmed: false
    };
  }

  const numeric = text.match(/^(\d{1,2}:\d{2}),\s*(-?\d+(?:\.\d+)?)$/);
  if (numeric) return {
    ...result, type: currentMode === 'T' ? 'tof_ratio' : 'unknown_numeric',
    deviceTime: numeric[1], value: Number(numeric[2]), mode: currentMode,
    unit: currentMode === 'T' ? 'percent' : null
  };

  const timestamped = text.match(/^(\d{1,2}:\d{2}),\s*(.*)$/);
  if (timestamped) return { ...result, type: 'unparsed_message', deviceTime: timestamped[1], payload: timestamped[2] };
  return { ...result, type: 'unparsed_message' };
}

module.exports = { parseIncomingLine };
