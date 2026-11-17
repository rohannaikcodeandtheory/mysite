# driv-servlets-migration (EDS Sheet Service)

Migration of the DRIV servlet-based asset ingestion to Adobe-hosted services that store asset data as JSON **sheets in Adobe Document Authoring (DA)** for Edge Delivery Services (EDS).

This repository contains **two independent implementations**. Read section 1 first to know which one you need.

> **Deployment is not proof of DA authorization.** A deploy can succeed while DA calls fail with `DA_AUTH_NOT_CONFIGURED` or HTTP 401/403. Do not enable unattended DA OAuth until the credential is confirmed to work against the target DA repository.

## Contents

1. [What is in this repo](#1-what-is-in-this-repo)
2. [Quick start (new developer)](#2-quick-start-new-developer)
3. [Edge Function (recommended path)](#3-edge-function-recommended-path)
4. [App Builder action (original implementation)](#4-app-builder-action-original-implementation)
5. [How authentication and tokens work](#5-how-authentication-and-tokens-work)
6. [Tests](#6-tests)
7. [Troubleshooting](#7-troubleshooting)
8. [Git and secret safety](#8-git-and-secret-safety)
9. [Repository map](#9-repository-map)
10. [Further documents](#10-further-documents)

---

## 1. What is in this repo

| | **Edge Function** (`edge-functions/`) | **App Builder action** (repo root) |
|---|---|---|
| What | HTTP API on AEM Edge Functions (Fastly Compute), plus a frontend block (**EDS Sheet Console**) | Adobe I/O Runtime action `eds-sheet-service/create-eds-sheet`, plus a `web-src` shell |
| Inbound auth | Our own `x-api-key` | Adobe IMS token (`require-adobe-auth`) |
| Outbound auth | IMS `client_credentials` (cached in memory) to DA | IMS `client_credentials` (cached in memory) to DA |
| Local run | `npm run local` (real IMS and DA) | `aio app deploy` only; unit tests run locally |
| Entry point | `edge-functions/src/index.js` (prod), `src/local-server.js` (local) | `actions/create-eds-sheet/index.js` |
| Docs | [edge-functions/README.md](edge-functions/README.md) | this file and `docs/` |

**Which should I use?** The Edge Function is the active development line. It has the read API, brand sharding, structured logging and the frontend console. The App Builder action is the earlier implementation and is kept for reference and its existing operations. Confirm with the team before making changes to either.

## 2. Quick start

Prerequisites:
- Git
- **Node.js 22 or newer** for the repo root, and **20.6 or newer** for `edge-functions/`. Node 22 satisfies both.
- Adobe CLI `aio` (only for App Builder or Edge Function deployment): `npm install -g @adobe/aio-cli`
- Access to Adobe Developer Console, project **EDS Sheet Service**, workspace **Stage**
- A technical-account credential authorized for the target DA repository (ask the project admin)

Fastest path to a running system, using the Edge Function:

```bash
git clone https://github.com/rohannaikcodeandtheory/driv-servlets-migration.git
cd driv-servlets-migration/edge-functions
cp .env.example .env          # then fill in the values, see section 3.2
npm test                      # sanity check, no credentials needed
npm run local                 # starts http://127.0.0.1:7676
```

Then open **http://127.0.0.1:7676/console** and paste your `INBOUND_API_KEY`.

To run the unit tests for the App Builder action (no credentials needed):

```bash
cd driv-servlets-migration
npm ci
node --test test/*.test.js     # 29 tests; do not use `npm test`, see section 6
```

## 3. Edge Function (recommended path)

Full details, the code workflow and a deployment guide are in **[edge-functions/README.md](edge-functions/README.md)**. This section is the minimum to get going.

### 3.1 Install

```bash
cd edge-functions
npm install        # only needed for `npm run serve` / `npm run build`; the local server has no runtime dependencies
```

### 3.2 Configure `.env` (never commit it)

`cp .env.example .env`, then set:

| Variable | What to put | Where it comes from |
|---|---|---|
| `IMS_CLIENT_ID` | OAuth server-to-server client ID | Adobe Developer Console, Stage workspace |
| `IMS_CLIENT_SECRET` | OAuth client secret | Same. Treat as a secret. |
| `IMS_SCOPES` | Exact scopes granted to that credential | Same |
| `DA_ORG`, `DA_SITE` | DA repository to read and write | Project admin |
| `INBOUND_API_KEY` | A **new** key of at least 32 characters. Generate with `openssl rand -hex 32` | You |
| `LOG_LEVEL` (optional) | `debug`, `info`, `warn` or `error`. Default `debug` locally | |
| `PORT` (optional) | Default `7676` | |

The technical account's email must have DA permissions on the site's `data/` folder. A successful DA `list` does not prove it can write.

### 3.3 Run

```bash
npm run local
```

- The server binds to `127.0.0.1` only.
- **Frontend:** http://127.0.0.1:7676/console (the block and API share one origin, so no CORS setup).
- **API:** `http://127.0.0.1:7676/api/eds-sheets`, with header `x-api-key: <INBOUND_API_KEY>`.
- **Health:** `curl http://127.0.0.1:7676/api/eds-sheets/health`
- **Postman:** import `edge-functions/postman/EDS-Sheet-Service.postman_collection.json`. Set `baseUrl=http://127.0.0.1:7676` and `apiKey=<INBOUND_API_KEY>`, with Authorization **No Auth**.
- Try writes under `data/testing/` first. `dryRun: true` makes no IMS or DA calls.

### 3.4 Check that it works

- A request with the right key that reaches DA logs `ims.token.requesting` then `ims.token.issued`. The next one logs `ims.token.cache_hit`.
- Logs are JSON lines in the terminal. There are no log files. To save a copy: `npm run local 2>&1 | tee eds-local.log`.

### 3.5 Deploy

Stage and Production deployment (Cloud Manager config pipeline, six secret variables, `aio aem edge-functions deploy`) is in [edge-functions/README.md section 8](edge-functions/README.md#8-deploy-to-adobe-cloud-manager-stage-and-production). Deploy config first, Stage before Main, and do not skip the Stage smoke tests.

## 4. App Builder action (original implementation)

### 4.1 Install

```bash
cd driv-servlets-migration
npm ci            # use `npm install` if the lockfile is incompatible
```

### 4.2 Configure `.env`

There is **no `.env.example` at the repo root**. Create `.env` by hand using the template below. **Secrets are intentionally redacted**; obtain fresh values from the Adobe workspace administrator. Never reuse credentials that were previously pasted into chat, tickets or ZIP files. Rotate them.

```dotenv
# Adobe App Builder Runtime (Stage)
AIO_runtime_auth=<ROTATED_STAGE_RUNTIME_AUTH>
AIO_runtime_namespace=235943-edssheetservice-stage
AIO_runtime_apihost=https://adobeioruntime.net

# Token 1: Postman -> App Builder
APP_BUILDER_CLIENT_ID=<STAGE_OAUTH_CLIENT_ID>
APP_BUILDER_CLIENT_SECRET=<ROTATED_STAGE_OAUTH_CLIENT_SECRET>
APP_BUILDER_SCOPES=openid,AdobeID,additional_info.projectedProductContext,read_organizations,aem.frontend.all
APP_BUILDER_IMS_ORG=6ED976C95CFFA6810A495C73@AdobeOrg
APP_BUILDER_IMS_TOKEN_URL=https://ims-na1.adobelogin.com/ims/token/v3

# Token 2: App Builder -> DA Source API
DA_OAUTH_S2S_CONFIRMED=false
DA_OAUTH_CLIENT_ID=<DA_AUTHORIZED_OAUTH_CLIENT_ID>
DA_OAUTH_CLIENT_SECRET=<ROTATED_DA_OAUTH_CLIENT_SECRET>
DA_OAUTH_SCOPES=<SCOPES_APPROVED_FOR_DA_ACCESS>
DA_ORG=rohannaikcodeandtheory
DA_REPO=aem-eds-sheet-manager
DA_ALLOW_MANUAL_TOKEN=false
```

- Set `DA_OAUTH_S2S_CONFIRMED=true` **only after** the credential has been proven to authenticate and be authorized for the target DA repository. While it is `false`, the action deliberately returns `DA_AUTH_NOT_CONFIGURED`.
- `DA_ALLOW_MANUAL_TOKEN=true` is only for controlled Stage diagnostics. Keep it `false` otherwise, and always in production.
- `app.config.yaml` maps these values into encrypted, `final: true` action parameters, so a caller cannot override them.
- If you already have a working `.env`, do not overwrite it.

### 4.3 Sign in and select the Stage workspace

```bash
aio login
aio console org select        # Code and Theory Amer Partner Sandbox
aio console project select    # EDS Sheet Service (EDSSheetService)
aio console workspace select  # Stage
aio app use
aio where                     # verify it says Stage before deploying
```

### 4.4 Deploy

```bash
aio app deploy
aio rt:action:get eds-sheet-service/create-eds-sheet --url   # get the real action URL
```

Stage web app: `https://235943-edssheetservice-stage.adobeio-static.net/index.html`. A successful deploy does not mean DA access works.

### 4.5 Operations

| Operation | Purpose |
|---|---|
| `createSheet`, `getSheet`, `listSheets`, `replaceSheet` | Basic sheet CRUD |
| `appendRows`, `updateRows`, `deleteRows` | Row-level changes (`deleteRows`, `updateRows` need a key field) |
| `deleteSheet` | Needs `confirm: "DELETE <path>"` |
| `createFolder` | Create a DA folder |
| `createOrAppendSheet` | Create or append to a single-tab sheet |
| `manageAsset`, `manageAssets` | One or many asset events (`created`, `updated`, `deleted`, `moved`) |
| `getAsset`, `getAssetMetadata` | Read an asset back as nested JSON, or only its metadata |
| `ingestAssetSheet` | Flattened asset row, with the event type in the top-level `action` |
| `resolveDamAssetPath` | Resolve the DAM path only, with no writes |

- The client sends `action` (`created`, `updated`, `moved`, `deleted`) at the top level. It controls the operation and is **not** stored as a sheet column.
- Brand sheets are written to `{language}/{brand}.json`, for example `en_us/rancho.json`.
- Always test with `dryRun: true` before live writes.
- Postman: `postman/EDS_Auto_Sheets_Postman_Collection.json` and `postman/EDS-Sheet-Service-Stage.postman_environment.json`. Put rotated credentials in the environment **locally** only.
- Optional helper: `node --env-file=.env scripts/get-app-builder-token.js` proves Token 1 can be issued. It prints only the expiry, not the token.

## 5. How authentication and tokens work

There are always **two separate tokens**.

1. **Token to call the service.**
   - Edge Function: not an Adobe token. It is our own `INBOUND_API_KEY`, sent as `x-api-key`.
   - App Builder action: an Adobe IMS token. Postman obtains it with `APP_BUILDER_*`.
2. **Token the service uses to call DA.** An IMS `client_credentials` token, requested by the service itself.

Token 2 lifecycle (the same in both implementations, in `edge-functions/src/ims.js` and `actions/create-eds-sheet/da-auth.js`):

- It is requested only when none is cached or the cached one is near expiry.
- It is stored **in memory** only. Nothing is written to disk or a database. It is lost on a cold start or restart, and each instance holds its own.
- **Expiry is clock-based:** valid until `expires_in` minus a safety margin (the smaller of 60 seconds or 10%). Nothing decodes the token.
- If DA returns 401, the cache is cleared and the next call gets a new token. In the Edge Function, only `GET` is retried automatically. Writes are never replayed.
- There is no refresh token. Renewal means a new `client_credentials` request.
- Concurrent callers share one in-flight request.

**Local versus production (Edge Function)**

| | Local | Production |
|---|---|---|
| Secrets | `.env` | Cloud Manager secret variables, read through `SecretStore` |
| Scopes | `IMS_SCOPES` in `.env` | `IMS_SCOPES_STAGE` or `IMS_SCOPES_MAIN` |
| Environment | always STAGE, `127.0.0.1` | chosen by the exact request hostname |
| Log level | `debug` | `info` |

Token lifecycle log events (`ims.token.requesting`, `cache_hit`, `issued`, `invalidated`, `failed`) are listed in [edge-functions/README.md section 3](edge-functions/README.md#3-how-the-ims-token-works-local-vs-production). In `ims.token.issued`, a changed `fingerprint` means a new token was generated.

## 6. Tests

| Where | Command | Notes |
|---|---|---|
| Edge Function | `cd edge-functions && npm test` | Runs `node --test test/*.test.js`. No credentials needed. Includes `test/ims.test.js` for token expiry. |
| Edge Function syntax | `cd edge-functions && npm run check` | |
| App Builder action | `node --test test/*.test.js` (repo root) | 29 tests passing at the time of writing |

> **Known issue:** `npm test` at the repo root is broken. [package.json](package.json) lists `test/sheet-manager.test.js`, `test/da-auth.test.js`, `test/asset-manager.test.js` and `test/auto-sheet.test.js`, and none of those files exist, so it fails with "Could not find ...". Use `node --test test/*.test.js` until the script is fixed. `npm run lint` only runs `node --check` on four action files that are present, and `npm run e2e` needs a live deployment.

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `EADDRINUSE 127.0.0.1:7676` (Edge Function local) | An earlier server is still running. `lsof -nP -iTCP:7676 -sTCP:LISTEN`, then `kill <PID>`, or run `PORT=7677 npm run local`. The server now prints these hints itself. |
| `401 UNAUTHORIZED` from the Edge Function | The `x-api-key` header is missing or differs from `INBOUND_API_KEY`. This is the inbound key check, before any IMS call. The browser address bar cannot send the header, so use the console or curl. Restart the server after editing `.env`. |
| `503 INBOUND_AUTH_NOT_CONFIGURED` | `INBOUND_API_KEY` is missing or shorter than 32 characters. |
| `502 IMS_NOT_CONFIGURED` / `IMS_TOKEN_FAILED` | `IMS_CLIENT_ID`, `IMS_CLIENT_SECRET` or `IMS_SCOPES` is missing or wrong. The log field `adobeError` gives the reason (`invalid_client`, `invalid_scope`, and so on). |
| `502 DA_AUTH_FAILED` / DA 401 or 403 | The token was rejected, or the technical account lacks DA permission on the repository. IMS issuing a token does not prove DA access. |
| `missing Adobe I/O Runtime namespace` (App Builder) | Run `aio app use`, confirm the workspace is Stage, and check the `AIO_runtime_*` keys. |
| `DA_AUTH_NOT_CONFIGURED` (App Builder) | The `DA_OAUTH_S2S_CONFIRMED` gate is off. This is deliberate. Do not remove it. |
| `Could not find 'test/sheet-manager.test.js...'` | See the known issue in section 6. |
| `npm audit` warnings | Review them. Avoid `npm audit fix --force` without testing. |

App Builder Runtime logs:

```bash
aio rt activation list --limit 5
aio rt activation logs <ACTIVATION_ID>
```

Redact credentials and tokens before sharing any output.

## 8. Git and secret safety

- Never commit `.env`, `.aio/`, `.aws.tmp.creds.json`, Runtime auth keys, OAuth secrets, access tokens or exported credential files. [.gitignore](.gitignore) already covers these (`.env*`, `.aio`, `dist`, `node_modules`, `.aws.tmp.creds.json`).
- **`.aws.tmp.creds.json` and `dist/last-built-actions.json` appear in this repo's git history** (they were changed in an earlier commit). Ignoring a file now does not remove it from history. Check whether any real credential was committed, rotate it if so, and follow the secret-remediation process with the security team (helpdesk@codeandtheory.com).
- The original Edge Function delivery contained real credentials in `edgeFunctions.yaml` and `.env`. Those secrets must be rotated if they have not been. Never use an IMS bearer token as `x-api-key`.
- Do not put the inbound API key in frontend code or a public page. The console asks the user to type it.

## 9. Repository map

```
.
├── README.md                  this file
├── app.config.yaml            App Builder action config (maps .env to action inputs)
├── package.json               root scripts (see the known test issue)
├── actions/create-eds-sheet/  App Builder action: index, da-auth, asset-manager,
│                              auto-sheet, asset-flat-sheet, dam-path-resolver
├── web-src/                   App Builder web shell
├── test/                      unit tests for the action (node --test)
├── e2e/                       jest e2e tests (need a live deployment)
├── postman/, examples/        Postman collections and sample payloads for the action
├── scripts/                   get-app-builder-token.js (optional Token 1 helper)
├── docs/                      design notes for the action (see section 10)
└── edge-functions/            the Edge Function project
    ├── README.md              full developer guide, code workflow, deployment
    ├── src/                   handler, ims, da, sheet, event, brand, read, logger
    ├── blocks/                EDS Sheet Console frontend block
    ├── preview/               local page hosting the block
    ├── config/                Cloud Manager edgeFunctions.yaml and cdn.yaml
    ├── postman/               collections for the Edge Function
    └── test/                  node --test suites
```

## 10. Further documents

- [edge-functions/README.md](edge-functions/README.md): the main developer guide for the Edge Function
- [edge-functions/RAW-ACTION-INTEGRATION.md](edge-functions/RAW-ACTION-INTEGRATION.md): raw `action` events and `language/brandName` routing
- [edge-functions/CREATE-APPEND-GUIDE.md](edge-functions/CREATE-APPEND-GUIDE.md) and [edge-functions/PRODUCTION-CHECKLIST.md](edge-functions/PRODUCTION-CHECKLIST.md)
- `docs/ACTION-DRIVEN-INGESTION.md`, `docs/BRAND-SHEET-ROW-INGESTION.md`, `docs/DIRECT-ASSET-PAYLOAD.md`, `docs/DYNAMIC-SHEET-AND-DAM-PATH.md`, `docs/FLAT-ASSET-SHEET.md`: App Builder action design notes
- `README-ACTION-EXCLUSION.md` and `README-DEPLOYMENT-PATCH.md`: older patch notes. They describe copying files into an existing project and are partly historical.
- External: [DA Source API](https://docs.da.live/developers/api/source), [DA Move API](https://docs.da.live/developers/api/move), [AEM Edge Functions](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/developing/edge-functions)

> Unverified: the Stage namespace, org ID and workspace names above come from the previous README and have not been re-checked against Adobe Developer Console. A fresh-clone setup was not performed for this update. Ask the project admin to confirm them before relying on them.
