import { fail } from './errors.js';

const TOKEN_ENDPOINT = 'https://ims-na1.adobelogin.com/ims/token/v3';

export function createTokenProvider({ getSecret, fetcher, scopes }) {
  // Instance-local cache; expiry is based on the granted token lifetime.
  let token = null;
  let validUntil = 0;
  let pending = null;

  return async function getAccessToken() {
    if (token && Date.now() < validUntil) return token;
    if (pending) return pending;
    pending = (async () => {
      const clientId = await getSecret('IMS_CLIENT_ID');
      const clientSecret = await getSecret('IMS_CLIENT_SECRET');
      if (!clientId || !clientSecret || !scopes) {
        fail('IMS_NOT_CONFIGURED', 'IMS OAuth configuration is incomplete', 503);
      }
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: scopes,
      });
      let response;
      try {
        response = await fetcher(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          cache: 'no-store',
        });
      } catch {
        fail('IMS_UNREACHABLE', 'Unable to connect to Adobe IMS', 502);
      }
      if (!response.ok) {
        // Deliberately do not return upstream bodies to the caller.
        fail('IMS_TOKEN_FAILED', `Adobe IMS rejected the client credentials (HTTP ${response.status})`, 502);
      }
      const data = await response.json().catch(() => ({}));
      if (typeof data.access_token !== 'string' || !data.access_token) {
        fail('IMS_INVALID_RESPONSE', 'Adobe IMS returned no access token', 502);
      }
      token = data.access_token;
      const ttl = Number(data.expires_in);
      // Refresh early; unknown expiry is treated as a short-lived token.
      validUntil = Date.now() + Math.max(1, (Number.isFinite(ttl) ? ttl : 60) - 60) * 1000;
      return token;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
