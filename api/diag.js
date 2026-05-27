/* Diagnostic endpoint — reports which env vars are present in the
   live Vercel runtime, without leaking any secret values.

   USE: open https://mbz-audit-app.vercel.app/api/diag
        to see what's set / missing in Production.

   Safe to leave deployed: only booleans + length hints leave the box.
*/

function shape(name, raw) {
  if (!raw) return { name, present: false };
  const len = String(raw).length;
  const out = { name, present: true, length: len };
  /* Light shape checks — never the value */
  if (name === 'GOOGLE_SERVICE_ACCOUNT') {
    const str = String(raw).trim();
    out.looksLikeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(str) && !str.startsWith('{');
    out.looksLikeJson   = str.startsWith('{');
    if (out.looksLikeJson) {
      out.containsPrivateKey = str.includes('private_key');
      out.containsEscapedNewlines = str.includes('\\n');
      out.containsRealNewlines = /\n/.test(str);
    }
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const env = {
    TURSO_DATABASE_URL:   shape('TURSO_DATABASE_URL',   process.env.TURSO_DATABASE_URL),
    TURSO_AUTH_TOKEN:     shape('TURSO_AUTH_TOKEN',     process.env.TURSO_AUTH_TOKEN),
    JWT_SECRET:           shape('JWT_SECRET',           process.env.JWT_SECRET),
    GOOGLE_SERVICE_ACCOUNT: shape('GOOGLE_SERVICE_ACCOUNT', process.env.GOOGLE_SERVICE_ACCOUNT),
    GOOGLE_DRIVE_FOLDER_ID: shape('GOOGLE_DRIVE_FOLDER_ID', process.env.GOOGLE_DRIVE_FOLDER_ID),
    GOOGLE_SHEET_ID:      shape('GOOGLE_SHEET_ID',      process.env.GOOGLE_SHEET_ID),
    GOOGLE_SHEET_TAB:     shape('GOOGLE_SHEET_TAB',     process.env.GOOGLE_SHEET_TAB),
    FAST2SMS_API_KEY:     shape('FAST2SMS_API_KEY',     process.env.FAST2SMS_API_KEY),
    ADMIN_SECRET:         shape('ADMIN_SECRET',         process.env.ADMIN_SECRET)
  };

  /* Try to parse the service account & confirm OpenSSL accepts the key */
  let saStatus = { ok: false, reason: 'not attempted' };
  if (env.GOOGLE_SERVICE_ACCOUNT.present) {
    try {
      const { normalizeCreds, getAccessToken } = require('./_google');
      const creds = normalizeCreds(process.env.GOOGLE_SERVICE_ACCOUNT);
      if (!creds) {
        saStatus = { ok: false, reason: 'parsed null (bad JSON / bad base64)' };
      } else {
        saStatus.parsed = true;
        saStatus.hasPrivateKey = !!creds.private_key;
        saStatus.hasClientEmail = !!creds.client_email;
        /* Try to actually mint an access token (proves OpenSSL accepted the key) */
        try {
          const token = await getAccessToken('https://www.googleapis.com/auth/drive');
          saStatus.ok = !!token;
          saStatus.tokenPreview = token ? token.slice(0, 12) + '…' : null;
        } catch (e) {
          saStatus.ok = false;
          saStatus.reason = e.message;
        }
      }
    } catch (e) {
      saStatus = { ok: false, reason: 'init threw: ' + e.message };
    }
  } else {
    saStatus = { ok: false, reason: 'env var missing — set GOOGLE_SERVICE_ACCOUNT in Vercel' };
  }

  return res.status(200).json({
    runtime: {
      node: process.version,
      vercel: process.env.VERCEL ? true : false,
      region: process.env.VERCEL_REGION || null,
      env: process.env.VERCEL_ENV || null
    },
    envVars: env,
    serviceAccount: saStatus,
    nextStep:
      !env.GOOGLE_SERVICE_ACCOUNT.present
        ? 'Set GOOGLE_SERVICE_ACCOUNT in Vercel Settings → Environment Variables → Production'
        : !saStatus.ok
          ? 'Service account is set but not usable: ' + (saStatus.reason || 'unknown')
          : 'All good ✓'
  });
};
