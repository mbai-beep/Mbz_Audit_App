/* Lightweight Google service-account auth + fetch helpers.
   Replaces full `googleapis` (~85 MB) with `google-auth-library` (~5 MB)
   so each Vercel function bundle stays small. We talk to Drive v3 and
   Sheets v4 via raw HTTPS — only the endpoints we actually use. */

const { GoogleAuth } = require('google-auth-library');

let _authCache = null;
function getAuth(scopes) {
  // Re-use a single GoogleAuth instance per cold start
  if (_authCache && _authCache.scopes === scopes) return _authCache.auth;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  let creds;
  try { creds = JSON.parse(raw); }
  catch (_) {
    try { creds = JSON.parse(raw.replace(/\n/g, '\\n').replace(/\r/g, '')); }
    catch (e) { console.error('[_google] bad GOOGLE_SERVICE_ACCOUNT:', e.message); return null; }
  }
  const auth = new GoogleAuth({ credentials: creds, scopes: [scopes] });
  _authCache = { scopes, auth };
  return auth;
}

async function getAccessToken(scope) {
  const auth = getAuth(scope);
  if (!auth) throw new Error('GOOGLE_SERVICE_ACCOUNT not configured');
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('failed to obtain access token');
  return token;
}

async function googleFetch(url, opts = {}, scope) {
  const token = await getAccessToken(scope);
  const headers = Object.assign({ Authorization: `Bearer ${token}` }, opts.headers || {});
  const r = await fetch(url, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Google API ${r.status} ${r.statusText}: ${body.slice(0, 500)}`);
  }
  return r;
}

module.exports = { getAuth, getAccessToken, googleFetch };
