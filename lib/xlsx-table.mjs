// Parse the spreadsheet values from an XLSX on the server. The uploaded bytes,
// rather than a browser-supplied CSV conversion, are the verification source.
import { inflateRawSync } from 'node:zlib';
import { SaxesParser } from 'saxes';

const ENTRY_LIMIT = 150 * 1048576;
const TOTAL_LIMIT = 300 * 1048576;
const decoder = new TextDecoder('utf-8', { fatal: true });
const local = name => name.slice(name.lastIndexOf(':') + 1);
const attr = (tag, key) => tag.attributes[key] ?? '';

function xml(source, handlers) {
  const parser = new SaxesParser({ xmlns: false, position: false });
  parser.on('doctype', () => { throw new Error('Excel XML 不可包含 DTD'); });
  parser.on('opentag', tag => handlers.open?.(tag));
  parser.on('text', value => handlers.text?.(value));
  parser.on('cdata', value => handlers.text?.(value));
  parser.on('closetag', tag => handlers.close?.(tag));
  parser.write(source).close();
}

function zipEntries(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const d = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let end = -1;
  for (let i = u.length - 22; i >= Math.max(0, u.length - 65558); i--) {
    if (d.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('不是有效的 .xlsx 檔（缺少 ZIP 目錄）');
  if (d.getUint16(end + 4, true) || d.getUint16(end + 6, true) ||
      d.getUint16(end + 8, true) !== d.getUint16(end + 10, true))
    throw new Error('不支援多磁碟 ZIP');
  const count = d.getUint16(end + 10, true), entries = new Map();
  let offset = d.getUint32(end + 16, true), total = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || d.getUint32(offset, true) !== 0x02014b50)
      throw new Error('.xlsx 壓縮目錄損毀');
    const flags = d.getUint16(offset + 8, true), method = d.getUint16(offset + 10, true);
    const compressed = d.getUint32(offset + 20, true), expanded = d.getUint32(offset + 24, true);
    const nameLength = d.getUint16(offset + 28, true), extra = d.getUint16(offset + 30, true);
    const comment = d.getUint16(offset + 32, true), origin = d.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extra + comment;
    if (next > end || flags & 1 || expanded > ENTRY_LIMIT || total + expanded > TOTAL_LIMIT)
      throw new Error('Excel 檔加密、目錄損毀或解壓後過大');
    const name = decoder.decode(u.subarray(offset + 46, offset + 46 + nameLength));
    if (name.includes('\\') || name.includes('..') || name.startsWith('/')) throw new Error('Excel ZIP 路徑不安全');
    if (origin + 30 > u.length || d.getUint32(origin, true) !== 0x04034b50)
      throw new Error('.xlsx 檔案項目損毀');
    const start = origin + 30 + d.getUint16(origin + 26, true) + d.getUint16(origin + 28, true);
    if (start + compressed > u.length) throw new Error('.xlsx 檔案項目超出邊界');
    total += expanded;
    entries.set(name, { method, compressed, expanded, start });
    offset = next;
  }
  return name => {
    const item = entries.get(name);
    if (!item) return null;
    const compressed = u.subarray(item.start, item.start + item.compressed);
    let value;
    if (item.method === 0) value = compressed;
    else if (item.method === 8) value = inflateRawSync(compressed, { maxOutputLength: ENTRY_LIMIT });
    else throw new Error('不支援的 .xlsx 壓縮方式');
    if (value.length !== item.expanded) throw new Error('.xlsx 解壓大小與目錄不符');
    return decoder.decode(value);
  };
}

function indexOfCell(reference) {
  let number = 0;
  for (const ch of reference.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') break;
    number = number * 26 + ch.charCodeAt(0) - 64;
  }
  return number - 1;
}

function workbookSheets(source) {
  const sheets = [];
  xml(source, { open(tag) {
    if (local(tag.name) === 'sheet') sheets.push({ name: attr(tag, 'name'), id: attr(tag, 'r:id') });
  } });
  return sheets;
}

function relationships(source) {
  const result = new Map();
  xml(source, { open(tag) {
    if (local(tag.name) !== 'Relationship') return;
    const target = attr(tag, 'Target');
    if (!target || attr(tag, 'TargetMode') === 'External') return;
    const name = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    if (!name.includes('..')) result.set(attr(tag, 'Id'), name);
  } });
  return result;
}

function sharedStrings(source) {
  if (!source) return [];
  const strings = []; let inItem = false, inText = false, value = '';
  xml(source, {
    open(tag) { const name = local(tag.name); if (name === 'si') { inItem = true; value = ''; }
      else if (name === 't' && inItem) inText = true; },
    text(chunk) { if (inText) value += chunk; },
    close(tag) { const name = local(tag.name); if (name === 't') inText = false;
      else if (name === 'si') { strings.push(value); inItem = false; } },
  });
  return strings;
}

function excelDate(value) {
  const date = new Date(Math.round((value - 25569) * 86400000));
  if (!Number.isFinite(date.getTime())) return String(value);
  const iso = date.toISOString().replace('T', ' ');
  return value % 1 ? iso.slice(0, 19) : iso.slice(0, 10);
}

function numberFormats(source) {
  const custom = new Map(), date = [], percent = [];
  if (!source) return { date, percent };
  let inCellXfs = false;
  xml(source, { open(tag) {
    const name = local(tag.name);
    if (name === 'numFmt') custom.set(Number(attr(tag, 'numFmtId')), attr(tag, 'formatCode'));
    if (name === 'cellXfs') inCellXfs = true;
    if (name === 'xf' && inCellXfs) {
      const id = Number(attr(tag, 'numFmtId')) || 0;
      const format = (custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      date.push((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[ymdhs]/i.test(format));
      percent.push(id === 9 || id === 10 || /%/.test(format));
    }
  }, close(tag) { if (local(tag.name) === 'cellXfs') inCellXfs = false; } });
  return { date, percent };
}

function sheetRows(source, strings, formats) {
  const rows = []; let row = null, cell = null, inValue = false, inInline = false;
  xml(source, {
    open(tag) {
      const name = local(tag.name);
      if (name === 'row') row = [];
      else if (name === 'c' && row) cell = { index: indexOfCell(attr(tag, 'r')), type: attr(tag, 't'), style: Number(attr(tag, 's')) || 0, value: '' };
      else if (cell && name === 'v') inValue = true;
      else if (cell && name === 't' && cell.type === 'inlineStr') inInline = true;
    },
    text(chunk) { if (cell && (inValue || inInline)) cell.value += chunk; },
    close(tag) {
      const name = local(tag.name);
      if (name === 'v') inValue = false;
      else if (name === 't') inInline = false;
      else if (name === 'c' && cell) {
        let value = cell.value;
        if (cell.type === 's') value = strings[Number(value)] ?? '';
        else if (cell.type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
        else if (value && cell.type !== 'str' && cell.type !== 'e' && Number.isFinite(Number(value))) {
          if (formats.date[cell.style]) value = excelDate(Number(value));
          else if (formats.percent[cell.style]) value = String(+(Number(value) * 100).toFixed(6));
        }
        if (cell.index < 0 || cell.index > 16383 || row[cell.index] != null) throw new Error('Excel 儲存格位置不正確或重複');
        row[cell.index] = String(value).replace(/[\r\n\t]+/g, ' ').trim(); cell = null;
      } else if (name === 'row' && row) {
        if (row.some(value => value != null && value !== '')) rows.push(Array.from(row, value => value ?? ''));
        row = null;
      }
    },
  });
  return rows;
}

function headerScore(head) {
  const names = head.map(value => value.toLowerCase().replace(/[\s_.%()/-]/g, ''));
  return [
    ['board', 'boardid', 'panelid'], ['padid', 'pad', 'pinid'], ['componentid', 'refdes', 'designator'],
    ['volume', 'volume1'], ['height', 'height1'], ['area', 'area1'], ['x', 'centerx'], ['y', 'centery'],
  ].filter(group => group.some(name => names.includes(name))).length;
}

export function parseXlsx(bytes) {
  const get = zipEntries(bytes), workbook = get('xl/workbook.xml');
  if (!workbook) throw new Error('不是有效的 Excel 檔（缺少活頁簿）');
  const sheets = workbookSheets(workbook);
  const relations = relationships(get('xl/_rels/workbook.xml.rels') || '<Relationships/>');
  const strings = sharedStrings(get('xl/sharedStrings.xml'));
  const formats = numberFormats(get('xl/styles.xml'));
  let chosen = null;
  for (const sheet of sheets) {
    const path = relations.get(sheet.id), source = path && get(path);
    if (!source) continue;
    const rows = sheetRows(source, strings, formats);
    if (rows.length < 2) continue;
    const score = headerScore(rows[0]);
    if (!chosen || score > chosen.score) chosen = { rows, score, name: sheet.name };
  }
  if (!chosen) throw new Error('Excel 檔中找不到含標題及資料的工作表');
  const width = chosen.rows[0].length;
  return { head: chosen.rows[0], data: chosen.rows.slice(1).map(row => Array.from({ length: width }, (_, i) => row[i] ?? '')) };
}
