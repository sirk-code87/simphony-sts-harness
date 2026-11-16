// Live STS Gen2 authentication: Authorization Code flow with PKCE, scripted server-side.
// Source: https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/authenticate.html
// UNTESTED against a live tenant (no credentials yet). The cookie hand-off between
// /authorize and /signin is the step most likely to need adjustment.
import crypto from 'node:crypto';
import { log } from './log.mjs';

const REDIRECT_URI = 'apiaccount://callback';
const DAY = 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(stage, status, detail) {
    super(`Auth failed at ${stage} (HTTP ${status})`);
    this.stage = stage;
    this.status = status;
    this.detail = detail;
  }
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function cookieHeader(res) {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function readBody(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text.slice(0, 500); }
}

export function createLiveAuth(cfg) {
  let tokens = null;
  let consecutiveFailures = 0;

  const base = () => cfg.authHost.replace(/\/+$/, '');
  const oidc = (p) => `${base()}/oidc-provider/v1/oauth2/${p}`;

  function store(json) {
    if (!json.id_token) throw new AuthError('token', 200, 'Response had no id_token');
    const now = Date.now();
    tokens = {
      idToken: json.id_token,
      refreshToken: json.refresh_token ?? tokens?.refreshToken ?? null,
      expiresAt: jwtExpiry(json.id_token) ?? now + (json.expires_in ? json.expires_in * 1000 : 14 * DAY),
      refreshExpiresAt: json.refresh_token ? now + 28 * DAY : tokens?.refreshExpiresAt ?? null,
    };
  }

  async function login({ force = false } = {}) {
    if (consecutiveFailures >= 2 && !force) {
      throw new AuthError('guard', 0,
        'Two failed sign-ins in a row. A third may lock the account for 30 minutes. Check .env, then retry with force.');
    }
    try {
      const verifier = crypto.randomBytes(48).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

      // 1. authorize: establishes the session cookies used by signin.
      const authUrl = new URL(oidc('authorize'));
      authUrl.search = new URLSearchParams({
        response_type: 'code', client_id: cfg.clientId, scope: 'openid',
        redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256',
      });
      const r1 = await fetch(authUrl, { redirect: 'manual' });
      if (r1.status >= 400) throw new AuthError('authorize', r1.status, await readBody(r1));
      const cookies = cookieHeader(r1);

      // 2. signin: username, password, orgname with the cookies from authorize.
      const r2 = await fetch(oidc('signin'), {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
        body: new URLSearchParams({ username: cfg.username, password: cfg.password, orgname: cfg.orgShortName }),
      });
      const j2 = await readBody(r2);
      if (!r2.ok || typeof j2 !== 'object' || !j2.redirectUrl) throw new AuthError('signin', r2.status, j2);
      const code = new URL(j2.redirectUrl).searchParams.get('code');
      if (!code) throw new AuthError('signin', r2.status, 'redirectUrl had no code');

      // 3. token: exchange the code with the PKCE verifier.
      const r3 = await fetch(oidc('token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, code_verifier: verifier,
          client_id: cfg.clientId, scope: 'openid', redirect_uri: REDIRECT_URI,
        }),
      });
      const j3 = await readBody(r3);
      if (!r3.ok || typeof j3 !== 'object') throw new AuthError('token', r3.status, j3);
      store(j3);
      consecutiveFailures = 0;
      log('auth.login.ok', { expiresAt: new Date(tokens.expiresAt).toISOString() });
      return status();
    } catch (err) {
      if (!(err instanceof AuthError) || err.stage !== 'guard') consecutiveFailures++;
      log('auth.login.fail', { stage: err.stage, status: err.status, detail: err.detail ?? err.message });
      throw err instanceof AuthError ? err : new AuthError('network', 0, err.message);
    }
  }

  async function refresh() {
    if (!tokens?.refreshToken) throw new AuthError('refresh', 0, 'No refresh token; log in first');
    const r = await fetch(oidc('token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: tokens.refreshToken,
        client_id: cfg.clientId, scope: 'openid', redirect_uri: REDIRECT_URI,
      }),
    });
    const j = await readBody(r);
    if (!r.ok || typeof j !== 'object') throw new AuthError('refresh', r.status, j);
    store(j);
    log('auth.refresh.ok', { expiresAt: new Date(tokens.expiresAt).toISOString() });
    return status();
  }

  function status() {
    return {
      authenticated: !!tokens && tokens.expiresAt > Date.now(),
      expiresAt: tokens?.expiresAt ?? null,
      refreshExpiresAt: tokens?.refreshExpiresAt ?? null,
      consecutiveFailures,
    };
  }

  return {
    login, refresh, status,
    logout() { tokens = null; return status(); },
    bearer() { return tokens && tokens.expiresAt > Date.now() ? tokens.idToken : null; },
  };
}

// Mock auth: same surface, no network. Token string is fixed so curl works against /mock.
export const MOCK_TOKEN = 'mock-token';
export function createMockAuth() {
  let state = null;
  const status = () => ({
    authenticated: !!state && state.expiresAt > Date.now(),
    expiresAt: state?.expiresAt ?? null,
    refreshExpiresAt: state?.refreshExpiresAt ?? null,
    consecutiveFailures: 0,
  });
  const issue = () => {
    const now = Date.now();
    state = { expiresAt: now + 14 * DAY, refreshExpiresAt: now + 28 * DAY };
    return status();
  };
  return {
    login: async () => issue(),
    refresh: async () => {
      if (!state) throw new AuthError('refresh', 0, 'No refresh token; log in first');
      return issue();
    },
    status,
    logout() { state = null; return status(); },
    expire() { if (state) state.expiresAt = Date.now() - 1; return status(); },
    bearer() { return state && state.expiresAt > Date.now() ? MOCK_TOKEN : null; },
  };
}
