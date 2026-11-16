# DA EDS Sheet Service — Local + Stage + Production

**Architecture:** Postman/service → protected AEM Edge Function → Adobe IMS client_credentials → DA Source / Move API → JSON sheet.

**Production gate:** The S2S credential must pass **DA GET and disposable POST** with its technical-account identity. A DA `list` 200 demonstrates READ only. No browser-session token is used by the runtime.

## What's changed in this deliverable

- Removed the unsafe duplicate root `edgeFunctions.yaml` which contained an actual bearer token, Client ID and Client Secret. Removed uploaded `.env`, build artifacts, dependencies, and macOS metadata.
- Local Node adapter reads `.env` including `INBOUND_API_KEY` (previous sample omitted this, causing 503/401 issues).
- EDS shared config pipeline distinguishes STAGE and MAIN domains, DA repositories and secret stores; incoming request cannot select its credentials.
- Warm Edge runtime reuses a handler + cached IMS token rather than generating a token for every API request.
- DA `moveSheet` now invokes Adobe's `/move` API rather than copy then delete. GET failures with 401 invalidate token cache; only GET may retry once, writes are never blindly replayed.
- Retains existing explicit `operation` API contract and nested-sheet flattening. `updateSheet` REPLACES the entire sheet rather than one row. Top-level `action` is excluded from stored sheet columns.

## Rotate secrets BEFORE using this ZIP

The ORIGINAL uploaded ZIP included actual sensitive data in `edgeFunctions.yaml` and `.env`. Rotate your exposed OAuth Client Secret and any active inbound API key, and remove the old values from repository history, CI logs, and shared artifacts if applicable. The new ZIP intentionally contains NO real credentials. Never use an IMS bearer token as `x-api-key`.

## A. Local Node runtime — real IMS + DA

1. Install Node.js >=20.6. `cd edge-functions`.
2. Run `cp .env.example .env`.
3. Edit `.env`: `IMS_CLIENT_ID`, `IMS_CLIENT_SECRET`, `IMS_SCOPES` from the EDS API card; `DA_ORG`, `DA_SITE`; generate NEW `INBOUND_API_KEY` with `openssl rand -hex 32`; keep file private.
4. Confirm the Technical Account Email is granted DA permissions to `/mysite/data/+**` (and the folder exists). A successful `list` GET does not confirm writes.
5. Run `npm test` and `npm run check`.
6. Run `node --env-file=.env scripts/preflight.mjs` on an existing file path. The script is read-only; it checks DA repository LIST (200 expected) and optionally attempts the test sheet. A 404 for the optional sheet does not block the LIST test.
7. Run `npm run local`. Server binds to `127.0.0.1:7676` only. Set Postman variables `baseUrl=http://127.0.0.1:7676`, `apiKey=<INBOUND_API_KEY>`.
8. Use Postman collection requests in order: `01 Dry Run`, `02 Create Folder` (only if needed), `03 Create Sheet`, `04 Get`, `05 Update`, `06 Move`, `07 Delete`. NEVER test writes on business content before confirming on `data/testing/`.
9. A dry run does no IMS or DA calls. Turn `dryRun` off to test real DA. `deleteSheet` and `moveSheet` require `confirm: true`.

Optional Fastly simulator: `npm install` then `npm run serve`. This is **dry-run only**, because `fastly.toml` uses fake local secrets. Adobe sandbox deployments don't provision secret stores; use the Node adapter for real authentication tests and a provisioned Stage environment for actual edge-runtime validation.

## B. Adobe Cloud Manager — EDS Stage and Production

1. Confirm the Edge Functions project and EDS sites are onboarded to Cloud Manager, with a config pipeline. Install `aio`: `npm install -g @adobe/aio-cli`; `aio plugins install @adobe/aio-cli-plugin-aem-edge-functions`; `aio login`; `aio aem edge-functions setup`.
2. Edit **only** `config/edgeFunctions.yaml`: replace `STAGE_API_HOST`, `MAIN_API_HOST` with your actual mapped public domains; verify `DA_ORG_STAGE`, `DA_SITE_STAGE`, `DA_ORG_MAIN`, `DA_SITE_MAIN`; set each `IMS_SCOPES_*` to the **actual scopes granted by its OAuth credential**.
3. Make identical hostname replacements in `config/cdn.yaml`. Keep `originName: edgefunction-eds-sheet-service` matching function `eds-sheet-service`.
4. In Cloud Manager → Program → Edge Delivery → Pipelines → View/Edit variables, create all SIX listed secret variables **as Secret** (not plaintext config): `MYSITE_STAGE_INBOUND_API_KEY`, `MYSITE_STAGE_IMS_CLIENT_ID`, `MYSITE_STAGE_IMS_CLIENT_SECRET`, `MYSITE_MAIN_INBOUND_API_KEY`, `MYSITE_MAIN_IMS_CLIENT_ID`, `MYSITE_MAIN_IMS_CLIENT_SECRET`. Stage and Main must have different inbound keys and preferably distinct technical-account credentials, both authorized to their target DA repositories. The Client ID is treated as a secret here for consistency and rotation.
5. Add config files in your Cloud Manager configuration repository under `config/`, not the Edge Functions source project unless those are the SAME repository/pipeline source. Keep the Edge Functions source in its code repository. Deploy the **configuration pipeline first**, after review and explicit approval.
6. Deploy the function code from the matching source branch: `npm install`, `aio aem edge-functions build`, `aio aem edge-functions deploy eds-sheet-service` (run setup/login first).
7. Stage smoke tests using the real stage domain: `GET https://<stage-domain>/api/eds-sheets/health`; POST dry-run; `createFolder`, `createSheet`, `getSheet`, `updateSheet`, `moveSheet`, `deleteSheet` under `data/testing/` only.
8. Only after Stage success and a separate production credentials/DA permission review should you promote or deploy to Main and run a disposable smoke test there.
9. Configure CDN/WAF IP allowlist, request rate limits and monitoring according to your organization's standards; the API key must never be included in a public website or frontend code.

NOTE: If one Cloud Manager config pipeline serves multiple EDS sites, the variables are shared. Keep the above site-specific prefix and validate exact domain-to-credential mapping. The code selects MAIN/STAGE by EXACT domain from `request.url`. Validate hostname/routing in Stage before relying on it.

## C. Postman contract

Request: `POST {{baseUrl}}/api/eds-sheets`, Header `Content-Type: application/json`, Header `x-api-key: {{apiKey}}`, Authorization tab **No Auth**. `{{apiKey}}` is your own inbound API key, NOT an IMS token. Import `postman/EDS-Sheet-Service.postman_collection.json`.

Example:

```json
{
  "operation": "createSheet",
  "path": "data/testing/my-first-sheet.json",
  "dryRun": true,
  "sheetData": [{"assetID":"TEST-001","action":"created","netChange":false,
                 "partNumbers":[{"operation":"A","partNumber":"410899"}]}]
}
```

Supported operations: `createFolder` (folder path like `data/testing`), `createSheet`, `getSheet`, `updateSheet` (whole-file replace), `moveSheet` (DA Move API, `destinationPath` and `confirm: true`), `deleteSheet` (`confirm: true`). Only `.json` under `data/` is allowed. Limit: 256 KiB inbound, 1000 rows, 200 flattened columns.

IMPORTANT: The current service DOES NOT implement event-level append/update/delete by `assetID`; a raw `{ "action": "created", ... }` JSON event alone is not accepted as an API operation. Do not confuse sheet CRUD with row CRUD. Add a separate, idempotent event handler before connecting production bulk feeds.

## D. Status/errors

| Code | What to do |
|---|---|
| `401 UNAUTHORIZED` | Enable `x-api-key`, match selected environment's inbound key |
| `503 INBOUND_AUTH_NOT_CONFIGURED` | Secret missing or shorter than 32 chars |
| `502 IMS_TOKEN_FAILED` | Check Client ID/Secret pair and credential scopes |
| `502 DA_AUTH_FAILED` | S2S identity lacks DA permission or token rejected |
| `502 DA_REQUEST_FAILED` | Check DA path, write permission, folder or API status |
| `409 ALREADY_EXISTS` | Use updateSheet; do not overwrite accidentally |
| `403 HOST_NOT_ALLOWED` | Correct exact hostname mapping / CDN origin selectors |

## Official references

- DA Source API: https://docs.da.live/developers/api/source
- DA Move API: https://docs.da.live/developers/api/move
- Adobe EDS secrets: https://experienceleague.adobe.com/en/docs/experience-manager-learn/cloud-service/edge-functions/edge-functions-how-to/configs-and-secrets
- Adobe AEM Edge Functions: https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/developing/edge-functions
