import { fail } from './errors.js';

const DA_HOST = 'https://admin.da.live';

export function createDaClient({ org, site, fetcher, getAccessToken }) {
  if (!/^[A-Za-z0-9_-]+$/.test(org) || !/^[A-Za-z0-9_-]+$/.test(site)) {
    fail('INVALID_CONFIGURATION', 'DA_ORG or DA_SITE is invalid', 503);
  }
  async function perform(method, path, jsonString = undefined) {
    // Path has already passed validateFilePath/validateFolderPath.
    const url = `${DA_HOST}/source/${org}/${site}/${path}`;
    const auth = await getAccessToken();
    const headers = { Authorization: `Bearer ${auth}` };
    const options = { method, headers, cache: 'no-store' };
    if (jsonString !== undefined) {
      const form = new FormData();
      form.append('data', new Blob([jsonString], { type: 'application/json' }), path.split('/').at(-1));
      options.body = form;
    }
    let response;
    try { response = await fetcher(url, options); } catch {
      fail('DA_UNREACHABLE', 'Unable to contact DA Source API', 502);
    }
    if (method === 'GET' && response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      fail('DA_AUTH_FAILED', `DA rejected the configured IMS identity (HTTP ${response.status})`, 502);
    }
    if (!response.ok) {
      fail('DA_REQUEST_FAILED', `DA ${method} failed (HTTP ${response.status})`, 502);
    }
    if (method === 'GET') {
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
    if (response.status === 204) return { httpStatus: 204 };
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* DA response may not contain JSON */ }
    return { httpStatus: response.status, payload };
  }
  return {
    read: (path) => perform('GET', path),
    write: (path, sheet) => perform('POST', path, JSON.stringify(sheet)),
    remove: (path) => perform('DELETE', path),
    createFolder: (path) => perform('POST', path),
  };
}
