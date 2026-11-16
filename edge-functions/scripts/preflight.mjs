// Read-only authentication probe. No token logs, no write/delete operations.
// Invoke with node --env-file=.env scripts/preflight.mjs
const { DA_ORG, DA_SITE, DA_TEST_PATH, IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_SCOPES } = process.env;
if (![DA_ORG, DA_SITE, IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_SCOPES].every(Boolean)) {
  console.error('Set DA_ORG, DA_SITE, IMS_CLIENT_ID, IMS_CLIENT_SECRET and IMS_SCOPES in .env.');
  process.exit(2);
}
if (!/^[\w-]+$/.test(DA_ORG) || !/^[\w-]+$/.test(DA_SITE)) {
  console.error('Invalid DA_ORG or DA_SITE'); process.exit(2);
}
if (DA_TEST_PATH && !/^data\/(?:[\w-]+\/)*[\w-]+\.json$/.test(DA_TEST_PATH)) {
  console.error('DA_TEST_PATH must be an optional JSON path under data/'); process.exit(2);
}
const tokenBody = new URLSearchParams({
  grant_type: 'client_credentials', client_id: IMS_CLIENT_ID,
  client_secret: IMS_CLIENT_SECRET, scope: IMS_SCOPES,
});
let tokenResponse;
try {
  tokenResponse = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
    signal: AbortSignal.timeout(12000),
  });
} catch {
  console.error('Could not reach Adobe IMS'); process.exit(1);
}
if (!tokenResponse.ok) {
  console.error(`IMS token request: HTTP ${tokenResponse.status} (token hidden)`); process.exit(1);
}
const { access_token: token } = await tokenResponse.json();
if (!token) { console.error('IMS response omitted token'); process.exit(1); }
console.log('IMS Server-to-Server token: acquired (hidden)');
async function check(url, label) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    console.log(`${label}: HTTP ${response.status}`);
    return response.status;
  } catch { console.error(`${label}: network error`); return 0; }
}
const listStatus = await check(`https://admin.da.live/list/${DA_ORG}/${DA_SITE}`, 'DA repository list');
if (DA_TEST_PATH) {
  const fileStatus = await check(`https://admin.da.live/source/${DA_ORG}/${DA_SITE}/${DA_TEST_PATH}`, 'DA existing sheet read');
  if (fileStatus === 404) console.log('Test sheet not present; this does not assess DA write permission.');
}
if (listStatus !== 200) {
  console.error('STOP: DA repository list did not return 200.'); process.exitCode = 1;
} else {
  console.log('Read access OK; WRITE PERMISSION MUST BE TESTED SEPARATELY with a disposable sheet.');
}
