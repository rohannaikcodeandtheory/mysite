/**
 * Raw asset webhooks -> per-language / per-brand DA sheets.
 * Route is fixed under data/, and never chosen by an inbound URL.
 * This is a read/modify/write protocol; serialization in the handler only
 * protects one warm runtime, not simultaneous writes from different POPs.
 */
import { fail } from './errors.js';
import { makeSheet, validateFilePath } from './sheet.js';

const ACTIONS = new Set(['create', 'created', 'updated', 'deleted', 'moved']);
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function segment(value, name) {
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    fail('INVALID_ASSET_ROUTE', `${name} must contain only letters, digits, underscores, or hyphens (maximum 80 characters)`);
  }
  return value;
}

export function assetPath(location) {
  if (!object(location)) fail('MISSING_METADATA', 'metadata.language and metadata.brandName are required');
  const language = segment(location.language, 'metadata.language');
  const brandName = segment(location.brandName, 'metadata.brandName');
  return validateFilePath(`data/${language}/${brandName}.json`);
}

function checkAssetID(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail('INVALID_ASSET_ID', 'assetID is required (up to 128 safe characters)');
  }
  return value;
}

export function validateAssetEvent(payload) {
  if (!object(payload) || !ACTIONS.has(payload.action)) {
    fail('INVALID_ACTION', 'action must be create, updated, deleted, or moved (created remains a compatibility alias)');
  }
  checkAssetID(payload.assetID);
  const path = assetPath(payload.metadata);
  if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') {
    fail('INVALID_DRY_RUN', 'dryRun must be a boolean');
  }
  let sourcePath;
  if (payload.action === 'moved') {
    if (!object(payload.previousLocation)) {
      fail('MISSING_PREVIOUS_LOCATION', 'moved requires previousLocation.language and previousLocation.brandName');
    }
    sourcePath = assetPath(payload.previousLocation);
  }
  const { action, previousLocation, dryRun, ...data } = payload;
  // Existing integrations may still send 'created'. Treat it as the same
  // append operation, but use 'create' in the public API going forward.
  const normalizedAction = action === 'created' ? 'create' : action;
  const row = makeSheet(data).data[0];
  return { action: normalizedAction, assetID: payload.assetID, path, sourcePath, row, dryRun: dryRun === true };
}

function rowsOf(sheet) {
  return sheet?.data || [];
}

function assetIndex(rows, assetID) {
  const hits = rows.flatMap((r, i) => r.assetID === assetID ? [i] : []);
  if (hits.length > 1) fail('DUPLICATE_ASSET_ID', 'The sheet contains multiple records with the same assetID', 409);
  return hits[0] ?? -1;
}

/**
 * DA has no row-level append operation: persist a complete sheet by POSTing
 * the existing rows plus the incoming row. Only create folders for a NEW file;
 * for an EXISTING brand sheet, do not attempt to recreate its folders.
 * Note: this remains read-modify-write, not an atomic cross-instance append.
 */
async function saveBrandSheet(da, path, rows, { fileExists = false } = {}) {
  if (!fileExists) {
    await da.createFolder('data');
    await da.createFolder(path.slice(0, path.lastIndexOf('/')));
  }
  const sheet = makeSheet(rows); // Re-normalizes all column names across ALL records.
  await da.write(path, sheet, { existing: fileExists });
  return sheet.total;
}

export async function applyAssetEvent(payload, da) {
  const event = validateAssetEvent(payload);
  const { action, path, sourcePath, row, assetID, dryRun } = event;
  if (dryRun) {
    return { success: true, dryRun: true, action, assetID, path,
      ...(sourcePath ? { sourcePath } : {}),
      message: 'Validated only; DA was not called' };
  }

  if (action === 'create') {
    // GET the actual DA sheet BEFORE writing anything. A missing file is a
    // sheet-creation request; a present file is an asset-row append request.
    const previous = await da.read(path);
    const rows = rowsOf(previous);
    const found = assetIndex(rows, assetID);
    if (found !== -1) {
      const proposed = makeSheet([...rows.slice(0, found), row, ...rows.slice(found + 1)]).data[found];
      const current = makeSheet(rows).data[found];
      const same = JSON.stringify(proposed) === JSON.stringify(current);
      if (same) return {
        success: true, action, assetID, path, result: 'unchanged',
        unchanged: true, appended: false, total: rows.length,
      };
      fail('ASSET_ALREADY_EXISTS', 'assetID already exists in the brand sheet; use action updated', 409);
    }

    // Preserve EVERY existing row in the same language/brand sheet.
    const total = await saveBrandSheet(da, path, [...rows, row], {
      fileExists: previous !== null,
    });
    return {
      success: true, action, assetID, path,
      result: previous === null ? 'created_sheet' : 'appended',
      appended: previous !== null,
      previousTotal: rows.length,
      total,
    };
  }

  if (action === 'updated') {
    const previous = await da.read(path);
    if (!previous) fail('ASSET_NOT_FOUND', 'The destination brand sheet does not exist', 404);
    const rows = rowsOf(previous);
    const found = assetIndex(rows, assetID);
    if (found === -1) fail('ASSET_NOT_FOUND', 'assetID does not exist in the brand sheet', 404);
    const next = [...rows];
    next[found] = row;
    await da.write(path, makeSheet(next), { existing: true });
    return { success: true, action, assetID, path, total: next.length };
  }

  if (action === 'deleted') {
    const previous = await da.read(path);
    if (!previous) return { success: true, action, assetID, path, unchanged: true, total: 0 };
    const rows = rowsOf(previous);
    const found = assetIndex(rows, assetID);
    if (found === -1) return { success: true, action, assetID, path, unchanged: true, total: rows.length };
    const next = rows.filter((_, i) => i !== found);
    // Keep the sheet even if it has zero rows, so unrelated brand data is never deleted.
    await da.write(path, makeSheet(next), { existing: true });
    return { success: true, action, assetID, path, total: next.length };
  }

  // `moved` moves ONE asset row, not the entire source brand sheet.
  const source = await da.read(sourcePath);
  if (!source) fail('ASSET_NOT_FOUND', 'Previous brand sheet was not found', 404);
  const sourceRows = rowsOf(source);
  const found = assetIndex(sourceRows, assetID);
  if (found === -1) fail('ASSET_NOT_FOUND', 'assetID does not exist in previous brand sheet', 404);
  // Preserve existing columns if a move webhook only carries location metadata.
  const merged = { ...sourceRows[found], ...row };
  if (path === sourcePath) {
    const next = [...sourceRows];
    next[found] = merged;
    await da.write(path, makeSheet(next), { existing: true });
    return { success: true, action, assetID, path, sourcePath, total: next.length };
  }
  const destination = await da.read(path);
  const destRows = rowsOf(destination);
  if (assetIndex(destRows, assetID) !== -1) {
    fail('ASSET_ALREADY_EXISTS', 'assetID already exists in the destination brand sheet', 409);
  }
  await saveBrandSheet(da, path, [...destRows, merged], { fileExists: destination !== null });
  // A failed source write leaves a copy in both sheets. Explicitly report partial state.
  try {
    await da.write(sourcePath, makeSheet(sourceRows.filter((_, i) => i !== found)), { existing: true });
  } catch {
    fail('PARTIAL_MOVE', 'Destination was written, but the source could not be updated; reconcile both sheets before retrying', 502,
      { sourcePath, destinationPath: path, assetID });
  }
  return { success: true, action, assetID, sourcePath, path, sourceTotal: sourceRows.length - 1, total: destRows.length + 1 };
}
