import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEnvironment } from '../src/runtime-settings.js';
import { createTokenProvider } from '../src/ims.js';

test('isolation: exact stage and prod domains; reject unrelated hostname', () => {
  const hosts = { stageHost: 'stage.example.com', mainHost: 'production.example.com' };
  assert.equal(selectEnvironment('stage.example.com', hosts), 'STAGE');
  assert.equal(selectEnvironment('production.example.com', hosts), 'MAIN');
  assert.equal(selectEnvironment('127.0.0.1', hosts), 'STAGE');
  assert.throws(() => selectEnvironment('evil.example.com', hosts), /enabled/);
});

test('IMS invalid_scope produces safe code but never returns raw description or credential', async () => {
  const provider = createTokenProvider({
    getSecret: async (name) => name === 'IMS_CLIENT_ID' ? 'example-client' : 'example-secret',
    scopes: 'example-scope',
    fetcher: async () => new Response(JSON.stringify({ error: 'invalid_scope',
      error_description: 'secret suspicious value' }), { status: 400 }),
  });
  await assert.rejects(provider(), (error) => {
    assert.equal(error.code, 'IMS_TOKEN_FAILED');
    assert.equal(error.details.adobeError, 'invalid_scope');
    assert.ok(!error.message.includes('secret suspicious'));
    return true;
  });
});
