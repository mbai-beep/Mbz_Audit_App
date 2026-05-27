/* Lightweight Google service-account auth + fetch helpers.
   Talks to Drive v3 and Sheets v4 via raw HTTPS — only the endpoints we use.

   IMPORTANT — Node 24 / OpenSSL 3 fix:
   When `GOOGLE_SERVICE_ACCOUNT` is pasted into Vercel env vars, the
   `private_key` field's literal "\n" escape sequences must be converted
   to real newlines, otherwise the BEGIN/END PRIVATE KEY markers end up
   on one line and OpenSSL 3 rejects the key with:
     "error:1E08010C:DECODER routines::unsupported"
   The `normalizeCreds()` helper below handles all the common storage
   patterns: raw JSON, JSON with literal "\n", base64-encoded JSON, etc. */

const { GoogleAuth } = require('google-auth-library');

let _authCache = null;

function normalizeCreds(raw) {
  if (!raw) return null;
  let str = String(raw).trim();

  /* If env var is base64-encoded, decode it first */
  if (/^[A-Za-z0-9+/=\s]+$/.test(str) && !str.startsWith('{')) {
    try {
      const decoded = Buffer.from(str.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (decoded.startsWith('{')) str = decoded;
    } catch (_) { /* fall through */ }
  }

  let creds;
  try {
    creds = JSON.parse(str);
  } catch (_) {
    /* Some Vercel UIs convert real newlines to a single space inside JSON
       string values. Try to repair: any newline INSIDE the JSON becomes \\n. */
    try {
      creds = JSON.parse(str.replace(/\r/g, '').replace(/\n/g, '\\n'));
    } catch (e) {
      console.error('[_google] could not parse GOOGLE_SERVICE_ACCOUNT:', e.message);
      return null;
    }
  }

  /* Normalize the private key field — the single most common breakage. */
  if (creds && typeof creds.private_key === 'string') {
    let pk = creds.private_key;
    /* Replace any escaped newlines with real ones */
    pk = pk.replace(/\\n/g, '\n');
    /* Strip surrounding double quotes if anyone accidentally double-wrapped */
    if (pk.startsWith('"') && pk.endsWith('"')) pk = pk.slice(1, -1).replace(/\\n/g, '\n');
    /* Strip CR; ensure trailing newline so the BEGIN/END footer parses cleanly */
    pk = pk.replace(/\r/g, '');
    if (!pk.endsWith('\n')) pk += '\n';
    creds.private_key = pk;
  }
  return creds;
}

function getAuth(scopes) {
  if (_authCache && _authCache.scopes === scopes) return _authCache.auth;
  const creds = normalizeCreds(process.env.GOOGLE_SERVICE_ACCOUNT);
  if (!creds) return null;
  const auth = new GoogleAuth({ credentials: creds, scopes: [scopes] });
  _authCache = { scopes, auth };
  return auth;
}

async function getAccessToken(scope) {
  const auth = getAuth(scope);
  if (!auth) throw new Error('GOOGLE_SERVICE_ACCOUNT not configured');
  try {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('failed to obtain access token');
    return token;
  } catch (err) {
    /* Surface the most useful diagnostics. The DECODER error means the
       private_key didn't parse — likely an env-var paste issue. */
    const msg = (err && err.message) || String(err);
    if (msg.includes('DECODER routines') || msg.includes('1E08010C') || msg.includes('unsupported')) {
      throw new Error('Google service account private_key could not be parsed by OpenSSL. Re-paste GOOGLE_SERVICE_ACCOUNT into Vercel (or store as base64).');
    }
    if (msg.includes('invalid_grant') || msg.includes('invalid_client')) {
      throw new Error('Google rejected the service-account credentials: ' + msg);
    }
    throw err;
  }
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

module.exports = { getAuth, getAccessToken, googleFetch, normalizeCreds };
