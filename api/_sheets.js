/* Google Sheets append helper — writes one row per submitted audit.
   Uses google-auth-library + raw fetch to keep Vercel function bundles
   small. Gracefully no-ops (returns false) if env vars aren't set, so
   a Sheets outage never breaks the audit submit flow. */

const { googleFetch } = require('./_google');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const HEADER_ROW = [
  'Submitted At (IST)', 'Session ID', 'Store Code', 'Store Name',
  'Audit Date', 'Conducted By (Code)', 'Conducted By (Name)', 'Role',
  'Manager Name', 'Total Items', 'Done', 'Not Done', 'Pending',
  'Compliance %', 'Status'
];

function api(sheetId, path, query = {}) {
  const qs = new URLSearchParams(query).toString();
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}${path}${qs ? '?' + qs : ''}`;
}

async function appendRow(row) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || 'Audits';
  if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT) {
    console.warn('[sheets] skipped — GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT missing');
    return false;
  }
  try {
    const url = api(sheetId, `/values/${encodeURIComponent(tab + '!A:Z')}:append`, {
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS'
    });
    await googleFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] })
    }, SCOPE);
    return true;
  } catch (err) {
    console.error('[sheets] append failed:', err.message);
    return false;
  }
}

/* Ensure the header row exists (idempotent — only writes if A1 is empty). */
async function ensureHeader() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || 'Audits';
  if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT) return false;
  try {
    const getUrl = api(sheetId, `/values/${encodeURIComponent(tab + '!A1:A1')}`);
    const r = await googleFetch(getUrl, {}, SCOPE);
    const data = await r.json();
    if (data.values && data.values.length && data.values[0].length) return true;
    const putUrl = api(sheetId, `/values/${encodeURIComponent(tab + '!A1')}`, {
      valueInputOption: 'USER_ENTERED'
    });
    await googleFetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [HEADER_ROW] })
    }, SCOPE);
    return true;
  } catch (err) {
    console.error('[sheets] ensureHeader failed:', err.message);
    return false;
  }
}

async function appendAuditRow(session) {
  if (!session) return false;
  await ensureHeader();
  const row = [
    session.submitted_at || session.created_at || '',
    session.id || '',
    session.store_code || '',
    session.store_name || '',
    session.audit_date || '',
    String(session.conducted_by_code || ''),
    session.conducted_by_name || '',
    session.conducted_by_role || '',
    session.manager_name || '',
    Number(session.total_items || 0),
    Number(session.done_count || 0),
    Number(session.not_done_count || 0),
    Number(session.pending_count || 0),
    Number(session.compliance_pct || 0),
    session.status || ''
  ];
  return appendRow(row);
}

module.exports = { appendRow, appendAuditRow, ensureHeader };
