import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.js';
import { assetPath } from '../src/event.js';

function asset(id = 'I-NA-BCKM-4109045', brand = 'Rancho', language = 'de_DE', action = 'create') {
  return {
    assetID: id, action, netChange: false,
    createdDate: '2026-11-13T05:30:00.000Z', lastModificationDate: '2026-11-13T05:30:00.000Z',
    partNumbers: [
      { operation: 'A', partNumber: '410899', squashedPartNumber: '410899' },
      { operation: 'B', partNumber: '410899', squashedPartNumber: '410899' },
      { operation: 'C', partNumber: '410899', squashedPartNumber: '410899' },
    ],
    metadata: {
      resourceRegion: 'NA', brandName: brand, language,
      mediaGroupCode: 'Spec Diagrams', mediaCode: 'P04',
      title: 'Installation diagram', fileName: 'I-NA-BCKM-410899',
      partNumber: '410899', squashPartNumber: '410899', sortOrder: '1',
      orientationView: 'Front', orientationViewCode: 'FRO',
      piesAssetType: 'Photo', piesAssetTypeCode: 'P04',
      videoUrls: '', partDetailImageUrl: 'https://s3.example.com/detail/410899.jpg',
      partListingImageUrl: 'https://s3.example.com/listing/410899.jpg',
    },
  };
}

function mock() {
  const storage = new Map();
  const folders = new Set();
  const requests = [];
  const fetcher = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/ims/token/v3')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const path = url.split('/source/rohannaikcodeandtheory/mysite/')[1];
    if (options.method === 'GET') return storage.has(path)
      ? Response.json(storage.get(path)) : new Response(null, { status: 404 });
    if (options.method === 'POST' || options.method === 'PUT') {
      if (options.body === undefined) {
        if (folders.has(path)) return new Response(null, { status: 409 });
        folders.add(path);
        return Response.json({ folder: path }, { status: 201 });
      }
      assert.ok(options.body instanceof FormData);
      const file = options.body.get('data');
      storage.set(path, JSON.parse(await file.text()));
      return Response.json({ written: path }, { status: options.method === 'PUT' ? 200 : 201 });
    }
    return new Response(null, { status: 500 });
  };
  const handle = createHandler({
    getSecret: async key => ({ INBOUND_API_KEY: 'x'.repeat(40), IMS_CLIENT_ID: 'client', IMS_CLIENT_SECRET: 'secret' })[key],
    fetcher,
    settings: { org: 'rohannaikcodeandtheory', site: 'mysite', scopes: 'openid,AdobeID', allowedHost: 'stage.example.com' },
  });
  const invoke = async data => {
    const response = await handle(new Request('https://stage.example.com/api/eds-sheets', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'x'.repeat(40) },
      body: JSON.stringify(data),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { storage, folders, requests, invoke };
}

test('derived path uses language folder and brand as filename; rejects path traversal', () => {
  assert.equal(assetPath({ language: 'de_DE', brandName: 'Rancho' }), 'data/de_DE/Rancho.json');
  for (const brandName of ['../secret', 'X/Y', '%2e%2e', '.', '', 'A B']) {
    assert.throws(() => assetPath({ language: 'de_DE', brandName }));
  }
});

test('raw create writes all fields in sheet; auto-creates folders; accepts existing folders', async () => {
  const f = mock();
  const a = asset();
  let r = await f.invoke(a);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.body.path, 'data/de_DE/Rancho.json');
  assert.deepEqual([...f.folders], ['data', 'data/de_DE']);
  const sheet = f.storage.get('data/de_DE/Rancho.json');
  assert.equal(sheet.total, 1);
  assert.equal(sheet.data[0].assetID, a.assetID);
  assert.equal(sheet.data[0]['metadata.brandName'], 'Rancho');
  assert.equal(sheet.data[0]['metadata.language'], 'de_DE');
  assert.equal(sheet.data[0]['metadata.partListingImageUrl'], a.metadata.partListingImageUrl);
  assert.equal(sheet.data[0].netChange, false);
  assert.equal(sheet.data[0].action, undefined);
  assert.equal(sheet.data[0].createdDate, a.createdDate);
  assert.equal(JSON.parse(sheet.data[0].partNumbers).length, 3);
  r = await f.invoke(asset('I-NA-BCKM-4109046'));
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'create');
  assert.equal(r.body.result, 'appended');
  assert.equal(r.body.appended, true);
  assert.equal(r.body.previousTotal, 1);
  assert.equal(f.storage.get('data/de_DE/Rancho.json').total, 2);
  r = await f.invoke(asset('I-NA-BCKM-4109047'));
  assert.equal(r.status, 200);
  assert.equal(f.storage.get('data/de_DE/Rancho.json').total, 3);
});

test('same create event is idempotent; different content conflicts', async () => {
  const f = mock();
  const a = asset();
  assert.equal((await f.invoke(a)).status, 200);
  let r = await f.invoke(a);
  assert.equal(r.status, 200);
  assert.equal(r.body.unchanged, true);
  r = await f.invoke({ ...a, netChange: true });
  assert.equal(r.status, 409);
  assert.equal(f.storage.get('data/de_DE/Rancho.json').data[0].netChange, false);
});

test('raw update replaces one asset without affecting the other', async () => {
  const f = mock();
  await f.invoke(asset());
  await f.invoke(asset('OTHER'));
  const modified = { ...asset('OTHER', 'Rancho', 'de_DE', 'updated'), netChange: true, metadata: { ...asset().metadata, title: 'New title' } };
  const r = await f.invoke(modified);
  assert.equal(r.status, 200);
  const rows = f.storage.get('data/de_DE/Rancho.json').data;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].netChange, false);
  assert.equal(rows[1].netChange, true);
  assert.equal(rows[1]['metadata.title'], 'New title');
});

test('raw deleted removes only requested asset and is idempotent', async () => {
  const f = mock();
  await f.invoke(asset());
  await f.invoke(asset('OTHER'));
  let r = await f.invoke({ assetID: 'OTHER', action: 'deleted', metadata: { language: 'de_DE', brandName: 'Rancho' } });
  assert.equal(r.status, 200);
  assert.equal(f.storage.get('data/de_DE/Rancho.json').total, 1);
  r = await f.invoke({ assetID: 'OTHER', action: 'deleted', metadata: { language: 'de_DE', brandName: 'Rancho' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.unchanged, true);
});

test('raw moved relocates one asset to language/brand sheet, preserving old columns', async () => {
  const f = mock();
  await f.invoke(asset());
  await f.invoke(asset('OTHER'));
  const r = await f.invoke({ assetID: 'OTHER', action: 'moved',
    metadata: { brandName: 'Monroe', language: 'en_US' },
    previousLocation: { brandName: 'Rancho', language: 'de_DE' },
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  const source = f.storage.get('data/de_DE/Rancho.json');
  const dest = f.storage.get('data/en_US/Monroe.json');
  assert.equal(source.total, 1);
  assert.equal(dest.total, 1);
  assert.equal(dest.data[0].assetID, 'OTHER');
  assert.equal(dest.data[0]['metadata.brandName'], 'Monroe');
  assert.equal(dest.data[0]['metadata.language'], 'en_US');
  assert.equal(dest.data[0]['metadata.title'], 'Installation diagram');
  assert.equal(dest.data[0].previousLocation, undefined);
});

test('moved requires previous location; dryRun performs no DA or IMS call', async () => {
  const f = mock();
  let r = await f.invoke({ assetID: 'OTHER', action: 'moved', metadata: { language: 'de_DE', brandName: 'Rancho' } });
  assert.equal(r.status, 400);
  r = await f.invoke({ ...asset(), dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(f.requests.length, 0);
});

test('simultaneous create events to same brand serialize in one warm instance', async () => {
  const f = mock();
  const r = await Promise.all(Array.from({ length: 8 }, (_, i) => f.invoke(asset(`ID-${i}`))));
  assert.ok(r.every(x => x.status === 200));
  assert.equal(f.storage.get('data/de_DE/Rancho.json').total, 8);
});

test('legacy operation remains supported after adding action event mode', async () => {
  const f = mock();
  const r = await f.invoke({ operation: 'createSheet', path: 'data/legacy.json', sheetData: [{ assetID: 'LEGACY' }] });
  assert.equal(r.status, 200);
  assert.equal(f.storage.get('data/legacy.json').total, 1);
});


test('create appends when folder and sheet already exist before service receives the event', async () => {
  const f = mock();
  const path = 'data/de_DE/Rancho.json';
  f.folders.add('data');
  f.folders.add('data/de_DE');
  const original = {
    ':type': 'sheet', total: 2, data: [
      { assetID: 'PREEXISTING-1', 'metadata.brandName': 'Rancho', 'metadata.language': 'de_DE', 'metadata.title': 'First' },
      { assetID: 'PREEXISTING-2', 'metadata.brandName': 'Rancho', 'metadata.language': 'de_DE', 'metadata.title': 'Second' },
    ],
  };
  f.storage.set(path, structuredClone(original));
  const response = await f.invoke(asset('NEW-ASSET-3', 'Rancho', 'de_DE', 'create'));
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body.result, 'appended');
  assert.equal(response.body.previousTotal, 2);
  assert.equal(response.body.total, 3);
  const updated = f.storage.get(path);
  assert.equal(updated[':type'], 'sheet');
  assert.equal(updated.total, 3);
  assert.deepEqual(updated.data.map(r => r.assetID), ['PREEXISTING-1', 'PREEXISTING-2', 'NEW-ASSET-3']);
  assert.equal(updated.data[0]['metadata.title'], 'First');
  assert.equal(updated.data[1]['metadata.title'], 'Second');
  assert.equal(JSON.parse(updated.data[2].partNumbers).length, 3);
  const write = f.requests.filter(r => r.url.endsWith('/' + path) && r.options.method === 'PUT');
  assert.equal(write.length, 1, 'Must update existing sheet rather than try to create it again');
});

test('created remains a backward-compatible alias for create append', async () => {
  const f = mock();
  const first = await f.invoke(asset('ONE', 'Rancho', 'de_DE', 'created'));
  const second = await f.invoke(asset('TWO', 'Rancho', 'de_DE', 'create'));
  assert.equal(first.status, 200);
  assert.equal(first.body.action, 'create');
  assert.equal(second.status, 200);
  assert.equal(second.body.result, 'appended');
  assert.deepEqual(f.storage.get('data/de_DE/Rancho.json').data.map(r => r.assetID), ['ONE', 'TWO']);
});
