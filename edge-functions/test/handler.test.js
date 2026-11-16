import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.js';

function fixture(initial = {}) {
  const storage = new Map(Object.entries(initial));
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/ims/token/v3')) {
      return new Response(JSON.stringify({ access_token: 'fake-ims-access-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('/move/rohannaikcodeandtheory/mysite/')) {
      if (options.headers?.Authorization !== 'Bearer fake-ims-access-token') {
        return new Response('not authorized', { status: 401 });
      }
      const source = url.split('/move/rohannaikcodeandtheory/mysite/')[1];
      const destination = options.body.get('destination').replace(/^\//, '');
      if (!storage.has(source) || storage.has(destination)) return new Response('bad move', { status: 409 });
      storage.set(destination, storage.get(source));
      storage.delete(source);
      return new Response(null, { status: 204 });
    }
    const path = url.split('/source/rohannaikcodeandtheory/mysite/')[1];
    if (options.headers?.Authorization !== 'Bearer fake-ims-access-token') {
      return new Response('not authorized', { status: 401 });
    }
    if (options.method === 'GET') {
      return storage.has(path)
        ? new Response(JSON.stringify(storage.get(path)), { status: 200 })
        : new Response('', { status: 404 });
    }
    if (options.method === 'POST' || options.method === 'PUT') {
      if (options.body instanceof FormData) {
        storage.set(path, JSON.parse(await options.body.get('data').text()));
      }
      return new Response(JSON.stringify({ source: { editUrl: 'https://da.live/edit#/mock' } }), { status: options.method === 'PUT' ? 200 : 201 });
    }
    if (options.method === 'DELETE') {
      storage.delete(path);
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 500 });
  };
  const handle = createHandler({
    getSecret: async (key) => ({ INBOUND_API_KEY: 'a'.repeat(40), IMS_CLIENT_ID: 'client', IMS_CLIENT_SECRET: 'secret' })[key],
    fetcher,
    settings: { org: 'rohannaikcodeandtheory', site: 'mysite', scopes: 'openid,AdobeID', allowedHost: 'stage.example.com' },
  });
  const invoke = async (payload, { key = 'a'.repeat(40), url = 'https://stage.example.com/api/eds-sheets' } = {}) => {
    const response = await handle(new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(payload),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { storage, calls, invoke, handle };
}

test('requires caller API key before any upstream requests', async () => {
  const f = fixture();
  const result = await f.invoke({ operation: 'getSheet', path: 'data/test.json' }, { key: 'bad' });
  assert.equal(result.status, 401);
  assert.equal(f.calls.length, 0);
});

test('validates dryRun and performs no IMS/DA requests', async () => {
  const f = fixture();
  const result = await f.invoke({
    operation: 'createSheet', path: 'data/test.json', dryRun: true,
    record: { assetID: '123', action: 'created', metadata: { source: 'API' } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, true);
  assert.deepEqual(Object.keys(result.body.sheet.data[0]), ['assetID', 'metadata.source']);
  assert.equal(f.calls.length, 0);
});

test('supports create/read/update/delete with IMS token reuse', async () => {
  const f = fixture();
  let res = await f.invoke({ operation: 'createSheet', path: 'data/test.json', sheetData: [{ id: 1 }] });
  assert.equal(res.status, 200);
  assert.equal(f.storage.get('data/test.json').total, 1);
  res = await f.invoke({ operation: 'createSheet', path: 'data/test.json', sheetData: [{ id: 2 }] });
  assert.equal(res.status, 409);
  res = await f.invoke({ operation: 'getSheet', path: 'data/test.json' });
  assert.equal(res.body.sheet.data[0].id, 1);
  res = await f.invoke({ operation: 'updateSheet', path: 'data/test.json', sheetData: [{ id: 3 }] });
  assert.equal(res.status, 200);
  assert.equal(f.storage.get('data/test.json').data[0].id, 3);
  res = await f.invoke({ operation: 'deleteSheet', path: 'data/test.json' });
  assert.equal(res.status, 400);
  res = await f.invoke({ operation: 'deleteSheet', path: 'data/test.json', confirm: true });
  assert.equal(res.status, 200);
  assert.equal(f.storage.has('data/test.json'), false);
  assert.equal(f.calls.filter((call) => call.url.includes('/ims/token/v3')).length, 1);
});

test('moves sheet without changing rows', async () => {
  const initial = { ':type': 'sheet', total: 1, data: [{ id: 1, nested: '[1,2]' }] };
  const f = fixture({ 'data/source.json': initial });
  const res = await f.invoke({ operation: 'moveSheet', path: 'data/source.json', destinationPath: 'data/dest.json', confirm: true });
  assert.equal(res.status, 200);
  assert.equal(f.storage.has('data/source.json'), false);
  assert.deepEqual(f.storage.get('data/dest.json'), initial);
  assert.equal(f.calls.filter(c => c.url.includes('/move/')).length, 1);
});

test('rejects wrong hostname and invalid file paths', async () => {
  const f = fixture();
  const badHost = await f.invoke({ operation: 'getSheet', path: 'data/x.json' }, { url: 'https://evil.example.com/api/eds-sheets' });
  assert.equal(badHost.status, 403);
  const badPath = await f.invoke({ operation: 'deleteSheet', path: 'data/../secrets.json', confirm: true });
  assert.equal(badPath.status, 400);
  assert.equal(f.calls.length, 0);
});

test('disallows updates for nonexistent sheets', async () => {
  const f = fixture();
  const res = await f.invoke({ operation: 'updateSheet', path: 'data/x.json', record: { id: 1 } });
  assert.equal(res.status, 404);
  assert.equal(f.storage.size, 0);
});
