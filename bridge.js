import http from 'node:http';
import { spawn } from 'node:child_process';
import httpProxy from 'http-proxy';

const PORT = process.env.XHOST_HTTP_PORT || process.env.PORT || 8080;
const INTERNAL_PORT = 8091;

process.on('exit', (code) => console.error(`[proc] main process exiting with code ${code}`));
process.on('SIGTERM', () => { console.error('[proc] received SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { console.error('[proc] received SIGINT'); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('[proc] uncaughtException', err); });
process.on('unhandledRejection', (err) => { console.error('[proc] unhandledRejection', err); });

// mcp-proxy wraps our OWN stdio MCP server (unified-server.js), which in turn
// talks to the two upstream stdio servers internally.
const child = spawn(
  'node_modules/.bin/mcp-proxy',
  [
    '--port', String(INTERNAL_PORT),
    '--host', '127.0.0.1',
    '--server', 'stream',
    '--streamEndpoint', '/mcp',
    'node', 'unified-server.js',
  ],
  { stdio: 'inherit' }
);

child.on('exit', (code) => {
  console.error(`mcp-proxy child exited with code ${code}`);
  process.exit(code || 1);
});

const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  ws: true,
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id',
};

proxy.on('error', (err, req, res) => {
  console.error('proxy error', err);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  }
  if (res && res.end) res.end(JSON.stringify({ error: 'bad_gateway' }));
});

const NO_AUTH_MARKERS = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/openid-configuration',
  '/register',
];

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  console.log(`[req] ${req.method} ${req.url}`);

  if (path === '/' || path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
    res.end('ok');
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (NO_AUTH_MARKERS.some((marker) => path.includes(marker))) {
    res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'not_found', message: 'this server does not use OAuth' }));
    return;
  }

  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head);
});

setTimeout(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`bridge listening on ${PORT}, proxying /mcp to internal :${INTERNAL_PORT}`);
  });
}, 1200);
