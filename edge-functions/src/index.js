/// <reference types="@fastly/js-compute" />
import { ConfigStore } from 'fastly:config-store';
import { SecretStore } from 'fastly:secret-store';
import { createHandler } from './handler.js';
import { selectEnvironment } from './runtime-settings.js';

// Durable within a WARM isolate only. Never assume shared/global cache across edge POPs.
// Reusing the handler also reuses its IMS token cache across incoming requests.
const handlers = new Map();
let config;
let secrets;

async function handleRequest(request) {
  try {
    config ||= new ConfigStore('config_default');
    secrets ||= new SecretStore('secret_default');
    const stageHost = config.get('STAGE_API_HOST') || '';
    const mainHost = config.get('MAIN_API_HOST') || '';
    const env = selectEnvironment(new URL(request.url).hostname, { stageHost, mainHost });

    if (!handlers.has(env)) {
      async function getSecret(key) {
        try {
          const entry = await secrets.get(`${key}_${env}`);
          return entry ? entry.plaintext() : null;
        } catch {
          return null;
        }
      }
      const handle = createHandler({
        getSecret,
        // Adobe/Fastly permits fetching these public Adobe endpoints server-side.
        fetcher: fetch,
        settings: {
          org: config.get(`DA_ORG_${env}`) || '',
          site: config.get(`DA_SITE_${env}`) || '',
          scopes: config.get(`IMS_SCOPES_${env}`) || '',
          allowedHost: env === 'STAGE' ? stageHost : mainHost,
        },
      });
      handlers.set(env, handle);
    }
    return await handlers.get(env)(request);
  } catch (error) {
    const isHost = error?.code === 'HOST_NOT_ALLOWED';
    return new Response(JSON.stringify({
      success: false,
      error: {
        code: isHost ? 'HOST_NOT_ALLOWED' : 'EDGE_FUNCTION_UNAVAILABLE',
        message: isHost ? 'This hostname is not enabled' : 'Edge Function configuration unavailable',
      },
    }), {
      status: isHost ? 403 : 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}

addEventListener('fetch', (event) => event.respondWith(handleRequest(event.request)));
