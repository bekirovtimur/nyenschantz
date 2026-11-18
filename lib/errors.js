export function sendError(response, status, code, message) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}
