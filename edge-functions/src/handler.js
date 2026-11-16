import { AppError, fail, jsonResponse, toSafeError } from './errors.js';
import {
  MAX_REQUEST_BYTES, validateFilePath, validateFolderPath, getSheetInput,
} from './sheet.js';
import { createTokenProvider } from './ims.js';
import { createDaClient } from './da.js';
import { applyAssetEvent, validateAssetEvent } from './event.js';

const API_PATH = '/api/eds-sheets';
const OPERATIONS = new Set([
  'createSheet', 'getSheet', 'updateSheet', 'deleteSheet', 'moveSheet', 'createFolder',
]);

function keysEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Compare full strings without returning early on the first differing character.
  const size = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < size; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function checkHost(url, expectedHost) {
  const hostname = url.hostname.toLowerCase();
  const local = (hostname === 'localhost' || hostname === '127.0.0.1');
  if (local) return;
  if (!expectedHost || hostname !== expectedHost.toLowerCase()) {
    fail('HOST_NOT_ALLOWED', 'This endpoint is not enabled on this hostname', 403);
  }
}

async function readLimitedBody(req, maxBytes) {
  // Stream instead of buffering an unbounded user-controlled request body.
  const reader = req.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KiB', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const bytes of chunks) { buffer.set(bytes, offset); offset += bytes.byteLength; }
  return new TextDecoder().decode(buffer);
}

async function parseRequest(req) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    fail('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  }
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    fail('PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KiB', 413);
  }
  const raw = await readLimitedBody(req, MAX_REQUEST_BYTES);
  let payload;
  try { payload = JSON.parse(raw); } catch { fail('INVALID_JSON', 'Request body must be valid JSON'); }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    fail('INVALID_JSON', 'Request body must be a JSON object');
  }
  if (!OPERATIONS.has(payload.operation)) {
    if (typeof payload.action === 'string') {
      validateAssetEvent(payload);
      return payload;
    }
    fail('INVALID_OPERATION', 'Use action: create, updated, deleted, moved; or a legacy operation');
  }
  if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') {
    fail('INVALID_DRY_RUN', 'dryRun must be true or false');
  }
  return payload;
}

async function execute(payload, da) {
  const { operation, dryRun = false } = payload;
  const path = operation === 'createFolder'
    ? validateFolderPath(payload.path)
    : validateFilePath(payload.path);
  const destinationPath = operation === 'moveSheet'
    ? validateFilePath(payload.destinationPath)
    : undefined;
  if (operation === 'moveSheet' && destinationPath === path) {
    fail('INVALID_MOVE', 'destinationPath must differ from path');
  }
  if ((operation === 'deleteSheet' || operation === 'moveSheet') && payload.confirm !== true && !dryRun) {
    fail('CONFIRM_REQUIRED', 'Set confirm: true for destructive operations');
  }
  let sheet;
  if (operation === 'createSheet' || operation === 'updateSheet') {
    sheet = getSheetInput(payload);
  }

  if (dryRun) {
    return { success: true, dryRun: true, operation, path,
      ...(destinationPath ? { destinationPath } : {}),
      ...(sheet ? { sheet } : {}),
      message: 'Validated only; no DA request was made' };
  }

  switch (operation) {
    case 'getSheet': {
      const existing = await da.read(path);
      if (!existing) fail('NOT_FOUND', 'Sheet does not exist', 404);
      return { success: true, operation, path, sheet: existing };
    }
    case 'createSheet': {
      if (await da.read(path)) fail('ALREADY_EXISTS', 'Sheet already exists; use updateSheet', 409);
      const result = await da.write(path, sheet);
      return { success: true, operation, path, rows: sheet.total, da: result.payload };
    }
    case 'updateSheet': {
      if (!(await da.read(path))) fail('NOT_FOUND', 'Sheet does not exist; use createSheet', 404);
      const result = await da.write(path, sheet, { existing: true });
      return { success: true, operation, path, rows: sheet.total, da: result.payload };
    }
    case 'deleteSheet': {
      await da.remove(path);
      return { success: true, operation, path, message: 'DA delete completed (idempotent)' };
    }
    case 'createFolder': {
      const result = await da.createFolder(path);
      return { success: true, operation, path, da: result.payload };
    }
    case 'moveSheet': {
      const existing = await da.read(path);
      if (!existing) fail('NOT_FOUND', 'Source sheet does not exist', 404);
      if (await da.read(destinationPath)) fail('ALREADY_EXISTS', 'Destination sheet already exists', 409);
      const result = await da.move(path, destinationPath);
      return { success: true, operation, path, destinationPath, da: result.payload,
        message: 'DA Move API completed' };
    }
    default:
      throw new AppError('INVALID_OPERATION', 'Unsupported operation');
  }
}

export function createHandler({ getSecret, fetcher, settings }) {
  const getAccessToken = createTokenProvider({ getSecret, fetcher, scopes: settings.scopes });
  // The DA client is fixed to a configured repository, never a client-provided org/site/URL.
  const da = createDaClient({ org: settings.org, site: settings.site, fetcher, getAccessToken });
  // Serialize raw webhook operations within one warm instance. This does NOT
  // prevent simultaneous updates from different edge instances/POPs.
  let localQueue = Promise.resolve();
  function queuedAssetEvent(payload) {
    const job = localQueue.then(() => applyAssetEvent(payload, da));
    localQueue = job.catch(() => {});
    return job;
  }
  return async function handle(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname === `${API_PATH}/health` && req.method === 'GET') {
        checkHost(url, settings.allowedHost);
        return jsonResponse({ status: 'ok', service: 'eds-sheet-service' });
      }
      if (url.pathname !== API_PATH) fail('NOT_FOUND', 'Route not found', 404);
      checkHost(url, settings.allowedHost);
      if (req.method !== 'POST') fail('METHOD_NOT_ALLOWED', 'Use POST', 405);
      const configuredKey = await getSecret('INBOUND_API_KEY');
      if (!configuredKey || configuredKey.length < 32) {
        fail('INBOUND_AUTH_NOT_CONFIGURED', 'Inbound API credential is missing or too short', 503);
      }
      if (!keysEqual(req.headers.get('x-api-key'), configuredKey)) {
        fail('UNAUTHORIZED', 'Invalid API key', 401);
      }
      const payload = await parseRequest(req);
      const result = payload.action && !payload.operation
        ? await queuedAssetEvent(payload)
        : await execute(payload, da);
      return jsonResponse(result, 200);
    } catch (error) {
      const safe = toSafeError(error);
      return jsonResponse(safe.body, safe.status);
    }
  };
}
