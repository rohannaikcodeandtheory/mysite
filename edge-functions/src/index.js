
/// <reference types="@fastly/js-compute" />

import { ConfigStore } from 'fastly:config-store';
import { SecretStore } from 'fastly:secret-store';
import { createHandler } from './handler.js';

/**
 * Handles incoming requests.
 *
 * IMPORTANT:
 * ConfigStore and SecretStore must be initialized
 * inside request handling, not at module level.
 */
async function handleRequest(request) {
  try {
    // Initialize stores during request processing.
    const config = new ConfigStore('config_default');
    const secrets = new SecretStore('secret_default');

    // Cache the bundled secrets lookup for this request.
    let secretBundlePromise;

    async function getSecret(key) {
      if (!secretBundlePromise) {
        secretBundlePromise = (async () => {
          try {
            const entry = await secrets.get('secrets');

            if (!entry) return null;

            const value = JSON.parse(entry.plaintext());

            return value && typeof value === 'object'
              ? value
              : null;
          } catch {
            return null;
          }
        })();
      }

      const bundle = await secretBundlePromise;

      if (bundle && typeof bundle[key] === 'string') {
        return bundle[key];
      }

      try {
        const entry = await secrets.get(key);
        return entry ? entry.plaintext() : null;
      } catch {
        return null;
      }
    }

    // Existing business logic remains unchanged.
    const handle = createHandler({
      getSecret,
      fetcher: fetch,
      settings: {
        org: config.get('DA_ORG') || '',
        site: config.get('DA_SITE') || '',
        scopes: config.get('IMS_SCOPES') || '',
        allowedHost: config.get('ALLOWED_API_HOST') || '',
      },
    });

    return await handle(request);
  } catch {
    // Do not expose secrets or internal errors.
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: 'EDGE_FUNCTION_UNAVAILABLE',
          message: 'Edge Function configuration unavailable',
        },
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      },
    );
  }
}

// Register the Fastly Compute request handler.
addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});