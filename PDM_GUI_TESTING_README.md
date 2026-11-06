# DRiV PDM API GUI — EDS `mysite` integration

## What changed

This archive preserves the uploaded `mysite-main.zip` site and adds only:

- `blocks/parts-finder/parts-finder.js`: EDS block with cascading Year → Make → Model → Parts; environment selection; Health and direct API tests; sanitized JSON response viewer, HTTP status, latency and request ID.
- `blocks/parts-finder/parts-finder.css`: styling for the diagnostic block.
- `pdm-api-test.html`: a standalone development GUI at `/pdm-api-test.html` when served from the repository root by a static HTTP server; it does not require DA authoring.
- `PDM_GUI_TESTING_README.md`: this guide.

The block is copied from the previously delivered `mysite-edge-functions-PDM-final-reviewed.zip`. No Edge Function code, secrets, or `PDM_API_TOKEN` are changed in this website package.

## Option A: local GUI (simplest)

1. Unzip this archive and open Terminal in the extracted directory.
2. In a *separate* Terminal, start your Edge Functions project using its documented command (`aio aem edge-functions serve`). Check `curl -i http://127.0.0.1:7676/api/catalog/health`.
3. Serve the EDS repository root using `python3 -m http.server 3000` (or another static HTTP server). This serves the dedicated diagnostic HTML directly, without needing a DA page.
4. Open `http://localhost:3000/pdm-api-test.html`.
5. Select **Local Edge Function (127.0.0.1:7676)**. Click **Test API health**, then select **Groups 2,8** to load Years, then Make, Model and Find Parts.
6. For direct tests choose a route, add parameters such as `year_id=<actual ID>`, and click **Test selected API**.

**CORS caveat:** Browser fetches from `localhost:3000` to `127.0.0.1:7676` are cross-origin. The GUI can show `Failed to fetch` even if curl works. Set up an approved local same-origin reverse proxy for `/api/catalog/*` to the Edge Function, or configure development-only CORS on the API. Do not add permissive production CORS. With a proxy, select **Deployed / same-origin** in the GUI even locally.

## Option B: test a real EDS block on DA

1. Copy/commit `blocks/parts-finder/` to your `mysite` GitHub repository and wait for AEM Code Sync.
2. Open `https://da.live`, navigate to the correct org/site, create a document named `pdm-api-test`.
3. Insert a **one-column block table** with the first row `Parts Finder` and a second row `API testing`. Save and preview the page.
4. Open the resulting `https://main--mysite--<github-owner>.aem.page/pdm-api-test` URL (replace owner with your actual configured GitHub owner). Verify the block is decorated; the first row must be the block name.
5. Choose **Deployed / same-origin** and click **Test API health**. The EDS CDN must already route `/api/catalog/*` to the deployed Edge Function. Otherwise it will return 404 or HTML, which is a deployment/routing issue, not a block issue.
6. For **local API** from a remote DA preview, a browser cannot reliably reach your Mac's `127.0.0.1` on other devices, and HTTPS-to-HTTP/mixed-content/CORS restrictions can apply. Use the local GUI in Option A instead.

## Verify errors

- Health returns 200: Edge Function is reachable; this is not proof that upstream PDM is healthy.
- Years returns 200 with `years: []`: request completed, but filters/brand mapping/data need verification.
- HTTP 400: inspect required IDs and parameters.
- HTTP 502: inspect Edge Function upstream logs (PDM status/auth/invalid JSON).
- HTTP 503: inspect missing runtime configuration.
- HTTP 404/HTML: check deployed CDN routing and function deployment.
- `Network/CORS error`: check local server, proxy, CORS, HTTPS.
- Parts fails with configuration error: verify actual `PDM_DYNAMIC_SUB_CONFIG_TYPES` value.

## Security and limitations

Do not expose tokens in browser code, URL query strings or logs. The diagnostic page is for development; remove or restrict it before production release. Corporate brand-code mapping, dynamic config values and AEM DAM/Content Fragment enrichment are still migration dependencies. This package does not deploy to GitHub, DA or Fastly automatically.
