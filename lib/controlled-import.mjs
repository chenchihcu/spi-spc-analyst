// Server-side validation for RFC-SPI-COORD-20261023. Keep the raw file immutable.
const norm = value => String(value ?? '').trim().toLowerCase().replace(/[\s_.%()/-]/g, '');
const text = value => String(value ?? '').trim();
const sideOf = value => /(?:^|[^a-z])(?:bot|bottom|btm|b)(?:[^a-z]|$)|底/i.test(text(value)) ? 'BOT'
  : /(?:^|[^a-z])(?:top|t)(?:[^a-z]|$)|頂|正/i.test(text(value)) ? 'TOP' : '';

export function parseCsv(input) {
  let source;
  if (typeof input === 'string') source = input;
  else {
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(input); }
    catch { source = new TextDecoder('big5', { fatal: true }).decode(input); }
  }
  let inHeaderQuote = false; const counts = { ',': 0, '\t': 0, ';': 0 };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') { if (inHeaderQuote && source[i + 1] === '"') i++; else inHeaderQuote = !inHeaderQuote; }
    else if (!inHeaderQuote && (ch === '\n' || ch === '\r')) break;
    else if (!inHeaderQuote && ch in counts) counts[ch]++;
  }
  const delimiter = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const out = []; let row = [], cell = '', quoted = false;
  const s = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (quoted && s[i + 1] === '"') { cell += '"'; i++; }
      else if (!quoted && cell !== '') throw new Error(`CSV 第 ${out.length + 1} 列引號格式錯誤`);
      else quoted = !quoted;
    } else if (!quoted && (ch === delimiter || ch === '\n' || ch === '\r')) {
      row.push(cell); cell = '';
      if (ch === delimiter) continue;
      out.push(row); row = [];
      if (ch === '\r' && s[i + 1] === '\n') i++;
    } else cell += ch;
  }
  if (quoted) throw new Error('CSV 引號未關閉');
  if (cell || row.length) { row.push(cell); out.push(row); }
  if (!out.length) throw new Error('檔案是空的');
  return { head: out[0], data: out.slice(1) };
}

function column(head, aliases) { return head.findIndex(h => aliases.includes(norm(h))); }
function fail(code, error, detail = {}) { return { error, code, detail }; }
function headUnit(head) {
  const xy = head.filter(h => /^(?:x|y|center[xy]|mid[xy]|pos[xy]|[xy]pos|location[xy])/i.test(text(h)));
  const units = new Set(xy.flatMap(h => /\bmil\b|_mil|\(mil\)/i.test(h) ? ['mil'] : /\binch\b|\(in\)|_in\b/i.test(h) ? ['inch'] : /\bmm\b|_mm\b/i.test(h) ? ['mm'] : []));
  return units.size === 1 ? [...units][0] : units.size > 1 ? 'conflict' : '';
}

export function validatePlacement(table, { side, unit }) {
  if (!['TOP', 'BOT', 'BOTH'].includes(side)) return fail('side', '請選擇座標檔面別');
  if (!['mm', 'mil', 'inch'].includes(unit)) return fail('unit', '請選擇座標單位');
  const h = table.head, iRef = column(h, ['refdes', 'designator', 'ref', 'reference', '位號', 'componentid', 'component', 'partname']),
    iX = column(h, ['x', 'xmm', 'xmil', 'xin', 'centerx', 'centerxmm', 'centerxmil', 'midx', 'posx', 'xpos', 'locationx', '座標x']),
    iY = column(h, ['y', 'ymm', 'ymil', 'yin', 'centery', 'centerymm', 'centerymil', 'midy', 'posy', 'ypos', 'locationy', '座標y']),
    iSide = column(h, ['layer', 'side', '面別', '面', 'tb', 'mirror']);
  if (iRef < 0 || iX < 0 || iY < 0) return fail('columns', '座標檔需要位號（RefDes）與 X、Y 欄位');
  const declared = headUnit(h);
  if (declared === 'conflict' || (declared && declared !== unit)) return fail('unit_conflict', '座標單位與欄名不一致', { declared, selected: unit });
  if (side === 'BOTH' && iSide < 0) return fail('side', '雙面座標檔必須有面別欄位');
  const seen = new Map(), items = [], k = unit === 'mil' ? 0.0254 : unit === 'inch' ? 25.4 : 1;
  for (let index = 0; index < table.data.length; index++) {
    const cells = table.data[index]; if (cells.every(c => !text(c))) continue;
    const line = index + 2, ref = text(cells[iRef]), sx = text(cells[iX]), sy = text(cells[iY]);
    const x = Number(sx), y = Number(sy);
    if (!ref || !sx || !sy || !Number.isFinite(x) || !Number.isFinite(y))
      return fail('incomplete', '上傳失敗：座標資料不完整', { line, columns: [!ref && 'RefDes', (!sx || !Number.isFinite(x)) && 'X', (!sy || !Number.isFinite(y)) && 'Y'].filter(Boolean) });
    const rowSide = iSide >= 0 ? sideOf(cells[iSide]) : side;
    if (!rowSide || (side !== 'BOTH' && rowSide !== side)) return fail('side', '上傳失敗：面別錯誤', { line, value: iSide >= 0 ? cells[iSide] : '', selected: side });
    const key = `${rowSide}\0${ref}`;
    if (seen.has(key)) return fail('duplicate_ref', '上傳失敗：重複位號', { side: rowSide, ref, lines: [seen.get(key), line] });
    seen.set(key, line);
    items.push({ ref, side: rowSide, x: x * k, y: y * k });
  }
  if (!items.length) return fail('empty', '座標檔沒有可用的位號與座標');
  const sides = [...new Set(items.map(i => i.side))];
  if (side === 'BOTH' && sides.length !== 2) return fail('side', '雙面座標檔必須同時包含 TOP 與 BOT');
  return { items, sides, unit, factor: k, declaredUnit: declared, formatVersion: 1 };
}

export function validateWideMeasurement(table, side, placement) {
  if (!['TOP', 'BOT'].includes(side)) return fail('side', '量測檔必須選擇 TOP 或 BOT');
  const h = table.head, iComp = column(h, ['componentid']), iPad = column(h, ['padid']);
  if (iComp < 0 || iPad < 0) return fail('format', '量測檔缺少 Component ID 或 PAD ID');
  const boardCols = h.map(norm).map((v, i) => ({ i, m: v.match(/^(?:height|volume|area)(?:mm)?(\d{1,2})$|^result(\d{1,2})$/) })).filter(x => x.m);
  const boards = [...new Set(boardCols.map(x => Number(x.m[1] || x.m[2])))].sort((a, b) => a - b);
  if (!boards.length || boards.some((n, i) => n !== i + 1)) return fail('format', '量測檔板序欄位必須由 1 開始且連續');
  const coords = new Set(placement.items.filter(i => i.side === side).map(i => i.ref));
  const other = new Set(placement.items.filter(i => i.side !== side).map(i => i.ref));
  const firstHeight = h.findIndex(v => /^(?:height\(?%\)?|heightmm|heightum|heightµm)1$/i.test(text(v)));
  const firstVolume = h.findIndex(v => /^volume\(?%\)?1$/i.test(text(v)));
  const firstArea = h.findIndex(v => /^area\(?%\)?1$/i.test(text(v)));
  const missing = new Set(), wrongSide = new Set(), pointKeys = new Set(), padKeys = new Set();
  for (let index = 0; index < table.data.length; index++) {
    const row = table.data[index]; if (row.every(c => !text(c))) continue;
    const rawId = text(row[iComp]);
    const shiftedPad = !text(row[iPad]) && firstHeight >= 0 && /^\d{1,4}$/.test(text(row[firstHeight]))
      && (firstVolume < 0 || !text(row[firstVolume])) && (firstArea < 0 || !text(row[firstArea]));
    const pad = shiftedPad ? text(row[firstHeight]) : text(row[iPad]);
    const match = rawId.match(/^(.+)_\d+$/);
    const ref = match ? match[1] : rawId;
    if (!ref || !pad) return fail('incomplete_measurement', '量測資料缺少 Component ID 或 PAD ID', { line: index + 2 });
    if (!coords.has(ref)) { missing.add(ref); if (other.has(ref)) wrongSide.add(ref); }
    for (const board of boards) {
      if (shiftedPad && board === 1) continue;
      const key = `${board}\0${ref}\0${pad}`;
      if (pointKeys.has(key)) return fail('duplicate_point', '量測點重複', { line: index + 2, rawId, ref, pad, board });
      pointKeys.add(key);
      padKeys.add(`${ref}\0${pad}`);
    }
  }
  if (!pointKeys.size) return fail('empty', '量測檔沒有可用資料');
  return { boards: boards.length, missing: [...missing].sort(), wrongSide: [...wrongSide].sort(), points: pointKeys.size, pads: padKeys.size, formatVersion: 1 };
}

export function validateGenericMeasurement(table, side, placement) {
  if (!['TOP', 'BOT'].includes(side)) return fail('side', '量測檔必須選擇 TOP 或 BOT');
  const h = table.head;
  const iRef = column(h, ['refdes', 'designator', 'componentid', 'component', 'comp', 'ref', 'reference', 'partname', 'location', '位號', '元件位號']);
  const iPad = column(h, ['padid', 'pad', 'padno', 'padname', 'pinid', 'pinnumber', 'pinno', '焊墊', '焊盤', '腳位']);
  const iBoard = column(h, ['board', 'boardid', 'boardno', 'boardbarcode', 'pcb', 'pcbid', 'pcbno', 'barcode', 'serial', 'panel', 'panelid', 'panelno', '板號', '板序', '拼板', '拼板號']);
  const iFigure = column(h, ['figure', 'figureid', 'subboard', 'boardindex', 'arrayindex', 'piece', '子板', '子板號']);
  const boardIsPanel = iBoard >= 0 && ['panel', 'panelid', 'panelno', '拼板', '拼板號'].includes(norm(h[iBoard]));
  const iSide = column(h, ['side', 'layer', '面別']);
  if (iRef < 0 || iPad < 0 || iBoard < 0) return fail('format', '通用量測檔需要元件位號、焊墊編號與板序欄位');
  const coords = new Set(placement.items.filter(i => i.side === side).map(i => i.ref));
  const other = new Set(placement.items.filter(i => i.side !== side).map(i => i.ref));
  const missing = new Set(), wrongSide = new Set(), boards = new Set(), pointKeys = new Set(), padKeys = new Set();
  for (let index = 0; index < table.data.length; index++) {
    const row = table.data[index]; if (row.every(c => !text(c))) continue;
    const ref = text(row[iRef]), pad = text(row[iPad]);
    const panel = text(row[iBoard]), figure = boardIsPanel && iFigure >= 0 ? text(row[iFigure]) : '';
    const board = figure ? `${panel}/${figure}` : panel;
    if (!ref || !pad || !board) return fail('incomplete_measurement', '量測資料缺少位號、焊墊編號或板序', { line: index + 2 });
    if (iSide >= 0 && sideOf(row[iSide]) !== side) return fail('side', '量測檔面別與上傳選擇不一致', { line: index + 2 });
    if (!coords.has(ref)) { missing.add(ref); if (other.has(ref)) wrongSide.add(ref); }
    const key = `${board}\0${ref}\0${pad}`;
    if (pointKeys.has(key)) return fail('duplicate_point', '量測點重複', { line: index + 2, ref, pad, board });
    pointKeys.add(key); padKeys.add(`${ref}\0${pad}`); boards.add(board);
  }
  if (!pointKeys.size) return fail('empty', '量測檔沒有可用資料');
  return { boards: boards.size, missing: [...missing].sort(), wrongSide: [...wrongSide].sort(), points: pointKeys.size, pads: padKeys.size, formatVersion: 1 };
}

export function validateMeasurement(table, side, placement) {
  const names = table.head.map(norm);
  return names.includes('componentid') && names.includes('padid') && names.some(v => /^(?:height|volume|area)(?:mm)?\d{1,2}$/.test(v))
    ? validateWideMeasurement(table, side, placement) : validateGenericMeasurement(table, side, placement);
}
