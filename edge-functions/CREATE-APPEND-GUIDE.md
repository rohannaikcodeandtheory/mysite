# Raw `action: "create"` — append to existing brand sheet

**Postman:** POST `/api/eds-sheets` with `Content-Type: application/json`, `x-api-key: <INBOUND_API_KEY>` and **no Authorization bearer token**.

```json
{
  "assetID": "I-NA-BCKM-4109046",
  "action": "create",
  "netChange": false,
  "metadata": { "language": "de_DE", "brandName": "Rancho", "title": "Second asset" },
  "partNumbers": [{ "operation": "A", "partNumber": "410899" }]
}
```

Target path: `data/de_DE/Rancho.json`.

- If folder and sheet do not exist, create them and write 1 row. Response: `result=created_sheet`, `total=1`.
- If folder and sheet already exist, read sheet, append row, then PUT the **entire sheet**. Response: `result=appended`, `appended=true`, `previousTotal=N`, `total=N+1`. Existing rows are preserved.
- If the same `assetID` arrives again with identical data, return success `unchanged=true` (no duplicate row). If its payload differs, return HTTP 409; use `action=updated` to replace that row.
- `created` remains an alias for `create` for older callers; use `create` in new payloads.

## Local test

```bash
cd edge-functions
cp .env.example .env # if you do not already have a private .env
# Edit .env with working IMS credentials, scopes, DA org/site and inbound API key
npm ci
npm test
npm run check
npm run local
```

Import `postman/DA-Raw-Asset-Events.postman_collection.json`; set `baseUrl=http://127.0.0.1:7676` and `apiKey=<INBOUND_API_KEY>`; run **Raw create (append)** twice with two distinct assetIDs.

**Caution:** This is read-modify-write and not atomic across edge workers. A single warm instance serializes events, but simultaneous writes across POPs can still lose a row. Use a durable queue keyed by sheet path before production high-volume ingestion.

**Sandbox:** Cloud Manager Sandbox does not provision the necessary secret store for live IMS/DA writes. Keep credentials off Git; use the Node local adapter for real DA testing or an eligible provisioned environment.
