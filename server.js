import http from 'node:http';
import { loadRouteConfig, loadRoutes, resolveRoute } from './lib/route-table.js';
import { forward } from './lib/forwarding.js';
import { sendError } from './lib/errors.js';
import { loadUsers, authenticatePath } from './lib/access.js';

const config = loadRouteConfig();
const routes = loadRoutes(config);
// Publish only route metadata from the same snapshot used for forwarding.
const routesBody = JSON.stringify({ routes: Object.fromEntries(
  [...routes.keys()].map((key) => {
    const { target, description } = config.routes[key];
    return [key, { target, ...(typeof description === 'string' ? { description } : {}) }];
  })
) }, null, 2);
const users = loadUsers();
const domain = process.env.DOMAIN;
if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain)) throw new Error('DOMAIN must be a hostname');
const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
  throw new Error('UPSTREAM_TIMEOUT_MS must be a positive integer <= 2147483647');
}
const blockedHosts = new Set([domain.toLowerCase(), 'localhost', '127.0.0.1', '[::1]', 'proxy', 'caddy']);
for (const [key, target] of routes) {
  if (blockedHosts.has(target.hostname.toLowerCase())) throw new Error(`Proxy loop in route: ${key}`);
}

const server = http.createServer((request, response) => {
  const started = performance.now();
  let route;
  response.on('finish', () => {
    console.info(JSON.stringify({
      event: 'request', method: request.method, route: route?.key || null,
      status: response.statusCode, durationMs: Math.round(performance.now() - started)
    }));
  });

  try {
    if (!request.url.startsWith('/')) {
      sendError(response, 400, 'bad_request', 'Invalid request path');
      return;
    }
    const authenticatedPath = authenticatePath(request.url, users);
    if (authenticatedPath !== null && authenticatedPath.split('?')[0] === '/routes') {
      request.resume();
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendError(response, 405, 'method_not_allowed', 'Method not allowed');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(routesBody)
      });
      response.end(request.method === 'HEAD' ? undefined : routesBody);
      return;
    }
    route = authenticatedPath === null ? null : resolveRoute(authenticatedPath, routes);
    if (!route) {
      request.resume();
      sendError(response, 404, 'route_not_found', 'Route not found');
      return;
    }
    forward(request, response, route, timeoutMs);
  } catch (error) {
    console.error(JSON.stringify({ event: 'internal_error', code: error.code || 'UNKNOWN' }));
    request.resume();
    sendError(response, 500, 'internal_error', 'Internal server error');
  }
});

server.keepAliveTimeout = 65000;

server.on('clientError', (_error, socket) => {
  if (socket.writable) {
    const body = JSON.stringify({ error: { code: 'bad_request', message: 'Invalid HTTP request' } });
    socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } else socket.destroy();
});

// Health checks stay inside the container and cannot bypass public routing.
const health = http.createServer((_request, response) => response.writeHead(200).end('ok'));
health.listen(3001, '127.0.0.1');
server.listen(3000, '0.0.0.0', () => console.info('Proxy listening on :3000'));

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  health.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
