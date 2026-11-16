/**
 * Node.js loopback adapter using EXACTLY the same createHandler() as Fastly.
 * Real secrets come from gitignored .env via node --env-file=.env.
 * NEVER listen on 0.0.0.0 or place an inbound key in frontend code.
 */
import { createServer } from 'node:http';
import { createHandler } from './handler.js';
import { MAX_REQUEST_BYTES } from './sheet.js';

const port = Number(process.env.PORT || 7676);
const handler = createHandler({
  getSecret: async (key) => process.env[key] || null,
  fetcher: fetch,
  settings: {
    org: process.env.DA_ORG || 'rohannaikcodeandtheory',
    site: process.env.DA_SITE || 'mysite',
    scopes: process.env.IMS_SCOPES || '',
    allowedHost: '127.0.0.1',
  },
});

const server = createServer(async (request, response) => {
  try {
    let size = 0;
    const chunks = [];
    for await (const part of request) {
      size += part.length;
      if (size > MAX_REQUEST_BYTES) {
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: false,
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 256 KiB' } }));
        return;
      }
      chunks.push(part);
    }
    const url = `http://127.0.0.1:${port}${request.url}`;
    const original = new Request(url, {
      method: request.method,
      headers: request.headers,
      ...(request.method !== 'GET' && request.method !== 'HEAD'
        ? { body: Buffer.concat(chunks) } : {}),
    });
    const result = await handler(original);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ success: false,
      error: { code: 'LOCAL_SERVER_ERROR', message: 'Local server request failed' } }));
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`EDS Sheet Service (loopback only): http://127.0.0.1:${port}/api/eds-sheets`);
});
