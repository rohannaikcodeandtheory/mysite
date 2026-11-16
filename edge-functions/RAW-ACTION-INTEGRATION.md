# Raw `action` webhook: DA sheet path from `language/brandName`

## Payload mapping

Send raw JSON as the HTTP POST body. `action` is one of `create`, `updated`, `deleted`, `moved` (`created` is accepted as an alias).

**No** top-level `operation`, `path`, or `sheetData` fields required.

The source folder is fixed to `data/`; `metadata.language` is the subfolder; `metadata.brandName` is the sheet **filename** (case preserved, `.json` extension appended):

- `metadata.language: "de_DE"`, `metadata.brandName: "Rancho"` → **`data/de_DE/Rancho.json`**
- `metadata.language: "en_US"`, `metadata.brandName: "Monroe"` → **`data/en_US/Monroe.json`**

On `create`, the service creates `data` and `data/<language>` if missing and appends one row for `assetID`. On subsequent events, one existing row is updated or deleted; other rows in the brand sheet are preserved.

**Caution:** DA Source API persists the full JSON sheet on POST. This uses read-modify-write, *not an atomic row update*. The in-memory serial queue protects only calls reaching the same warm Node/Fastly instance. Simultaneous requests reaching different edge instances can overwrite each other's changes. For production ingestion with concurrent events, place a durable per-sheet serial queue (or other transactional storage/worker) before this handler. Do **not** treat this implementation alone as a concurrency-safe production event processor.

## Action semantics

| `action` | Behavior | Missing asset |
|---|---|---|
| `create` | Append by `assetID`; exact repeat succeeds as unchanged, changed duplicate is HTTP 409 | Create sheet and folder |
| `updated` | Replace one row by `assetID`, preserving all other rows | HTTP 404 |
| `deleted` | Remove one row by `assetID`, preserving the sheet even if empty | Success, unchanged (idempotent) |
| `moved` | Move **one row** between brand sheets; requires `previousLocation` | HTTP 404 |

For `moved`, send `previousLocation: { "language": "de_DE", "brandName": "Rancho" }` and new `metadata.language`, `metadata.brandName`. `moved` is a two-file operation (destination write then source update), **not atomic**. If removal from the source fails, the response indicates `PARTIAL_MOVE` with both paths so you can reconcile manually before retrying. **Do not** blindly replay failures.

## Stored columns

- All input fields except top-level `action`, optional top-level `dryRun`, and routing-only `previousLocation` are retained.
- Nested objects are flattened into sheet columns, e.g. `metadata.brandName`, `metadata.partListingImageUrl`.
- `partNumbers` (including A/B/C operations) is stored as a JSON string in **one** `partNumbers` cell (losslessly; not three rows).
- `netChange: false`, dates, empty strings and all other supplied metadata are preserved.
- `assetID` is the unique row key within a brand sheet. Any duplicate IDs already in a sheet cause HTTP 409.
- For safe deterministic names, `language` and `brandName` currently allow only `A–Z`, `a–z`, digits, `_`, `-` (length <= 80). No slashes, whitespace, periods or `%`. Other brand names return `INVALID_ASSET_ROUTE`; decide an explicit agreed mapping before enabling them.
- Upper limit 256 KiB generated/request JSON, 1,000 rows and 200 columns per sheet. Exceeding limits returns an error, rather than silently truncating.

## Local development (real IMS → DA)

1. `npm ci`
2. `cp .env.example .env`
3. Set `IMS_CLIENT_ID`, `IMS_CLIENT_SECRET`, `IMS_SCOPES` from the *working* OAuth Server-to-Server credential; set `DA_ORG`, `DA_SITE`, and `INBOUND_API_KEY` (use `openssl rand -hex 32`). Keep `.env` out of Git. Rotate any previously exposed credentials.
4. `npm test && npm run check`
5. `node --env-file=.env scripts/preflight.mjs` to verify IMS and DA read access.
6. `npm run local`
7. Import `postman/DA-Raw-Asset-Events.postman_collection.json`, set `baseUrl=http://127.0.0.1:7676` and `apiKey=<INBOUND_API_KEY>`.
8. Run a **dry run first**: include `"dryRun": true` in a copy of `examples/create.json`. This validates only; no IMS or DA request.
9. Remove `dryRun` or set false and test a **disposable brand / language** with write permission; do not start with the production `Rancho` file. Test `create`, `updated`, `moved`, `deleted` in sequence and inspect `https://admin.da.live/source/<org>/<site>/data/<language>/<brand>.json`.

For example, request:

```http
POST http://127.0.0.1:7676/api/eds-sheets
Content-Type: application/json
x-api-key: <INBOUND_API_KEY>
```

Body: see `examples/create.json` (all metadata fields, three part numbers).

Success example:

```json
{ "success": true, "action": "create", "assetID": "I-NA-BCKM-4109045", "path": "data/de_DE/Rancho.json", "total": 1 }
```

## Deployment realities

`src/index.js` is the Adobe/Fastly entry point, using managed config and secret stores. `src/local-server.js` is a Node loopback adapter using `.env`. They use the **same** `src/handler.js` / `src/event.js` logic.

The current `config/edgeFunctions.yaml` and `config/cdn.yaml` are STAGE/MAIN templates and still contain `stage.example.com` and `production.example.com`; replace with real mapped domains in an eligible non-Sandbox program before deploying. See `README.md` and `PRODUCTION-CHECKLIST.md`.

**Cloud Manager Sandbox warning:** Adobe's Sandbox Edge Function runtime does not provision Config Store / Secret Store. This ZIP's authenticated edge entry point cannot perform **real** IMS → DA writes on that Sandbox as-is. To smoke test hosted execution, use the separate no-secrets Sandbox smoke-test package; real writes should be tested with the local Node adapter or a provisioned non-Sandbox environment. Never embed Client Secrets or bearer tokens in code to circumvent this restriction.

## Safeguards

- Caller must send server-side `x-api-key`, not IMS token.
- Request body cannot choose target repository, destination URL, or bearer token.
- Never place the inbound key into a public EDS browser script; restrict who can call the endpoint.
- DA `403` indicates missing permission; a `200` read alone is not proof of write access.
- Keep the original `operation` + `path` + `sheetData` format available as backward-compatible legacy API.

Adobe APIs: https://docs.da.live/developers/api/source and https://docs.da.live/developers/api/move
