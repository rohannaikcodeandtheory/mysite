# AEM Edge Functions — DA EDS Sheet Service

**Environments:** Local → Stage → Production  
**Repository:** [mysite / edge-functions](https://github.com/rohannaikcodeandtheory/mysite/tree/main/edge-functions)

This service receives authenticated API requests, obtains an Adobe IMS OAuth Server-to-Server access token, and reads or writes JSON sheets in Adobe Document Authoring (DA). It supports both explicit sheet operations and raw asset events routed automatically by language and brand.

> **Production release gate:** Verify the *technical account* can perform both DA GET and a disposable DA POST in the intended repository. A successful LIST/GET alone proves only read access. Do not deploy a concurrent event feed without durable per-sheet serialization and idempotency.

## 1. Architecture

```text
Postman / trusted backend
    │ POST /api/eds-sheets
    │ x-api-key: <INBOUND_API_KEY>
    ▼
AEM Edge Function (or local Node adapter)
    │ validates inbound API key, payload and route
    │ obtains/caches IMS OAuth client_credentials token
    ▼
Adobe DA Source / Move API
    ▼
DA repository: data/{language}/{brandName}.json
```

The caller's `x-api-key` is an **inbound service key**, not an IMS bearer token. The runtime selects its own configured DA repository and IMS credentials; clients must not supply them in request bodies. Do not embed secrets in public EDS frontend JavaScript.

## 2. Prerequisites

- Node.js **20.6+** and npm; Git.
- Access to the Adobe Developer Console project with an **OAuth Server-to-Server** credential and the exact scopes assigned to it.
- DA repository organization/site and technical-account permissions for the target `data/` subtree.
- For Stage/Production: an eligible Cloud Manager Edge Delivery program with Edge Functions onboarding, a configuration pipeline, mapped public domains, and managed secret/config stores.
- Adobe I/O CLI and the Edge Functions plugin for hosted deployments.

**Important:** Adobe Sandbox Edge Functions may not provision the required Config Store / Secret Store. Use the local Node adapter for real IMS→DA testing and a provisioned non-Sandbox Stage environment for hosted authenticated writes. Do not work around missing stores by hardcoding secrets.

## 3. Initial setup

From the repository root:

```bash
cd edge-functions
npm ci
cp .env.example .env
```

Generate a **new** inbound key:

```bash
openssl rand -hex 32
```

Populate `.env` privately with the variables supported by `.env.example`:

```dotenv
IMS_CLIENT_ID=<oauth-server-to-server-client-id>
IMS_CLIENT_SECRET=<oauth-server-to-server-client-secret>
IMS_SCOPES=<exact-comma-separated-scopes-granted-to-credential>
DA_ORG=<da-organization>
DA_SITE=<da-site>
INBOUND_API_KEY=<new-random-key>
```

Never commit `.env`, bearer tokens, Client Secrets or inbound keys. Rotate any credentials previously included in Git history, ZIP files, logs or shared artifacts. Grant the technical-account identity the required DA permissions for the target repository; verify the exact access rules with the DA administrator.

## 4. Local development and testing

### 4.1 Start the local API

For subsequent runs, after `.env` is configured:

```bash
cd edge-functions
npm ci
npm test
npm run check
npm run local
```

The Node adapter listens on **http://127.0.0.1:7676** (loopback only). The commands correspond to scripts in `package.json`: tests, syntax checks, and `node --env-file=.env src/local-server.js`.

### 4.2 Preflight authentication

Before performing writes:

```bash
node --env-file=.env scripts/preflight.mjs
```

This checks IMS and DA read access. An optional missing test sheet may return 404. **Read-only preflight does not confirm POST permission**; verify writing separately with disposable data.

### 4.3 Configure Postman

Import the committed [DA Asset Events — language / brandName collection](postman/DA%20Asset%20Events%20-%20language%20-%20brandName.postman_collection.json).

Set collection variables:

| Variable | Local value |
|---|---|
| `baseUrl` | `http://127.0.0.1:7676` |
| `apiKey` | Your local `INBOUND_API_KEY` |

For POST requests, select **Authorization → No Auth** and set:

```http
Content-Type: application/json
x-api-key: {{apiKey}}
```

Check `00 - Health`, then run raw-event create/update/move/delete requests with **disposable** test assets and brand names. For a dry run, add `"dryRun": true` to a request; it validates without making IMS or DA calls. Remove it or set it to `false` to test a real DA write. Never test destructive actions on business data.

### 4.4 Optional local Edge simulator

```bash
npm run serve
```

The provided `fastly.toml` uses placeholder local secrets, so treat this simulator as **dry-run only**. For real IMS/DA authentication locally, use `npm run local`.

## 5. Supported API requests

### 5.1 Raw asset events (recommended for asset feeds)

```http
POST {{baseUrl}}/api/eds-sheets
Content-Type: application/json
x-api-key: {{apiKey}}
```

Example body:

```json
{
  "assetID": "TEST-001",
  "action": "created",
  "netChange": false,
  "createdDate": "2026-11-13T05:30:00.000Z",
  "partNumbers": [
    {"operation": "A", "partNumber": "410899", "squashedPartNumber": "410899"},
    {"operation": "B", "partNumber": "410899", "squashedPartNumber": "410899"}
  ],
  "metadata": {
    "language": "de_DE",
    "brandName": "TestBrand",
    "resourceRegion": "NA",
    "title": "Test installation diagram"
  }
}
```

The target sheet is automatically derived as `data/de_DE/TestBrand.json`. The service creates the language folder and brand sheet if needed, then appends the new `assetID` row. All supplied nested metadata is flattened into sheet columns; `partNumbers` is stored as a JSON string in one cell. The top-level `action`, `dryRun` and routing-only `previousLocation` are not stored as sheet columns.

| Raw `action` | Result |
|---|---|
| `create` / `created` | Append a new asset; identical repeat unchanged; changed duplicate → 409 |
| `updated` | Replace the matching `assetID` row; missing row → 404 |
| `deleted` | Remove the matching row; absent row → unchanged |
| `moved` | Move one asset row from `previousLocation` to the new metadata route |

For `moved`, supply:

```json
{
  "assetID": "TEST-001",
  "action": "moved",
  "previousLocation": {"language": "de_DE", "brandName": "TestBrand"},
  "metadata": {"language": "fr_FR", "brandName": "NewTestBrand"}
}
```

A raw `moved` event transfers **one row** between brand sheets; it is not the same as the explicit `moveSheet` operation, which moves a whole file. Cross-sheet moves are **not atomic**; a `PARTIAL_MOVE` error requires reconciliation, not blind retry.

Routing segments currently allow only ASCII letters, digits, `_` and `-`, with a maximum length of 80. Case is preserved. The service limits input/generated JSON to 256 KiB, sheets to 1,000 rows, and flattened columns to 200.

Full contract: [RAW-ACTION-INTEGRATION.md](RAW-ACTION-INTEGRATION.md).

### 5.2 Explicit sheet operations (backward compatible)

```json
{
  "operation": "createSheet",
  "path": "data/testing/example.json",
  "dryRun": true,
  "sheetData": [{"assetID": "TEST-001", "netChange": false}]
}
```

Supported operations:

| Operation | Behavior |
|---|---|
| `createFolder` | Create a folder such as `data/testing` |
| `createSheet` | Create a new `.json` sheet |
| `getSheet` | Read a sheet |
| `updateSheet` | **Replace the entire sheet**, not just one row |
| `moveSheet` | Move the entire file using the DA Move API; requires `destinationPath` and `confirm: true` |
| `deleteSheet` | Delete the sheet; requires `confirm: true` |

Only permitted `.json` paths beneath `data/` are supported for sheets. Avoid accidental replacement or deletion of existing data.

## 6. Stage environment — Cloud Manager

### 6.1 Install and configure Adobe CLI

```bash
npm install -g @adobe/aio-cli
aio plugins install @adobe/aio-cli-plugin-aem-edge-functions
aio login
aio aem edge-functions setup
```

Select the correct Adobe organization, program and Edge Delivery site. Confirm that the target program supports the managed stores used by this service.

### 6.2 Configure Stage routing and credentials

In the **Cloud Manager configuration repository**, configure `config/edgeFunctions.yaml` and `config/cdn.yaml`. If the configuration repository and Edge Functions code repository differ, commit the config files to the **configuration pipeline's source repository**, not just the function source repo.

- Replace `STAGE_API_HOST` with the actual mapped Stage hostname in both configuration files.
- Verify `DA_ORG_STAGE`, `DA_SITE_STAGE`, and `IMS_SCOPES_STAGE` match the Stage DA repository and OAuth credential.
- Preserve the expected origin/function mapping: `originName: edgefunction-eds-sheet-service` and function `eds-sheet-service`.
- Confirm the Stage hostname is exactly mapped by the CDN and runtime; incoming bodies must not select credentials.

Create these **Secret** pipeline variables for Stage (not plaintext configuration):

```text
MYSITE_STAGE_INBOUND_API_KEY
MYSITE_STAGE_IMS_CLIENT_ID
MYSITE_STAGE_IMS_CLIENT_SECRET
```

Generate a distinct Stage inbound key. Use only credentials authorized to the Stage DA repository.

### 6.3 Deploy Stage

1. Review and run the **configuration pipeline first**.
2. Confirm its configuration and secrets are active.
3. From the matching Edge Functions source branch, run:

```bash
cd edge-functions
npm ci
npm test
npm run check
aio aem edge-functions build
aio aem edge-functions deploy eds-sheet-service
```

Deployment syntax and permissions depend on the installed Adobe CLI/plugin and program configuration. Check `aio aem edge-functions --help` if a command differs in your installed version.

### 6.4 Stage smoke tests

Set Postman `baseUrl` to `https://<actual-stage-domain>` and `apiKey` to the Stage inbound key. Check:

1. `GET /api/eds-sheets/health`.
2. POST with `dryRun: true`.
3. Create a disposable sheet under `data/testing/` or a dedicated test brand.
4. Read, update, move, and delete only that disposable test content.
5. Verify the result in the **Stage** DA repository and check logs without exposing secrets.

Do not promote if Stage DA POST fails or the technical-account identity lacks the intended permissions.

## 7. Production (Main) environment

Production must have **separate credentials and an explicit approval/review gate**. Do not reuse the Stage inbound API key.

### 7.1 Configure Main

- Replace `MAIN_API_HOST` with the actual mapped production hostname in `config/edgeFunctions.yaml` and `config/cdn.yaml`.
- Verify `DA_ORG_MAIN`, `DA_SITE_MAIN`, and `IMS_SCOPES_MAIN`.
- Create these **Secret** pipeline variables:

```text
MYSITE_MAIN_INBOUND_API_KEY
MYSITE_MAIN_IMS_CLIENT_ID
MYSITE_MAIN_IMS_CLIENT_SECRET
```

Use separate technical-account credentials where possible, authorized only for the intended production repository. Confirm exact hostname-to-environment mapping; a shared configuration pipeline may expose variables to multiple sites, so verify selectors carefully.

### 7.2 Release procedure

1. Review code, configuration, secrets, permissions and security controls.
2. Confirm Stage tests and a disposable DA **GET + POST** passed with its S2S identity.
3. Validate the **production** S2S identity's DA GET and disposable POST permissions before enabling real traffic.
4. Obtain production approval and run the production configuration pipeline.
5. Build/deploy the approved function revision to the intended Main environment using the configured Adobe CLI workflow.
6. Test `GET https://<production-domain>/api/eds-sheets/health`, dry run, then one **disposable** production write/read/delete test.
7. Enable trusted callers gradually, monitor error rates and keep a rollback/reconciliation plan.

Never store an IMS bearer token as a Cloud Manager secret in place of a Client ID/Secret pair. Runtime IMS tokens are generated automatically and cached in warm instances.

## 8. Production safety checklist

- [ ] Exposed Client Secrets and inbound API keys have been rotated and removed from shared artifacts/history where applicable.
- [ ] `.env`, tokens and build artifacts are excluded from Git.
- [ ] Stage and Main use distinct inbound keys and correctly scoped S2S identities.
- [ ] DA GET **and** disposable POST work for each target technical account.
- [ ] Hostname, CDN origin and secret-store mappings are verified.
- [ ] Endpoint access is restricted with CDN/WAF allowlists, rate limiting and monitoring.
- [ ] No secrets are present in public frontend code or request payloads.
- [ ] Durable **per-sheet serialization** and idempotent event handling are implemented before concurrent production ingestion.
- [ ] Partial moves, retries and duplicate events have a documented reconciliation procedure.
- [ ] Backup/rollback and disposable smoke tests are approved.

**Concurrency warning:** DA writes persist the entire sheet. Raw events use read-modify-write, and the in-memory queue only protects one warm instance. Multiple Edge instances can overwrite each other's updates. Do **not** treat this service alone as a concurrency-safe bulk ingestion pipeline; use a durable per-sheet queue or transactional intermediary.

## 9. Troubleshooting

| Error | Likely cause / next action |
|---|---|
| `401 UNAUTHORIZED` | Wrong/missing `x-api-key`; verify the selected environment's inbound key |
| `503 INBOUND_AUTH_NOT_CONFIGURED` | Inbound key secret missing or too short |
| `502 IMS_TOKEN_FAILED` | Invalid Client ID/Secret pair or unsupported scopes |
| `502 DA_AUTH_FAILED` | S2S identity rejected or missing DA permission |
| `502 DA_REQUEST_FAILED` | Invalid DA path, missing folder, write permission or DA API failure |
| `409 ALREADY_EXISTS` | Explicit create target exists; avoid accidental overwrite |
| `403 HOST_NOT_ALLOWED` | Request hostname does not match configured environment mapping |
| `INVALID_ASSET_ROUTE` | Invalid `language` or `brandName` segment |
| `PARTIAL_MOVE` | Destination/source updates diverged; reconcile manually before retry |
| `fastly: command not found` | Fastly CLI not installed; use `npm run local` for real local IMS/DA tests |

## 10. Reference files and official documentation

**Repository files:**

- [Raw action integration guide](RAW-ACTION-INTEGRATION.md)
- [Postman raw asset events collection](postman/DA%20Asset%20Events%20-%20language%20-%20brandName.postman_collection.json)
- [Production checklist](PRODUCTION-CHECKLIST.md)
- [`package.json`](package.json)

**Adobe documentation:**

- [DA Source API](https://docs.da.live/developers/api/source)
- [DA Move API](https://docs.da.live/developers/api/move)
- [Edge Functions overview](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/developing/edge-functions)
- [Edge Functions configurations and secrets](https://experienceleague.adobe.com/en/docs/experience-manager-learn/cloud-service/edge-functions/edge-functions-how-to/configs-and-secrets)

---

**Suggested testing order:** Local tests → local disposable DA write → Stage deployment and smoke test → production credential review → approved Main deployment → disposable production smoke test → controlled rollout.
