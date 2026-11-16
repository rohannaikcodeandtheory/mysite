import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSheet, validateFilePath, validateFolderPath } from '../src/sheet.js';

test('flattens metadata; preserves arrays as JSON strings; drops top-level action', () => {
  const sheet = makeSheet({
    assetID: 'I-NA-BCKM-410904', action: 'created', netChange: false,
    partNumbers: [{ operation: 'A', partNumber: '410899' }],
    metadata: { resourceRegion: 'NA', details: { status: 'active' } },
  });
  assert.equal(sheet[':type'], 'sheet');
  assert.equal(sheet.total, 1);
  assert.equal(sheet.data[0].action, undefined);
  assert.equal(sheet.data[0]['metadata.resourceRegion'], 'NA');
  assert.equal(sheet.data[0]['metadata.details.status'], 'active');
  assert.equal(sheet.data[0].netChange, false);
  assert.deepEqual(JSON.parse(sheet.data[0].partNumbers), [{ operation: 'A', partNumber: '410899' }]);
});

test('collects all columns across rows, including null, zero and false', () => {
  const sheet = makeSheet([{ id: 1, test: false }, { id: 2, another: null, count: 0 }]);
  assert.deepEqual(Object.keys(sheet.data[0]), ['id', 'test', 'another', 'count']);
  assert.equal(sheet.data[0].another, '');
  assert.equal(sheet.data[1].another, null);
  assert.equal(sheet.data[1].count, 0);
});

test('accepts DA sheet shape but regenerates total', () => {
  assert.equal(makeSheet({ ':type': 'sheet', data: [{ id: 1 }], total: 100 }).total, 1);
});

test('path traversal and non-json paths are rejected', () => {
  for (const bad of ['../../secret.json', 'data/../secret.json', 'data/.env.json', 'data/a%2Fb.json',
    'https://evil.com/x.json', 'data/secret.html', 'data/a?x=.json', 'other/products.json']) {
    assert.throws(() => validateFilePath(bad));
  }
  assert.equal(validateFilePath('data/catalog/products.json'), 'data/catalog/products.json');
  assert.equal(validateFolderPath('data/catalog'), 'data/catalog');
  assert.throws(() => validateFolderPath('outside'));
});

test('prevents flatten column collision', () => {
  assert.throws(() => makeSheet([{ 'a.b': 1, a: { b: 2 } }]), /duplicate/i);
});
