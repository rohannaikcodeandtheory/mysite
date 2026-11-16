import { fail } from './errors.js';

const DA_HOST = 'https://admin.da.live';

export function createDaClient({ org, site, fetcher, getAccessToken }) {
  if (!/^[A-Za-z0-9_-]+$/.test(org) || !/^[A-Za-z0-9_-]+$/.test(site)) {
    fail('INVALID_CONFIGURATION', 'DA_ORG or DA_SITE is invalid', 503);
  }

  async function send(method, kind, path, body = undefined) {
    const url = `${DA_HOST}/${kind}/${org}/${site}/${path}`;
    let auth = await getAccessToken();
    async function requestWith(token) {
      return fetcher(url, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body }),
        cache: 'no-store',
      });
    }
    let response;
    try {
      response = await requestWith(auth);
      if (response.status === 401) {
        // Invalidating ensures the next operation refreshes its token.
        getAccessToken.invalidate?.();
        // Only repeat GET; never blindly replay a DA mutation.
        if (method === 'GET') {
          auth = await getAccessToken();
          response = await requestWith(auth);
        }
      }
    } catch (error) {
      if (error?.code) throw error;
      fail('DA_UNREACHABLE', 'Unable to contact DA API', 502);
    }
    if (method === 'GET' && response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      fail('DA_AUTH_FAILED', `DA rejected the configured IMS identity (HTTP ${response.status})`, 502);
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 409) fail('DA_CONFLICT', 'DA reported a conflict', 409);
      fail('DA_REQUEST_FAILED', `DA ${method} failed (HTTP ${status})`, 502);
    }
    return response;
  }

  async function read(path) {
    const response = await send('GET', 'source', path);
    if (response === null) return null;
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 1024 * 1024) {
      fail('DA_RESPONSE_TOO_LARGE', 'DA returned a file larger than 1 MiB', 502);
    }
    try {
      const sheet = JSON.parse(text);
      if (sheet?.[':type'] !== 'sheet' || !Array.isArray(sheet?.data)) {
        fail('NOT_A_SHEET', 'Existing DA JSON is not an EDS sheet', 409);
      }
      return sheet;
    } catch (error) {
      if (error?.code === 'NOT_A_SHEET') throw error;
      fail('DA_INVALID_JSON', 'Existing DA file is not valid JSON', 502);
    }
  }

  async function responseDetails(response) {
    if (response.status === 204) return { httpStatus: 204 };
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* DA might return plain text */ }
    return { httpStatus: response.status, payload };
  }

  async function write(path, sheet) {
    const form = new FormData();
    form.append('data', new Blob([JSON.stringify(sheet)], { type: 'application/json' }), path.split('/').at(-1));
    return responseDetails(await send('POST', 'source', path, form));
  }

  async function move(path, destinationPath) {
    // DA Move API expects a repository-relative destination with leading /.
    const form = new FormData();
    form.append('destination', `/${destinationPath}`);
    return responseDetails(await send('POST', 'move', path, form));
  }

  return {
    read,
    write,
    move,
    remove: async (path) => responseDetails(await send('DELETE', 'source', path)),
    createFolder: async (path) => responseDetails(await send('POST', 'source', path)),
  };
}
