// node scripts/preflight.mjs. Read-only DA authorization preflight; no writes.
// Supply env vars at invocation. This script intentionally does not load .env files.
const { DA_ORG, DA_SITE, DA_TEST_PATH, IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_SCOPES } = process.env;
if (![DA_ORG, DA_SITE, DA_TEST_PATH, IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_SCOPES].every(Boolean)) {
  console.error('Set DA_ORG, DA_SITE, DA_TEST_PATH, IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_SCOPES first.');
  process.exit(2);
}
if (!/^data\/(?:[\w-]+\/)*[\w-]+\.json$/.test(DA_TEST_PATH)) {
  console.error('DA_TEST_PATH must be a JSON path under data/'); process.exit(2);
}
const request = new URLSearchParams({
  grant_type: 'client_credentials', client_id: IMS_CLIENT_ID,
  client_secret: IMS_CLIENT_SECRET, scope: IMS_SCOPES,
});
const ims = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: request,
});
if (!ims.ok) {
  console.error(`IMS token request failed: HTTP ${ims.status}`);
  process.exit(1);
}
const { access_token: token } = await ims.json();
if (!token) { console.error('No token from IMS'); process.exit(1); }
console.log('IMS token acquisition: OK (token hidden)');
const da = await fetch(`https://admin.da.live/source/${DA_ORG}/${DA_SITE}/${DA_TEST_PATH}`, {
  headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
});
console.log(`DA Source GET status: HTTP ${da.status}`);
if (da.status === 200) console.log('DA read authentication accepted. Check write permission separately.');
else if (da.status === 404) console.log('Path not found; try an EXISTING file to verify access. 404 is not proof of write access.');
else if (da.status === 401 || da.status === 403) console.log('STOP: IMS technical account is not accepted/authorized by DA.');
else console.log('Unexpected DA status; review integration and repository.');
if (da.status !== 200) process.exitCode = 1;
