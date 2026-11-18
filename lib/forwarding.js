import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { sendError } from './errors.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function sanitizeHeaders(source) {
  const dropped = new Set([
    ...HOP_BY_HOP_HEADERS,
    ...(source.connection || '').split(',').map((name) => name.trim().toLowerCase())
  ]);
  return Object.fromEntries(Object.entries(source).filter(([name]) => !dropped.has(name)));
}

export function forward(request, response, route, timeoutMs) {
  const headers = sanitizeHeaders(request.headers);
  headers.host = route.target.host;
  // Do not pass proxy metadata or a potentially token-bearing referrer upstream.
  for (const name of Object.keys(headers)) {
    if (name === 'referer' || name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
  }

  const transport = route.target.protocol === 'https:' ? https : http;
  const upstream = transport.request(route.target, {
    method: request.method,
    path: route.path,
    headers
  });

  const fail = (error) => {
    clearTimeout(headerTimer);
    request.unpipe(upstream);
    request.resume();
    upstream.destroy();
    const timedOut = error.code === 'ETIMEDOUT';
    console.error(JSON.stringify({ event: 'upstream_error', route: route.key, code: error.code || 'UNKNOWN' }));
    sendError(response, timedOut ? 504 : 502,
      timedOut ? 'upstream_timeout' : 'upstream_unavailable',
      timedOut ? 'Upstream request timed out' : 'Upstream request failed');
  };
  const timeout = () => upstream.destroy(Object.assign(new Error('Upstream timeout'), { code: 'ETIMEDOUT' }));
  const headerTimer = setTimeout(timeout, timeoutMs);
  upstream.setTimeout(timeoutMs, timeout);
  upstream.on('error', fail);
  upstream.on('response', (incoming) => {
    clearTimeout(headerTimer);
    response.writeHead(incoming.statusCode, sanitizeHeaders(incoming.headers));
    response.flushHeaders();
    pipeline(incoming, response, (error) => {
      if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(JSON.stringify({ event: 'stream_error', route: route.key, code: error.code || 'UNKNOWN' }));
      }
      if (error && !request.destroyed) request.resume();
    });
  });
  // WebSocket upgrades are deliberately not supported.
  upstream.on('upgrade', (_incoming, socket) => {
    socket.destroy();
    fail({ code: 'UNSUPPORTED_UPGRADE' });
  });
  response.on('close', () => upstream.destroy());
  request.on('aborted', () => upstream.destroy());
  request.on('error', () => upstream.destroy());
  request.pipe(upstream);
}
