import { fail } from './errors.js';

export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_ROWS = 1000;
export const MAX_COLUMNS = 200;
const FILE_PATH_PATTERN = /^data\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/;
const FOLDER_PATH_PATTERN = /^data(?:\/(?:[A-Za-z0-9_-]+))*$/;

export function validateFilePath(path) {
  if (typeof path !== 'string' || path.length > 200 || !FILE_PATH_PATTERN.test(path)) {
    fail('INVALID_PATH', 'path must be a safe .json file under data/ (for example data/products.json)');
  }
  return path;
}

export function validateFolderPath(path) {
  if (typeof path !== 'string' || path.length > 200 || !FOLDER_PATH_PATTERN.test(path)) {
    fail('INVALID_FOLDER', 'Folder must be data or a subfolder such as data/catalog');
  }
  return path;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flattenRow(object) {
  const flat = Object.create(null);
  const visit = (value, prefix, depth) => {
    if (depth > 12) fail('ROW_TOO_DEEP', 'Nested object depth exceeds 12');
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'action' && prefix === '') continue; // exclude source event action
        if (!key || key.length > 100 || /[\x00-\x1f]/.test(key)) {
          fail('INVALID_COLUMN', 'A column name is invalid');
        }
        visit(child, prefix ? `${prefix}.${key}` : key, depth + 1);
      }
      return;
    }
    if (Object.hasOwn(flat, prefix)) {
      fail('DUPLICATE_COLUMN', `Flattening produced a duplicate column: ${prefix}`);
    }
    // Arrays remain losslessly represented as a JSON string in one DA sheet cell.
    // Empty objects are likewise represented as JSON strings.
    flat[prefix] = Array.isArray(value) || isPlainObject(value)
      ? JSON.stringify(value)
      : value;
  };
  visit(object, '', 0);
  return flat;
}

export function makeSheet(input) {
  let rows = input;
  // Accept either a raw record, records array, or existing DA sheet shape.
  if (isPlainObject(rows) && rows[':type'] === 'sheet') rows = rows.data;
  if (isPlainObject(rows)) rows = [rows];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
    fail('INVALID_SHEET', `sheetData must contain between 0 and ${MAX_ROWS} rows`);
  }
  const flattened = rows.map((record, idx) => {
    if (!isPlainObject(record)) fail('INVALID_ROW', `Row ${idx} must be a JSON object`);
    return flattenRow(record);
  });
  const columns = [...new Set(flattened.flatMap((row) => Object.keys(row)))];
  if (columns.length > MAX_COLUMNS) fail('TOO_MANY_COLUMNS', `Maximum ${MAX_COLUMNS} columns allowed`);
  // Fill missing columns so DA shows the union of fields across every row.
  const normalized = flattened.map((row) => {
    const result = Object.create(null);
    for (const col of columns) result[col] = Object.hasOwn(row, col) ? row[col] : '';
    return result;
  });
  const sheet = { ':type': 'sheet', total: normalized.length, data: normalized };
  if (new TextEncoder().encode(JSON.stringify(sheet)).byteLength > MAX_REQUEST_BYTES) {
    fail('SHEET_TOO_LARGE', 'Generated sheet exceeds 256 KiB', 413);
  }
  return sheet;
}

export function getSheetInput(payload) {
  // 'sheetData' is the preferred contract; 'record'/'records' support event consumers.
  const input = payload.sheetData ?? payload.records ?? payload.record;
  if (input === undefined) fail('MISSING_SHEET_DATA', 'sheetData (or record/records) is required');
  return makeSheet(input);
}
