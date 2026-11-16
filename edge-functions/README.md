# EDS Sheet Service — AEM Edge Functions

A restricted API that creates, reads, replaces, deletes, and moves **DA-backed EDS JSON sheets** without Adobe App Builder or Sling servlets. Designed for `codeandtheory/citibank`; change `DA_ORG` / `DA_SITE` for another repository.

> **IMPORTANT — integration gate:** The source code and local automated tests can run without Adobe credentials. Live DA operations **depend on a DA-authorized Adobe IMS technical account** and Cloud Manager / CDN setup. Adobe documents OAuth Server-to-Server for DA Admin API, but the ability of *your* technical account to write to the DA Source API must be verified. This repository does not bypass DA authorization. Do not deploy to production until this is proven with a staging test.

## Architecture

`Postman (X-API-Key) -> Adobe Managed CDN (custom stage domain) -> AEM Edge Function -> IMS OAuth token endpoint -> DA Source API -> data/*.json`

The inbound API key is **not** an IMS token. The edge function fetches its own IMS token using separate OAuth server-to-server credentials stored as Cloud Manager secrets.

## What is included

| File | Purpose |
| --- | --- |
| `src/index.js` | Fastly/AEM Edge Functions entry point; reads ConfigStore and SecretStore |
| `src/handler.js` | Routing, caller authentication, validation, operation orchestration |
| `src/ims.js` | Adobe IMS OAuth client credentials, safe expiry-aware in-isolate cache |
| `src/da.js` | DA Source API integration (GET/POST multipart/DELETE) |
| `src/sheet.js` | Converts nested JSON into EDS sheet columns; removes top-level `action` |
| `src/errors.js` | Safe JSON error responses with no secret leakage |
| `config/edgeFunctions.yaml` | Registers function, configured repository, OAuth scopes, secret references |
| `config/cdn.yaml` | CDN origin selector; restricts routes to custom stage domain |
| `fastly.toml` | Local Fastly development configuration with dummy credentials |
| `test/` | Node.js tests with mocked IMS and DA (no real credentials) |
| `scripts/preflight.mjs` | Read-only IMS and DA acceptance check |
| `postman/EDS-Sheet-Service.postman_collection.json` | Postman API examples |

## 1. Important assumptions and prerequisites

- Edge Delivery Services site onboarded to **Adobe Cloud Manager** with an Edge Delivery add-on and custom domain mapped to Adobe Managed CDN; Deployment Manager role.
- AEM Edge Functions CLI and **a separate Edge Functions repo**, ideally starting from Adobe's boilerplate. This ZIP is a self-contained starter layout following the boilerplate entrypoint; it is not an App Builder action.
- DA repository exists, `codeandtheory/citibank`; target **folder exists** under DA, e.g. `data/` (use `createFolder` once if necessary).
- Adobe Developer Console OAuth Server-to-Server integration has **correct DA permissions**, including writes. The IMS credentials must be from the SAME integration; don't mix client IDs or secrets from different integrations.
- An authorized service credential accepted by DA Source API has to be verified before live writes. If no such credential exists, you must obtain an Adobe-supported authorized integration; an Edge Function cannot silently impersonate a DA user.
- To avoid conflicts, first deploy to your **staging domain**, then promote after a rollback/backup strategy is approved.

Adobe references:
- https://experienceleague.adobe.com/en/docs/experience-manager-learn/cloud-service/edge-functions/edge-functions-setup/setup-eds
- https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/developing/edge-functions
- https://docs.da.live/developers/api/source
- https://experienceleague.adobe.com/en/docs/experience-cloud-kcs/kbarticles/ka-27613
- https://experienceleague.adobe.com/en/docs/experience-manager-learn/cloud-service/edge-functions/edge-functions-how-to/configs-and-secrets

## 2. Clone/install on macOS (zsh)

```bash
node --version             # Node 20+ recommended
npm --version
npm install -g @adobe/aio-cli
aio plugins install @adobe/aio-cli-plugin-aem-edge-functions
aio login
# Unzip the package, cd into eds-sheet-edge-function/
npm install
npm test
npm run check
```

If you are adding this implementation to Adobe's official boilerplate instead, copy `src/`, `config/`, and `test/` into the boilerplate and merge `fastly.toml` and `package.json` values **rather than overwriting existing shared CDN rules**.

## 3. Set up AEM Edge Functions in Adobe Cloud Manager

1. Open **Cloud Manager -> Program -> Edge Delivery**; confirm EDS add-on and that the target EDS site is onboarded.
2. Add your **custom stage domain**, SSL certificate and DNS mapping to Adobe Managed CDN. The default `*.aem.live` hostname does **not** replace the custom domain requirement.
3. Verify you have **Deployment Manager** role.
4. Set up the CLI's project context in the project directory:
   ```bash
   aio aem edge-functions setup
   aio aem edge-functions info
   ```
5. Select EDS, your program and stage site in the wizard. A `.aio` context file is generated; do not commit it.
6. Add this Edge Function repo as a **private repository** in Cloud Manager if using the config pipeline from a private repo.
7. Under **Edge Delivery -> Pipelines**, create an **Edge Delivery configuration pipeline**, source branch `main` (or the branch you deploy), **code location `/config`**.

**EDS warning:** Edge Delivery config pipelines apply across the mapped sites in the program. Protect the stage route by matching `reqProperty: domain` in `config/cdn.yaml`. A separate production function / domain policy and prod-specific secrets should be prepared for production.

## 4. Configure Adobe IMS OAuth credentials

1. Open https://developer.adobe.com/console and select the **correct IMS Organization**.
2. Choose the intended Developer Console project, **Add API**, and an Adobe API/product integration appropriate to DA access. Adobe's DA authentication KCS describes a **Cloud Manager** API / OAuth Server-to-Server setup. Do not assume adding an unrelated AEM Assets API grants DA access.
3. Select **OAuth Server-to-Server**. Assign a product profile that actually authorizes the technical account for the DA repository.
4. In that integration, copy its **Client ID**, **Client Secret**, and **exact OAuth scopes**; do not use a different project's values. The scopes in `config/edgeFunctions.yaml` are an example from Adobe's DA KCS and **must be checked** against the integration's assigned scopes.
5. The code sends `grant_type=client_credentials` to `https://ims-na1.adobelogin.com/ims/token/v3` and caches the access token until shortly before expiry.
6. **First verify DA acceptance** on an existing `data/*.json` file with the read-only preflight in Step 5. Once read works, test writing to a disposable stage file with the endpoint (Step 9); successful read does not guarantee write permissions.

An `invalid_client` response means the Client ID/secret/integration is wrong or not active; a `401`/`403` from DA means IMS acquisition was not sufficient to authorize DA. Do **not** ship an interactive user token, JWT private key, or bypass security to solve this.

## 5. Run the read-only authorization preflight

Set values securely **in your shell**, never in code or Postman collections. Prefer terminal prompt / approved enterprise secrets management; avoid saving secrets to shell history or source control.

```bash
export DA_ORG=codeandtheory
export DA_SITE=citibank
export DA_TEST_PATH=data/existing-sheet.json # MUST already exist
read -r 'IMS_CLIENT_ID?Client ID: '
read -rs 'IMS_CLIENT_SECRET?Client Secret: '; echo
read -r 'IMS_SCOPES?OAuth scopes from Console: '
export IMS_CLIENT_ID IMS_CLIENT_SECRET IMS_SCOPES
node scripts/preflight.mjs
unset IMS_CLIENT_ID IMS_CLIENT_SECRET IMS_SCOPES
```

Expected: `IMS token acquisition: OK` and `DA Source GET status: HTTP 200`. If DA rejects the technical account, **stop here and get proper DA permission/service account onboarding**. A 404 is inconclusive; use a known existing path.

## 6. Configure staging domain and non-secret values

Open `config/edgeFunctions.yaml`:

- `DA_ORG`: `codeandtheory`
- `DA_SITE`: `citibank`
- `ALLOWED_API_HOST`: **replace** `stage.example.com` with your genuine stage domain, for example `stage.yourdomain.com` (without `https://`).
- `IMS_SCOPES`: **replace** with the exact scopes granted to your OAuth integration.

Open `config/cdn.yaml`: replace **both** instances of `stage.example.com` with the **same** stage domain. Do not remove the domain checks. Merge origin-selector rules with your current `cdn.yaml` if a configuration file already exists.

## 7. Store the three stage secrets in Cloud Manager

Navigate to **Cloud Manager -> Program -> Edge Delivery -> Pipelines -> ... -> View/Edit variables** and create three variables with **type Secret**:

| Cloud Manager Secret name | Value | Referenced as runtime key |
| --- | --- | --- |
| `CITI_STAGE_EDS_API_KEY` | High entropy random **64-character or longer** API key generated by your security/DevOps process | `INBOUND_API_KEY` |
| `CITI_STAGE_IMS_CLIENT_ID` | OAuth S2S Client ID | `IMS_CLIENT_ID` |
| `CITI_STAGE_IMS_CLIENT_SECRET` | OAuth S2S Client Secret | `IMS_CLIENT_SECRET` |

`edgeFunctions.yaml` contains only `${{...}}` references. Do not paste values into `.yaml`, `.js`, GitHub Actions logs, screenshots, or tickets. Ensure the secret names match exactly (case sensitive).

For a random Postman key, generate one on your Mac with an approved utility:

```bash
openssl rand -hex 32
```

Copy that value into Cloud Manager securely, then set it only in Postman's **secret** / local variable. Never reuse the IMS client secret as the inbound API key.

**Per-environment isolation:** This sample includes only stage secrets to keep the API intentionally stage-scoped. For prod, provision separate `CITI_PROD_...` secrets, map a prod-specific function/environment, match only the prod domain, and separately test credentials/permissions before promotion. Adobe's EDS config pipeline can serve multiple mapped sites and secret names must not collide.

## 8. Verify local behavior without DA credentials

`fastly.toml` has a local-only dummy API key and dummy IMS credentials. You can test conversion safely with `dryRun: true`:

```bash
npm test
npm run serve
```

The dev server normally listens at `http://127.0.0.1:7676`. In a second terminal:

```bash
curl -sS http://127.0.0.1:7676/api/eds-sheets/health

curl -sS -X POST http://127.0.0.1:7676/api/eds-sheets \
  -H 'content-type: application/json' \
  -H 'x-api-key: LOCAL_ONLY_DEMO_API_KEY_CHANGE_BEFORE_REAL_USE_123456' \
  -d '{"operation":"createSheet","path":"data/products.json","dryRun":true,"sheetData":[{"assetID":"I-NA-BCKM-410904","action":"created","netChange":false,"partNumbers":[{"operation":"A","partNumber":"410899"}],"metadata":{"resourceRegion":"NA"}}]}'
```

Expected `success: true`, `dryRun: true`, flattened `metadata.resourceRegion`, serialized `partNumbers`, and **no** top-level `action` column. No Adobe token is requested. To use real IMS/DA locally, replace the **dummy local-only secrets** in `fastly.toml` privately (and never commit them), or use the configured cloud stage deployment.

## 9. Deploy and test on staging

1. Commit and push your code/config (without real secrets) to your Edge Functions repo.
2. Run the **Edge Delivery configuration pipeline** in Cloud Manager. It registers `eds-sheet-service`, its config/secrets mapping, and the stage-domain CDN routes.
3. Verify registration and build/deploy:
   ```bash
   aio aem edge-functions info
   aio aem edge-functions list
   aio aem edge-functions build
   aio aem edge-functions deploy eds-sheet-service
   aio aem edge-functions tail-logs eds-sheet-service
   ```
4. Test health against `https://<YOUR_STAGE_DOMAIN>/api/eds-sheets/health`.
5. Import `postman/EDS-Sheet-Service.postman_collection.json` into Postman; set collection variables `baseUrl` and the **secret** `apiKey`.
6. Run **Dry Run Create** first, then **Create Sheet** on a disposable `data/testing/edge-test.json` (create the `data/testing` directory first).
7. Verify the file appears in DA at `https://da.live/edit#/codeandtheory/citibank/data/testing/edge-test` or via DA UI/Source API. DA UI URLs may differ for JSON; the API GET is the authoritative check.
8. Run Get, Update, Move (if needed), then Delete with `confirm: true` on the test file.
9. Confirm `403` on a non-stage hostname, `401` for wrong API key, `409` when creating an existing path, `404` for an update to a missing path.

## 10. API contract — single authenticated POST endpoint

`POST https://<YOUR_STAGE_DOMAIN>/api/eds-sheets`

Headers:

```http
Content-Type: application/json
X-API-Key: <INBOUND_API_KEY>
```

### Create a sheet

```json
{
  "operation": "createSheet",
  "path": "data/testing/assets.json",
  "sheetData": [
    {
      "assetID": "I-NA-BCKM-410904",
      "action": "created",
      "netChange": false,
      "createdDate": "2026-11-13T05:30:00.000Z",
      "lastModificationDate": "2026-11-13T05:30:00.000Z",
      "partNumbers": [
        { "operation": "A", "partNumber": "410899", "squashedPartNumber": "410899" },
        { "operation": "B", "partNumber": "410899", "squashedPartNumber": "410899" }
      ],
      "metadata": { "resourceRegion": "NA", "source": "PDM" }
    }
  ],
  "dryRun": true
}
```

Set `dryRun: false` (or omit it) to actually write. `createSheet` checks first and rejects an existing file (`409`) instead of intentionally overwriting it. This check is **not an atomic lock**; concurrent writers are not protected by a transaction.

### Read / replace / delete / move / create folder

```json
{ "operation": "getSheet", "path": "data/testing/assets.json" }
```

```json
{ "operation": "updateSheet", "path": "data/testing/assets.json", "sheetData": [{ "assetID": "NEW", "netChange": true }] }
```

`updateSheet` **replaces the entire sheet**. It does not perform row-level merge or patch. For row-level updates, read the existing sheet, merge by stable ID in a controlled application, and submit the replacement while handling concurrent writers (prefer a single-writer queue).

```json
{ "operation": "deleteSheet", "path": "data/testing/assets.json", "confirm": true }
```

```json
{ "operation": "moveSheet", "path": "data/testing/assets.json", "destinationPath": "data/testing/archive.json", "confirm": true }
```

```json
{ "operation": "createFolder", "path": "data/testing" }
```

### Example successful response

```json
{
  "success": true,
  "operation": "createSheet",
  "path": "data/testing/assets.json",
  "rows": 1,
  "da": { "source": { "editUrl": "https://da.live/edit#/..." } }
}
```

DA response fields vary by operation; `da` is an optional object returned by the DA Source API. Errors are always shaped as:

```json
{ "success": false, "error": { "code": "DA_AUTH_FAILED", "message": "DA rejected the configured IMS identity (HTTP 403)" } }
```

## 11. Nested JSON, sheet columns and constraints

- The top-level `action` property is excluded from every row (so the action is used for routing but not stored as a sheet column).
- Nested objects flatten to dotted columns: `metadata.resourceRegion` becomes one column.
- Arrays become valid JSON **strings in a single sheet cell**: `partNumbers` preserves every array item but isn't expanded into separate row objects. You can parse the string back into the original array.
- Values `false`, `0`, `null`, and empty strings are preserved. Columns appearing only in later rows are still included across all sheet rows.
- Request and resulting sheet size limit: 256 KiB; rows limit: 1,000; columns limit: 200.
- File paths are restricted to `data/` and `.json` with safe path segments. No caller-supplied URL, DA org/site, or token is accepted.
- The service **does not** auto-preview or publish content. DA write and EDS preview/publish are separate operations.
- Never write `action`, credentials, or raw IMS tokens into the sheet unless explicitly authorized (the code strips only top-level `action`).

## 12. Operational cautions and best practices

1. **No transactional writes:** DA Source API does not provide a compare-and-swap primitive in this implementation. `createSheet` and `updateSheet` can race. Introduce an external queue/lock if concurrent writes to the same file matter.
2. **Move is copy + delete:** If destination write succeeds and source delete fails, the endpoint returns `MOVE_PARTIAL`, and both paths must be reconciled. No rollback or transaction is claimed.
3. **Limit scope:** Keep DA file paths under a dedicated `data/testing` or `data/integrations` subtree if you need stronger isolation; adjust `validateFilePath()` accordingly.
4. **Rate limiting:** Configure appropriate CDN traffic-filter policies / WAF and monitoring for `/api/eds-sheets` before production. A shared API key is suitable only for controlled service-to-service callers; prefer your enterprise API gateway or OAuth caller identity for multi-tenant use.
5. **Key rotation:** Rotate `CITI_STAGE_EDS_API_KEY` and OAuth client secret via approved secrets workflows, redeploy as needed, and avoid downtime by coordinating client rotation.
6. **Backup & auditing:** Maintain a backup or versioning policy for sheets, log operation/status/trace IDs without logging credentials or sensitive record data, and restrict who can call destructive endpoints.
7. **Caching:** `cdn.yaml` uses `skipCache: true` and the Edge Function returns `Cache-Control: no-store`; do not cache private sheet responses.
8. **Production rollout:** Verify staging `createSheet`, `getSheet`, `updateSheet`, `deleteSheet`, and DA-authorized token acquisition before configuring production mapping. Use a separate production domain, dedicated prod secrets, release testing and rollback plan.
9. **No privileged secrets in client code:** This endpoint is for Postman and trusted backend clients. Never embed `X-API-Key` in public EDS `scripts.js`, blocks, or browser-local storage. Rotate any credentials previously exposed in chat, screenshots, sample payloads, tickets or logs.
10. **Adobe changes:** Refer to official Adobe documentation for the latest Edge Functions `edgeFunctions.yaml` properties and IMS/DA permissions; live Adobe infrastructure isn't exercised by the included unit tests.

## 13. Troubleshooting

| Symptom | Likely cause / next action |
| --- | --- |
| 404 at `/api/eds-sheets` on stage | Custom domain/CDN origin selector mismatch; pipeline not deployed |
| 403 `HOST_NOT_ALLOWED` | `ALLOWED_API_HOST` differs from request hostname |
| 401 `UNAUTHORIZED` | Inbound `X-API-Key` does not match Cloud Manager secret |
| 503 `INBOUND_AUTH_NOT_CONFIGURED` | Missing/short Cloud Manager inbound key |
| 503 `IMS_NOT_CONFIGURED` | Missing IMS client credentials or scope config |
| 502 `IMS_TOKEN_FAILED` | Incorrect IMS credentials, scope or product-profile authorization; check Adobe Developer Console |
| 502 `DA_AUTH_FAILED` | IMS token was issued but DA does not authorize this technical account; stop and work with Adobe/DA admin |
| 502 `DA_REQUEST_FAILED` | DA path/folder/permission/operation issue; inspect safe Edge Function logs and test direct DA API |
| 409 `ALREADY_EXISTS` | Use `updateSheet` or a different path |
| 404 `NOT_FOUND` | Source sheet does not exist |
| 400 `INVALID_PATH` | Path must be under `data/` and end in `.json` |
| 200 dryRun but real request fails | Dry runs deliberately do not contact IMS or DA |

## 14. Production release checklist

- [ ] DA-authorized technical account confirmed with real read AND write on disposable stage sheet
- [ ] Stage Cloud Manager custom domain / DNS / SSL configured
- [ ] Stage secrets exist and are not checked into source control
- [ ] `ALLOWED_API_HOST`, CDN domain rule and IMS scopes reviewed
- [ ] Automated tests pass; manual Postman cases pass
- [ ] CDN traffic filtering / rate limits configured
- [ ] Backup/versioning and concurrent-write policy agreed
- [ ] Dedicated production config, secrets and caller identity reviewed
- [ ] Deployment monitoring, log-forwarding (if available), rollback procedure tested

---

This starter was prepared independently against Adobe's October 2026 docs and mocked tests. It is **not Adobe-certified** and was **not live-deployed or validated with a real DA technical account**.
