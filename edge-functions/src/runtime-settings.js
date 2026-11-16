/**
 * Choose credentials from the exact approved public domain.
 * The caller cannot choose STAGE or MAIN in its JSON body or headers.
 */
import { fail } from './errors.js';

export function selectEnvironment(hostname, { stageHost, mainHost }) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return 'STAGE';
  if (stageHost && host === stageHost.toLowerCase()) return 'STAGE';
  if (mainHost && host === mainHost.toLowerCase()) return 'MAIN';
  fail('HOST_NOT_ALLOWED', 'This endpoint is not enabled on this hostname', 403);
}
