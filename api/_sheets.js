/* Google Sheets append helper — writes one row per submitted audit.
   Gracefully no-ops (logs warning, returns false) if GOOGLE_SHEET_ID or
   GOOGLE_SERVICE_ACCOUNT env vars aren't configured, so a sheets outage
   never breaks the audit submit flow. */

const { google } = require('googleapis');

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (_) {
    try { return JSON.parse(raw.replace(/\n/g, '\\n').replace(/\r/g, '')); }
    catch (e) { console.error('[sheets] bad GOOGLE_SERVICE_ACCOUNT:', e.message); return null; }
  }
}

function getAuth() {
  const sa = loadServiceAccount();
  if (!sa) return null;
  return new google.auth.GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

async function appendRow(row) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || 'Audits';
  const auth = getAuth();
  if (!sheetId || !auth) {
    console.warn('[sheets] skipped — GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT missing');
    return false;
  }
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${tab}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });
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
  const auth = getAuth();
  if (!sheetId || !auth) return false;
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tab}!A1:A1`
    });
    if (r.data.values && r.data.values.length && r.data.values[0].length) return true;
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          'Submitted At (IST)', 'Session ID', 'Store Code', 'Store Name',
          'Audit Date', 'Conducted By (Code)', 'Conducted By (Name)', 'Role',
          'Manager Name', 'Total Items', 'Done', 'Not Done', 'Pending',
          'Compliance %', 'Status'
        ]]
      }
    });
    return true;
  } catch (err) {
    console.error('[sheets] ensureHeader failed:', err.message);
    return false;
  }
}

/* Build a row from a DB session record + return true if appended. */
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
