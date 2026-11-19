import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const token = 'LiveToken_01';
const disabledToken = 'DeadToken_01';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nyenschantz-proxy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(new URL('../server.js', import.meta.url), join(directory, 'server.js'));
  cpSync(new URL('../lib/', import.meta.url), join(directory, 'lib'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  return directory;
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path, agent: false, ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('authenticated proxy preserves API behavior without exposing the prefix', { timeout: 20000 }, async (t) => {
  const directory = fixture(t);
  let upstreamCalls = 0;
  let finishStream;
  const upstream = http.createServer(async (req, res) => {
    upstreamCalls++;
    if (req.url.startsWith('/base/stream?')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      finishStream = () => res.end('data: last\n\n');
      res.write('data: first\n\n');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
    res.end(JSON.stringify({ path: req.url, headers: req.headers, body }));
  });
  upstream.listen(0, '127.0.0.2');
  await once(upstream, 'listening');
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const target = `http://127.0.0.2:${upstream.address().port}/base?fixed=1`;
  const routeConfig = { routes: Object.fromEntries(
    ['gemini', 'openrouter', 'telegram', 'cloudflare'].map((key) => [key, { target, description: `${key} API` }])
  ) };
  writeFileSync(join(directory, 'proxy.config.json'), JSON.stringify({
    ...routeConfig, privateMetadata: 'not-for-clients'
  }));
  writeFileSync(join(directory, 'users.json'), JSON.stringify({ users: {
    active: { token, disabled: false },
    disabled: { token: disabledToken, disabled: true }
  } }));

  let logs = '';
  const child = spawn(process.execPath, [join(directory, 'server.js')], {
    env: { ...process.env, DOMAIN: 'proxy.example.com', UPSTREAM_TIMEOUT_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  for (let attempt = 0; !logs.includes('Proxy listening on :3000'); attempt++) {
    assert.equal(child.exitCode, null, logs);
    assert.ok(attempt < 100, 'Proxy startup timed out');
    await delay(25);
  }

  await t.test('missing, wrong, disabled and encoded tokens return the same 404 without upstream traffic', async () => {
    const paths = ['/', '/gemini/models', '/openrouter/chat/completions', '/telegram/', '/cloudflare/',
      '/WrongToken01/gemini/', `/${disabledToken}/gemini/`, '/%4CiveToken_01/gemini/',
      `/${token.toLowerCase()}/gemini/`, `/${token}/unknown/`, `/${token}`];
    const expected = JSON.stringify({ error: { code: 'route_not_found', message: 'Route not found' } });
    for (const path of paths) {
      const result = await request(path, { method: 'POST', body: 'ignored' });
      assert.equal(result.status, 404);
      assert.equal(result.body, expected);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.match(result.headers['content-type'], /^application\/json/);
    }
    assert.equal(upstreamCalls, 0);
  });

  await t.test('route discovery requires an active token and never contacts upstream', async () => {
    const expected = JSON.stringify({ error: { code: 'route_not_found', message: 'Route not found' } });
    for (const path of ['/routes', '/WrongToken01/routes',
      `/${disabledToken}/routes`, '/%4CiveToken_01/routes']) {
      const result = await request(path);
      assert.equal(result.status, 404);
      assert.equal(result.body, expected);
    }
    const result = await request(`/${token}/routes?download=1`);
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(result.body));
    assert.deepEqual(JSON.parse(result.body), routeConfig);
    assert.ok(!result.body.includes(token));

    const head = await request(`/${token}/routes`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], result.headers['content-length']);

    const post = await request(`/${token}/routes`, { method: 'POST', body: 'ignored' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.equal(JSON.parse(post.body).error.code, 'method_not_allowed');
    assert.equal(upstreamCalls, 0);
  });

  await t.test('route discovery reports the running snapshot, not unapplied file changes', async () => {
    writeFileSync(join(directory, 'proxy.config.json'), '{"routes":{}}');
    const result = await request(`/${token}/routes`);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), routeConfig);
  });

  await t.test('all four routes require and strip the token', async () => {
    for (const key of ['gemini', 'openrouter', 'telegram', 'cloudflare']) {
      const result = await request(`/${token}/${key}/models?x=2`);
      assert.equal(result.status, 201);
      assert.equal(JSON.parse(result.body).path, '/base/models?fixed=1&x=2');
    }
  });

  await t.test('POST, raw path/query, provider headers and multiple cookies are preserved; Referer is removed', async () => {
    const result = await request(`/${token}/openrouter/a/../b?secret=query-value&x=%2F`, {
      method: 'POST', body: 'request body', headers: {
        authorization: 'Bearer provider-key', 'x-goog-api-key': 'gemini-key', cookie: 'client=1',
        referer: `https://proxy.example.com/${token}/openrouter/`,
        forwarded: 'for=untrusted', 'x-forwarded-for': 'untrusted'
      }
    });
    assert.equal(result.status, 201);
    const incoming = JSON.parse(result.body);
    assert.equal(incoming.path, '/base/a/../b?fixed=1&secret=query-value&x=%2F');
    assert.equal(incoming.body, 'request body');
    assert.equal(incoming.headers.authorization, 'Bearer provider-key');
    assert.equal(incoming.headers['x-goog-api-key'], 'gemini-key');
    assert.equal(incoming.headers.cookie, 'client=1');
    for (const name of ['referer', 'forwarded', 'x-forwarded-for']) assert.equal(incoming.headers[name], undefined);
    assert.ok(!result.body.includes(token));
    assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
  });

  await t.test('SSE is delivered before the upstream completes', async () => {
    const req = http.get(`http://127.0.0.1:3000/${token}/gemini/stream`, { agent: false });
    const [response] = await once(req, 'response');
    const received = once(response, 'data');
    const timer = new AbortController();
    const timeout = delay(2000, null, { signal: timer.signal }).then(() => { throw new Error('SSE was buffered'); });
    try {
      const [first] = await Promise.race([received, timeout]);
      assert.equal(first.toString(), 'data: first\n\n');
      const ended = once(response, 'end');
      finishStream();
      await ended;
    } finally {
      timer.abort();
      req.destroy();
    }
  });

  await t.test('HEAD errors have no body; logs contain neither credentials nor full URLs', async () => {
    const result = await request(`/${disabledToken}/gemini/`, { method: 'HEAD' });
    assert.equal(result.status, 404);
    assert.equal(result.body, '');
    await delay(30);
    for (const secret of [token, disabledToken, 'provider-key', 'gemini-key', 'query-value', 'request body']) {
      assert.ok(!logs.includes(secret), 'Request secrets must not be logged');
    }
    assert.ok(logs.includes('"route":"openrouter"'));
  });
});

test('missing or malformed users file prevents startup without logging its contents', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'proxy.config.json'), '{"routes":{}}');
  for (const invalid of [null, `{"users":{"token":"${token}" BROKEN`]) {
    if (invalid !== null) writeFileSync(join(directory, 'users.json'), invalid);
    const child = spawnSync(process.execPath, [join(directory, 'server.js')], {
      env: { ...process.env, DOMAIN: 'proxy.example.com' }, encoding: 'utf8', timeout: 3000
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Unable to read or parse users file/);
    assert.ok(!child.stderr.includes(token));
    assert.ok(!child.stdout.includes('Proxy listening'));
  }
});
