// STS Gen2 test harness: static UI, auth endpoints, and a proxy that keeps tokens server-side.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveAuth, createMockAuth, AuthError, MOCK_TOKEN } from './lib/auth.mjs';
import { handleMock, resetMock } from './lib/mock.mjs';
import { log } from './lib/log.mjs';

const env = process.env;
const PORT = Number(env.PORT || 4870);
const HOST = '127.0.0.1';
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));

const liveCfg = {
  authHost: env.STS_AUTH_HOST ?? '', apiHost: (env.STS_API_HOST ?? '').replace(/\/+$/, ''),
  clientId: env.STS_CLIENT_ID ?? '', username: env.STS_USERNAME ?? '', password: env.STS_PASSWORD ?? '',
  orgShortName: env.STS_ORG_SHORT_NAME ?? '',
};
const REQUIRED_LIVE = { STS_AUTH_HOST: 'authHost', STS_API_HOST: 'apiHost', STS_CLIENT_ID: 'clientId', STS_USERNAME: 'username', STS_PASSWORD: 'password', STS_ORG_SHORT_NAME: 'orgShortName' };
const missingLive = Object.entries(REQUIRED_LIVE).filter(([, k]) => !liveCfg[k]).map(([name]) => name);

const auth = { mock: createMockAuth(), live: createLiveAuth(liveCfg) };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = body == null ? '' : isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Request body is not valid JSON'), { status: 400 }); }
}

const modeOf = (m) => (m === 'live' ? 'live' : 'mock');

function authFailure(err) {
  return { ok: false, stage: err.stage, status: err.status, detail: err.detail ?? err.message, message: err.message };
}

// Forward one API call. Returns a description of the exchange for the inspector.
async function proxy({ mode, method = 'GET', path = '', query = {}, headers = {}, body }, signal) {
  method = method.toUpperCase();
  if (!/^\/api\/v\d+\//.test(path)) return { ok: false, harnessError: 'Path must start with /api/v<n>/' };
  const started = performance.now();

  if (mode === 'mock') {
    const authHeader = auth.mock.bearer();
    const r = authHeader
      ? await handleMock({ method, path, query, headers, body })
      : { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body: null };
    const text = r.body == null ? '' : JSON.stringify(r.body);
    return { ok: true, mode, status: r.status, statusText: http.STATUS_CODES[r.status] ?? '', headers: { ...r.headers, 'x-harness-mock': '1' }, body: text, ms: Math.round(performance.now() - started), size: Buffer.byteLength(text) };
  }

  if (missingLive.length) return { ok: false, harnessError: `Live mode is not configured. Missing in .env: ${missingLive.join(', ')}` };
  const token = auth.live.bearer();
  if (!token) return { ok: false, harnessError: 'Not logged in to live (or the token has expired). Use Auth first.', authRequired: true };
  const url = new URL(liveCfg.apiHost + path);
  for (const [k, v] of Object.entries(query)) if (v !== '' && v != null) url.searchParams.set(k, v);
  const outHeaders = { Accept: 'application/json', ...headers, Authorization: `Bearer ${token}` };
  if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') outHeaders['Content-Type'] ??= 'application/json';
  try {
    const r = await fetch(url, {
      method, headers: outHeaders,
      body: body == null || method === 'GET' || method === 'HEAD' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const text = await r.text();
    log('proxy.live', { method, path, status: r.status });
    return { ok: true, mode, status: r.status, statusText: r.statusText, headers: Object.fromEntries(r.headers), body: text, ms: Math.round(performance.now() - started), size: Buffer.byteLength(text) };
  } catch (err) {
    log('proxy.live.error', { method, path, error: err.message });
    return { ok: false, networkError: `No response from server: ${err.cause?.message ?? err.message}`, ms: Math.round(performance.now() - started) };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  try {
    if (p === '/config' && req.method === 'GET') {
      return send(res, 200, {
        port: PORT,
        live: { configured: missingLive.length === 0, missing: missingLive, apiHost: liveCfg.apiHost || null },
        defaults: {
          live: { org: env.STS_ORG_SHORT_NAME ?? '', locRef: env.STS_LOC_REF ?? '', rvcRef: env.STS_RVC_REF ?? '', employeeRef: env.STS_EMPLOYEE_REF ?? '', orderTypeRef: env.STS_ORDER_TYPE_REF ?? '' },
          mock: { org: 'demo', locRef: '1001', rvcRef: '1', employeeRef: '1001', orderTypeRef: '1' },
        },
      });
    }

    const authMatch = p.match(/^\/auth\/(status|login|refresh|logout|expire)$/);
    if (authMatch) {
      const action = authMatch[1];
      const body = req.method === 'POST' ? await readJson(req) : {};
      const mode = modeOf(body.mode ?? url.searchParams.get('mode'));
      if (action === 'status') return send(res, 200, { ok: true, mode, ...auth[mode].status() });
      if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'POST required' });
      if (mode === 'live' && (action === 'login' || action === 'refresh') && missingLive.length) {
        return send(res, 200, { ok: false, stage: 'config', status: 0, detail: `Missing in .env: ${missingLive.join(', ')}` });
      }
      if (action === 'expire') {
        if (mode !== 'mock') return send(res, 400, { ok: false, message: 'Expire is mock-only' });
        return send(res, 200, { ok: true, mode, ...auth.mock.expire() });
      }
      if (action === 'logout') return send(res, 200, { ok: true, mode, ...auth[mode].logout() });
      try {
        const st = action === 'login' ? await auth[mode].login({ force: !!body.force }) : await auth[mode].refresh();
        return send(res, 200, { ok: true, mode, ...st });
      } catch (err) {
        if (err instanceof AuthError) return send(res, 200, authFailure(err));
        throw err;
      }
    }

    if (p === '/proxy' && req.method === 'POST') {
      const spec = await readJson(req);
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      return send(res, 200, await proxy({ ...spec, mode: modeOf(spec.mode) }, ac.signal));
    }

    if (p === '/mock/reset' && req.method === 'POST') { resetMock(); return send(res, 200, { ok: true }); }

    // Direct mock API, so "copy as curl" works in mock mode. Token: mock-token.
    if (p.startsWith('/mock/api/')) {
      const ok = req.headers.authorization === `Bearer ${MOCK_TOKEN}` && auth.mock.bearer();
      if (!ok) return send(res, 401, null, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : undefined;
      const r = await handleMock({ method: req.method, path: p.slice(5), query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const { 'content-type': _ct, ...rest } = r.headers;
      return send(res, r.status, r.body, rest);
    }

    if (req.method === 'GET') {
      const rel = normalize(p === '/' ? 'index.html' : p.slice(1));
      if (rel.startsWith('..')) return send(res, 403, 'Forbidden');
      try {
        const file = await readFile(join(PUBLIC, rel));
        return send(res, 200, file, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' });
      } catch {
        return send(res, 404, 'Not found');
      }
    }
    send(res, 404, { ok: false, message: 'Not found' });
  } catch (err) {
    log('server.error', { path: p, error: err.message });
    send(res, err.status ?? 500, { ok: false, message: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log('server.start', { url: `http://${HOST}:${PORT}`, live: missingLive.length ? `not configured (missing ${missingLive.join(', ')})` : 'configured' });
});
