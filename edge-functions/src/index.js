/// <reference types="@fastly/js-compute" />
import { ConfigStore } from 'fastly:config-store';
import { SecretStore } from 'fastly:secret-store';
import { createHandler } from './handler.js';

const config = new ConfigStore('config_default');
const secrets = new SecretStore('secret_default');

// Adobe-managed secrets may be bundled under one JSON "secrets" entry.
// Locally, Fastly exposes each key separately. No secrets are logged.
let secretBundlePromise;
async function getSecret(key) {
  if (!secretBundlePromise) {
    secretBundlePromise = (async () => {
      try {
        const entry = await secrets.get('secrets');
        if (!entry) return null;
        const value = JSON.parse(entry.plaintext());
        return value && typeof value === 'object' ? value : null;
      } catch { return null; }
    })();
  }
  const bundle = await secretBundlePromise;
  if (bundle && typeof bundle[key] === 'string') return bundle[key];
  try { return (await secrets.get(key))?.plaintext() ?? null; } catch { return null; }
}

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

addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
