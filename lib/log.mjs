// Logger that never prints secrets.
const SECRET_KEYS = new Set([
  'authorization', 'cookie', 'set-cookie', 'password', 'code', 'code_verifier',
  'id_token', 'access_token', 'refresh_token', 'idtoken', 'refreshtoken',
]);

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
      .replace(/([?&](code|password|code_verifier)=)[^&\s"]+/g, '$1[redacted]');
  }
  return value;
}

export function log(event, details = {}) {
  const line = { t: new Date().toISOString(), event, ...redact(details) };
  console.log(JSON.stringify(line));
}
