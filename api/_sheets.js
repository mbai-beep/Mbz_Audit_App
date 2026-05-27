/* Google Sheets — single-tab design.
   ONE tab ("Audits" by default; override via GOOGLE_SHEET_TAB) holds the
   merged audit data: every row is one Yes/No answer, with the session-level
   summary fields denormalized on each row.
   Pending answers are intentionally skipped (per spec).

   When an admin marks a No item as Fixed, the same row is updated in place
   (columns Fixed, Post-Audit Photo URL, Fixed At, Fixed By Code, Fixed By Name).
*/

const { googleFetch } = require('./_google');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const TAB = process.env.GOOGLE_SHEET_TAB || 'Audits';

/* Column order — matches HEADER_ROW exactly. If you reorder, update the
   `markAnswerFixed` range (`K:O` below) AND the read parser. */
const HEADER_ROW = [
  /* Session summary (cols A..Q) */
  'Session ID',            // A
  'Submitted At (IST)',    // B
  'Audit Date',            // C
  'Store Code',            // D
  'Store Name',            // E
  'Manager Name',          // F
  'Auditor Code',          // G
  'Auditor Name',          // H
  'Role',                  // I
  'Total Items',           // J
  'Yes Count',             // K
  'No Count',              // L
  'Pending Count',         // M
  'Compliance %',          // N
  'Grade',                 // O
  'Status',                // P
  'Drive Folder',          // Q
  /* Per-item answer (cols R..X) */
  'Item ID',               // R
  'Section',               // S
  'Item Title',            // T
  'Item Status',           // U  (Yes / No)
  'Remarks',               // V
  'Pre-Audit Photo URLs',  // W
  /* Follow-up fix fields — populated by markAnswerFixed (cols X..AB) */
  'Fixed',                 // X  (1/0)
  'Post-Audit Photo URL',  // Y
  'Fixed At (IST)',        // Z
  'Fixed By Code',         // AA
  'Fixed By Name'          // AB
];

function apiUrl(sheetId, path, query = {}) {
  const qs = new URLSearchParams(query || {}).toString();
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}${path}${qs ? '?' + qs : ''}`;
}

function envOk() {
  return !!(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT);
}

function gradeFor(pct) { return pct >= 80 ? 'Gold' : (pct >= 60 ? 'Silver' : 'Red'); }

/* ── Tab creation (idempotent) ───────────────────────────── */
async function ensureTabExists(tabName) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!envOk()) return false;
  try {
    const metaUrl = apiUrl(sheetId, '', { fields: 'sheets(properties(title))' });
    const r = await googleFetch(metaUrl, {}, SCOPE);
    const meta = await r.json();
    const titles = (meta.sheets || []).map(s => s.properties && s.properties.title);
    if (titles.includes(tabName)) return true;
    const batchUrl = apiUrl(sheetId, ':batchUpdate');
    await googleFetch(batchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] })
    }, SCOPE);
    return true;
  } catch (err) {
    console.error(`[sheets] ensureTabExists(${tabName}) failed:`, err.message);
    return false;
  }
}

/* Write header row on the tab if A1 is empty */
async function ensureHeader() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!envOk()) return false;
  try {
    await ensureTabExists(TAB);
    const getUrl = apiUrl(sheetId, `/values/${encodeURIComponent(TAB + '!A1:A1')}`);
    const r = await googleFetch(getUrl, {}, SCOPE);
    const data = await r.json();
    if (data.values && data.values.length && data.values[0].length) return true;
    const putUrl = apiUrl(sheetId, `/values/${encodeURIComponent(TAB + '!A1')}`, {
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

/* Append rows to the single tab */
async function appendValues(rows) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!envOk()) {
    console.warn('[sheets] skipped — GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT missing');
    return false;
  }
  if (!rows || !rows.length) return true;
  try {
    const url = apiUrl(sheetId, `/values/${encodeURIComponent(TAB + '!A:AB')}:append`, {
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS'
    });
    await googleFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows })
    }, SCOPE);
    return true;
  } catch (err) {
    console.error(`[sheets] append to ${TAB} failed:`, err.message);
    return false;
  }
}

/* ── Main writer: ONE row per Yes/No answer, denormalized session fields ── */
async function appendAuditData(session, answers, extras) {
  if (!session) return false;
  await ensureHeader();

  const pct = Number(session.compliance_pct || 0);
  const sessionCols = [
    session.id || '',
    session.submitted_at || session.created_at || '',
    session.audit_date || '',
    session.store_code || '',
    session.store_name || '',
    session.manager_name || '',
    String(session.conducted_by_code || ''),
    session.conducted_by_name || '',
    session.conducted_by_role || '',
    Number(session.total_items || 0),
    Number(session.done_count || 0),
    Number(session.not_done_count || 0),
    Number(session.pending_count || 0),
    pct,
    gradeFor(pct),
    session.status || 'submitted',
    (extras && extras.driveFolder) || ''
  ];

  /* Per-item rows — only Yes/No (Pending skipped) */
  const itemRows = (Array.isArray(answers) ? answers : [])
    .filter(a => a && (a.status === 'Yes' || a.status === 'No'))
    .map(a => {
      const photoUrls = Array.isArray(a.photoUrls) ? a.photoUrls
        : (Array.isArray(a.photo_urls) ? a.photo_urls : []);
      return sessionCols.concat([
        Number(a.itemId || a.item_id || 0),
        a.section || '',
        a.title || a.action_text || '',
        a.status || '',
        a.remarks || '',
        (photoUrls || []).join(' | '),
        /* Fixed / post-audit fields start empty */
        '', '', '', '', ''
      ]);
    });

  if (!itemRows.length) {
    /* Edge case: no Yes/No answers — write a single "summary-only" row so
       the submission is still visible in the sheet. */
    const blank = sessionCols.concat(['', '', '', '', '', '', '', '', '', '', '']);
    return appendValues([blank]);
  }

  return appendValues(itemRows);
}

/* ── markAnswerFixed: update the row matching sessionId + itemId in place
   Columns X..AB = Fixed, Post-Audit Photo URL, Fixed At, Fixed By Code, Fixed By Name
*/
async function markAnswerFixed({ sessionId, itemId, postPhotoUrl, fixedByCode, fixedByName, fixedAt }) {
  if (!envOk()) return { success: false, error: 'Sheets not configured' };
  if (!sessionId || !itemId) return { success: false, error: 'sessionId and itemId required' };
  await ensureHeader();
  const sheetId = process.env.GOOGLE_SHEET_ID;

  /* Read A2:R (Session ID is A, Item ID is R) — only the columns we need to locate the row */
  const readUrl = apiUrl(sheetId, `/values/${encodeURIComponent(TAB + '!A2:R')}`);
  const r = await googleFetch(readUrl, {}, SCOPE);
  const data = await r.json();
  const rows = data.values || [];
  let targetRow = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[0]) === String(sessionId) && String(row[17]) === String(itemId)) { // col R is index 17
      targetRow = i + 2;
      break;
    }
  }
  if (targetRow === -1) {
    return { success: false, error: 'Answer row not found in sheet — check sessionId/itemId' };
  }
  const range = `${TAB}!X${targetRow}:AB${targetRow}`;
  const putUrl = apiUrl(sheetId, `/values/${encodeURIComponent(range)}`, {
    valueInputOption: 'USER_ENTERED'
  });
  await googleFetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: [[
        1,
        postPhotoUrl || '',
        fixedAt || new Date().toISOString(),
        String(fixedByCode || ''),
        fixedByName || ''
      ]]
    })
  }, SCOPE);
  return { success: true, row: targetRow };
}

/* Read all rows for a session — used by follow-up detail view */
async function readAuditAnswersBySession(sessionId) {
  if (!envOk()) return [];
  await ensureHeader();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const readUrl = apiUrl(sheetId, `/values/${encodeURIComponent(TAB + '!A2:AB')}`);
  const r = await googleFetch(readUrl, {}, SCOPE);
  const data = await r.json();
  const rows = data.values || [];
  return rows
    .filter(row => String(row[0]) === String(sessionId))
    .filter(row => row[17]) // must have an item id
    .map(row => ({
      session_id: row[0] || '',
      store_code: row[3] || '',
      audit_date: row[2] || '',
      item_id: Number(row[17] || 0),
      section: row[18] || '',
      item_title: row[19] || '',
      status: row[20] || '',
      remarks: row[21] || '',
      pre_audit_photos: (row[22] || '').split('|').map(s => s.trim()).filter(Boolean),
      submitted_at: row[1] || '',
      fixed: row[23] === '1' || row[23] === 1 || row[23] === 'TRUE' || row[23] === true,
      post_audit_photo: row[24] || '',
      fixed_at: row[25] || '',
      fixed_by_code: row[26] || '',
      fixed_by_name: row[27] || ''
    }));
}

module.exports = {
  appendAuditData,
  markAnswerFixed,
  readAuditAnswersBySession,
  ensureHeader,
  /* Back-compat shims — older code paths still call these names but they
     now route to the single-tab writer. */
  appendAuditRow:     async () => true,
  appendAuditSession: async () => true,
  appendAuditAnswers: async () => true
};
