const { getDB, ensureTable } = require('./_db');
const jwt = require('jsonwebtoken');
const {
  appendAuditData,
  markAnswerFixed,
  readAuditAnswersBySession,
  deleteSessionRows
} = require('./_sheets');

/* Privileged roles allowed to mark No items as fixed in follow-up */
const PRIV_ROLES = ['admin', 'manager', 'owner'];

const JWT_SECRET = process.env.JWT_SECRET || 'mb-customer-req-2024-secret';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function getUser(req) {
  const h = req.headers.authorization || '';
  if (!h) throw new Error('Unauthorized');
  return jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
}

function todayIST() {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth()+1).padStart(2,'0')}-${String(ist.getUTCDate()).padStart(2,'0')}`;
}

function nowIST() {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().replace('Z', '+05:30');
}

function recalc(session, answers) {
  const total = session.total_items || answers.length;
  let done = 0, pend = 0, notDone = 0;
  for (const a of answers) {
    const s = a.status || 'Pending';
    if (s === 'Done' || s === 'Yes') done++;
    else if (s === 'No' || s === 'Not Done') notDone++;
    else pend++;
  }
  const pct = total > 0 ? Math.round((done / total) * 1000) / 10 : 0;
  return { done, pend, notDone, pct };
}

/* Return snake_case session rows (matches the raw DB shape the frontend renders) */
function mapSession(r) {
  if (!r || typeof r !== 'object') return null;
  let thumbs = [];
  let audios = [];
  try { thumbs = JSON.parse(r.thumbnail_urls || '[]'); } catch (_) {}
  try { audios = JSON.parse(r.audio_urls || '[]'); } catch (_) {}
  return {
    id: r.id,
    store_code: r.store_code,
    store_name: r.store_name || '',
    audit_date: r.audit_date,
    manager_name: r.manager_name || '',
    conducted_by_code: r.conducted_by_code,
    conducted_by_name: r.conducted_by_name || '',
    conducted_by_role: r.conducted_by_role || '',
    status: r.status || 'in_progress',
    created_at: r.created_at,
    submitted_at: r.submitted_at || '',
    total_items: r.total_items || 0,
    done_count: r.done_count || 0,
    pending_count: r.pending_count || 0,
    not_done_count: r.not_done_count || 0,
    compliance_pct: r.compliance_pct || 0,
    thumbnail_urls: Array.isArray(thumbs) ? thumbs : [],
    audio_urls: Array.isArray(audios) ? audios : []
  };
}

/* Return snake_case answer rows */
function mapAnswer(r) {
  return {
    id: r.id,
    session_id: r.session_id,
    item_id: r.item_id,
    status: r.status || 'Pending',
    remarks: r.remarks || '',
    responsible_name: r.responsible_name || '',
    completed_at: r.completed_at || '',
    photo_urls: r.photo_urls || '[]',
    updated_at: r.updated_at || ''
  };
}

async function loadSessionRow(db, id) {
  const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [id] });
  return s.rows[0] || null;
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ─────────────────────────────────────────────────────────────
     Wrap the whole handler so any unexpected throw is logged and
     returned as JSON (instead of a bare 500 with no body). This is
     what was producing "Bad response (status 500)" on the client.
  ───────────────────────────────────────────────────────────────── */
  try {
    return await handle(req, res);
  } catch (err) {
    /* Log full stack to Vercel function logs */
    console.error('[audits] unhandled error:', err && err.stack ? err.stack : err);
    /* Surface a useful slice of the stack to the client too — without it
       a generic "Cannot convert undefined or null to object" is impossible
       to locate. Limit to ~400 chars so the toast stays readable. */
    const stackHint = (err && err.stack) ? String(err.stack).split('\n').slice(0, 4).join(' | ').slice(0, 400) : '';
    return res.status(500).json({
      success: false,
      error: 'Server error: ' + (err && err.message ? err.message : 'unknown'),
      action: req.query && req.query.action,
      where: stackHint
    });
  }
};

async function handle(req, res) {
  await ensureTable();
  const db = getDB();

  let user;
  try { user = getUser(req); }
  catch { return res.status(401).json({ success: false, error: 'Unauthorized' }); }

  const { action } = req.query;

  /* ── POST ?action=start — create/open today's session ───── */
  if (action === 'start' && req.method === 'POST') {
    let stage = 'init';
    try {
      stage = 'parse-body';
      const body = req.body || {};
      const { storeCode, storeName, auditDate, managerName } = body;
      if (!storeCode) return res.json({ success: false, error: 'storeCode required' });

      stage = 'validate-user';
      const empCode = user && (user.empCode || user.emp_code);
      if (!empCode) return res.json({ success: false, error: 'Token missing empCode — please sign out and sign in again' });

      const dt = auditDate || todayIST();

      stage = 'check-existing-session';
      const existing = await db.execute({
        sql: `SELECT * FROM audit_sessions
              WHERE store_code = ? AND audit_date = ? AND conducted_by_code = ?
              ORDER BY created_at DESC LIMIT 1`,
        args: [String(storeCode), dt, Number(empCode)]
      });
      if (existing.rows && existing.rows.length) {
        return res.json({ success: true, session: mapSession(existing.rows[0]) });
      }

      stage = 'fetch-checklist-items';
      /* libSQL client v0.14 quirk: when called with {sql} but NO args field,
         the internal arg-binder hits Object.entries(undefined). Always pass
         `args: []` explicitly for parameter-less queries, or use a bare string. */
      const items = await db.execute('SELECT id FROM checklist_items WHERE is_active = 1 ORDER BY sort_order');
      const itemRows = (items && Array.isArray(items.rows)) ? items.rows : [];

      const sessionId = `AU-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const nowStr = nowIST();

      stage = 'insert-session';
      await db.execute({
        sql: `INSERT INTO audit_sessions
              (id, store_code, store_name, audit_date, manager_name,
               conducted_by_code, conducted_by_name, conducted_by_role,
               status, created_at, total_items, done_count, pending_count,
               not_done_count, compliance_pct)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, 0, ?, 0, 0)`,
        args: [sessionId, String(storeCode), String(storeName || ''), dt, String(managerName || ''),
               Number(empCode), String((user && user.empName) || ''), String((user && user.role) || 'auditor'),
               nowStr, itemRows.length, itemRows.length]
      });

      stage = 'seed-answers';
      if (itemRows.length) {
        const stmts = itemRows
          .filter(it => it && it.id != null)
          .map(it => ({
            sql: `INSERT OR IGNORE INTO audit_answers
                  (session_id, item_id, status, updated_at)
                  VALUES (?, ?, 'Pending', ?)`,
            args: [sessionId, Number(it.id), nowStr]
          }));
        if (stmts.length) await db.batch(stmts, 'write');
      }

      stage = 'reload-session';
      const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [sessionId] });
      const row = s.rows && s.rows[0];
      if (!row) return res.json({ success: false, error: 'Session inserted but could not be read back' });
      return res.json({ success: true, session: mapSession(row) });
    } catch (err) {
      console.error(`[audits.start] stage=${stage}:`, err && err.stack ? err.stack : err);
      return res.status(500).json({
        success: false,
        error: `start failed at stage "${stage}": ${err && err.message ? err.message : 'unknown'}`,
        stage
      });
    }
  }

  /* ── GET ?action=session&id=... — full detail ──────────── */
  if (action === 'session' && req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.json({ success: false, error: 'id required' });
    const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [id] });
    if (!s.rows.length) return res.json({ success: false, error: 'Not found' });

    /* Same libSQL quirk as above — use a bare string for parameter-less queries */
    const items = await db.execute('SELECT * FROM checklist_items WHERE is_active = 1 ORDER BY sort_order');
    const ans = await db.execute({
      sql: 'SELECT * FROM audit_answers WHERE session_id = ?', args: [id]
    });

    return res.json({
      success: true,
      session: mapSession(s.rows[0]),
      items: items.rows,
      answers: ans.rows.map(mapAnswer)
    });
  }

  /* ── PATCH ?action=answer — update a single answer ──────── */
  if (action === 'answer' && (req.method === 'PATCH' || req.method === 'POST')) {
    const { sessionId, itemId, status, remarks, responsibleName, completedAt, photoUrls } = req.body || {};
    if (!sessionId || !itemId) return res.json({ success: false, error: 'sessionId and itemId required' });

    const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [sessionId] });
    if (!s.rows.length) return res.json({ success: false, error: 'Session not found' });
    const session = s.rows[0];

    // Permission: auditor can edit own session; manager/admin can edit any
    const own = Number(session.conducted_by_code) === Number(user.empCode);
    const privileged = user.role === 'admin' || user.role === 'manager';
    if (!own && !privileged) return res.status(403).json({ success: false, error: 'Forbidden' });

    const safeStatus = ['Done','Yes','No','Not Done','Pending','NA'].includes(status) ? status : 'Pending';
    const photosJson = JSON.stringify(Array.isArray(photoUrls) ? photoUrls : []);
    const now = nowIST();

    await db.execute({
      sql: `INSERT INTO audit_answers
            (session_id, item_id, status, remarks, responsible_name, completed_at, photo_urls, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, item_id) DO UPDATE SET
              status = excluded.status,
              remarks = excluded.remarks,
              responsible_name = excluded.responsible_name,
              completed_at = excluded.completed_at,
              photo_urls = excluded.photo_urls,
              updated_at = excluded.updated_at`,
      args: [sessionId, Number(itemId), safeStatus, remarks || '',
             responsibleName || '', completedAt || '', photosJson, now]
    });

    // Recalculate roll-up counts
    const ans = await db.execute({
      sql: 'SELECT status FROM audit_answers WHERE session_id = ?', args: [sessionId]
    });
    const { done, pend, notDone, pct } = recalc(session, ans.rows);
    await db.execute({
      sql: `UPDATE audit_sessions SET done_count = ?, pending_count = ?, not_done_count = ?, compliance_pct = ? WHERE id = ?`,
      args: [done, pend, notDone, pct, sessionId]
    });

    const updated = await loadSessionRow(db, sessionId);
    return res.json({
      success: true,
      session: updated ? mapSession(updated) : null
    });
  }

  /* ── POST ?action=answer-batch — write all answers in 1 round trip ── */
  if (action === 'answer-batch' && req.method === 'POST') {
    const { sessionId, answers } = req.body || {};
    if (!sessionId || !Array.isArray(answers) || !answers.length) {
      return res.json({ success: false, error: 'sessionId and answers[] required' });
    }
    const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [sessionId] });
    if (!s.rows.length) return res.json({ success: false, error: 'Session not found' });
    const session = s.rows[0];
    const own = Number(session.conducted_by_code) === Number(user.empCode);
    const privileged = user.role === 'admin' || user.role === 'manager';
    if (!own && !privileged) return res.status(403).json({ success: false, error: 'Forbidden' });

    const now = nowIST();
    const validStatuses = ['Done','Yes','No','Not Done','Pending','NA'];
    const stmts = [];
    for (const a of answers) {
      if (!a || a.itemId == null) continue;
      const safeStatus = validStatuses.includes(a.status) ? a.status : 'Pending';
      const photosJson = JSON.stringify(Array.isArray(a.photoUrls) ? a.photoUrls : []);
      stmts.push({
        sql: `INSERT INTO audit_answers
              (session_id, item_id, status, remarks, responsible_name, completed_at, photo_urls, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id, item_id) DO UPDATE SET
                status = excluded.status,
                remarks = excluded.remarks,
                responsible_name = excluded.responsible_name,
                completed_at = excluded.completed_at,
                photo_urls = excluded.photo_urls,
                updated_at = excluded.updated_at`,
        args: [sessionId, Number(a.itemId), safeStatus, a.remarks || '',
               a.responsibleName || '', a.completedAt || '', photosJson, now]
      });
    }
    if (stmts.length) await db.batch(stmts, 'write');

    /* Roll up counts once at the end */
    const ar = await db.execute({
      sql: 'SELECT status FROM audit_answers WHERE session_id = ?', args: [sessionId]
    });
    const { done, pend, notDone, pct } = recalc(session, ar.rows);
    await db.execute({
      sql: 'UPDATE audit_sessions SET done_count = ?, pending_count = ?, not_done_count = ?, compliance_pct = ? WHERE id = ?',
      args: [done, pend, notDone, pct, sessionId]
    });

    const updated = await loadSessionRow(db, sessionId);
    return res.json({
      success: true,
      written: stmts.length,
      session: updated ? mapSession(updated) : null
    });
  }

  /* ── POST ?action=submit — close session ───────────────── */
  if (action === 'submit' && req.method === 'POST') {
    const { sessionId, managerName, thumbnailUrls, audioUrls, answerDetails } = req.body || {};
    if (!sessionId) return res.json({ success: false, error: 'sessionId required' });
    const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [sessionId] });
    if (!s.rows.length) return res.json({ success: false, error: 'Not found' });
    if (Number(s.rows[0].conducted_by_code) !== Number(user.empCode) &&
        user.role !== 'admin' && user.role !== 'manager') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    /* Aggregate thumbnail / audio urls. Caller may pass them; otherwise
       derive from the audit_answers.photo_urls payloads. Capped at 8 / 3. */
    let thumbs = Array.isArray(thumbnailUrls) ? thumbnailUrls.slice(0, 8) : null;
    let audios = Array.isArray(audioUrls) ? audioUrls.slice(0, 3) : null;
    if (!thumbs) {
      try {
        const ar = await db.execute({
          sql: 'SELECT photo_urls FROM audit_answers WHERE session_id = ?',
          args: [sessionId]
        });
        const all = [];
        for (const row of ar.rows) {
          try { const arr = JSON.parse(row.photo_urls || '[]'); if (Array.isArray(arr)) all.push(...arr); } catch (_) {}
        }
        thumbs = all.slice(0, 8);
      } catch (_) { thumbs = []; }
    }
    if (!audios) audios = [];

    await db.execute({
      sql: `UPDATE audit_sessions
            SET status = 'submitted', submitted_at = ?,
                manager_name = COALESCE(NULLIF(?, ''), manager_name),
                thumbnail_urls = ?, audio_urls = ?
            WHERE id = ?`,
      args: [nowIST(), managerName || '',
             JSON.stringify(thumbs), JSON.stringify(audios), sessionId]
    });
    const updated = await loadSessionRow(db, sessionId);

    /* ── Sheets: single-tab write — one row per Yes/No answer, with the
       session summary fields denormalized on each row. Pending skipped.
       Failure is logged but never breaks the submit response. */
    let sheetsAppended = false;
    try {
      sheetsAppended = await appendAuditData(
        updated,
        Array.isArray(answerDetails) ? answerDetails : [],
        { driveFolder: (updated && updated.store_code) || '' }
      );
    } catch (e) { console.error('[audits.submit] appendAuditData:', e.message); }

    return res.json({
      success: true,
      session: updated ? mapSession(updated) : null,
      sheetsAppended
    });
  }

  /* ── GET ?action=session-detail&id=... — for follow-up UI ──
     Returns the session row + answers WITH section/title joined in,
     plus the Sheets-side fix status for No items. */
  if (action === 'session-detail' && req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.json({ success: false, error: 'id required' });
    const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [id] });
    if (!s.rows.length) return res.json({ success: false, error: 'Session not found' });

    const ans = await db.execute({
      sql: 'SELECT * FROM audit_answers WHERE session_id = ?',
      args: [id]
    });
    /* Join checklist_items to surface action_text + area_tag */
    const its = await db.execute('SELECT id, area_tag, action_text FROM checklist_items');
    const byId = {};
    for (const r of (its.rows || [])) byId[r.id] = r;

    /* Pull Sheets-side fix flags for No items */
    let sheetAnswers = [];
    try { sheetAnswers = await readAuditAnswersBySession(id); }
    catch (e) { console.error('[audits.session-detail] sheets read:', e.message); }
    const sheetByItemId = {};
    for (const sa of sheetAnswers) sheetByItemId[sa.item_id] = sa;

    const answers = (ans.rows || []).map(a => {
      const meta = byId[a.item_id] || {};
      const sheetFix = sheetByItemId[a.item_id] || {};
      let photos = [];
      try { photos = JSON.parse(a.photo_urls || '[]'); } catch (_) {}
      return {
        item_id: a.item_id,
        status: a.status,
        remarks: a.remarks || '',
        photos,
        section: meta.area_tag || '',
        title: meta.action_text || '',
        fixed: !!sheetFix.fixed,
        post_audit_photo: sheetFix.post_audit_photo || '',
        fixed_at: sheetFix.fixed_at || '',
        fixed_by_name: sheetFix.fixed_by_name || ''
      };
    });

    return res.json({
      success: true,
      session: mapSession(s.rows[0]),
      answers
    });
  }

  /* ── POST ?action=mark-fixed — admin/manager/owner marks No item as fixed ─ */
  if (action === 'mark-fixed' && req.method === 'POST') {
    if (!PRIV_ROLES.includes(user.role)) {
      return res.status(403).json({ success: false, error: 'Only admin/manager/owner can mark fixed' });
    }
    const { sessionId, itemId, postPhotoUrl } = req.body || {};
    if (!sessionId || !itemId || !postPhotoUrl) {
      return res.json({ success: false, error: 'sessionId, itemId and postPhotoUrl required' });
    }
    const r = await markAnswerFixed({
      sessionId,
      itemId,
      postPhotoUrl,
      fixedByCode: user.empCode,
      fixedByName: user.empName || '',
      fixedAt: nowIST()
    });
    return res.json(r);
  }

  /* ── POST ?action=delete-session — admin only ────────────
     Deletes the audit from Turso (audit_sessions + audit_answers)
     and removes all matching rows from the Google Sheet single tab. */
  if (action === 'delete-session' && req.method === 'POST') {
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin can delete submissions' });
    }
    const { sessionId } = req.body || {};
    if (!sessionId) return res.json({ success: false, error: 'sessionId required' });

    /* 1) Turso — delete answers first, then session */
    try {
      await db.execute({
        sql: 'DELETE FROM audit_answers WHERE session_id = ?',
        args: [String(sessionId)]
      });
      await db.execute({
        sql: 'DELETE FROM audit_sessions WHERE id = ?',
        args: [String(sessionId)]
      });
    } catch (e) {
      console.error('[audits.delete-session] turso delete:', e.message);
      return res.status(500).json({ success: false, error: 'Turso delete failed: ' + e.message });
    }

    /* 2) Sheets — remove all rows for this session (best-effort) */
    let sheetRowsDeleted = 0;
    try {
      const r = await deleteSessionRows(sessionId);
      sheetRowsDeleted = (r && r.deleted) || 0;
    } catch (e) {
      console.error('[audits.delete-session] sheets delete:', e.message);
    }

    return res.json({ success: true, sessionId, sheetRowsDeleted });
  }

  /* ── POST ?action=delete-sessions — admin only, batch delete ─
     Body: { sessionIds: ["AU-...", "AU-..."] }
     Deletes each from Turso (sessions + answers) and Google Sheet rows.
     Returns aggregate counts even when some IDs fail (per-id error list). */
  if (action === 'delete-sessions' && req.method === 'POST') {
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin can delete submissions' });
    }
    const { sessionIds } = req.body || {};
    if (!Array.isArray(sessionIds) || !sessionIds.length) {
      return res.json({ success: false, error: 'sessionIds[] required' });
    }
    let deleted = 0, sheetRowsDeleted = 0;
    const errors = [];
    for (const rawId of sessionIds) {
      const sid = String(rawId || '').trim();
      if (!sid) continue;
      try {
        await db.execute({ sql: 'DELETE FROM audit_answers WHERE session_id = ?', args: [sid] });
        await db.execute({ sql: 'DELETE FROM audit_sessions WHERE id = ?',         args: [sid] });
        deleted++;
        try {
          const r = await deleteSessionRows(sid);
          sheetRowsDeleted += (r && r.deleted) || 0;
        } catch (e) {
          console.error('[delete-sessions] sheet fail for', sid, ':', e.message);
        }
      } catch (e) {
        console.error('[delete-sessions] turso fail for', sid, ':', e.message);
        errors.push({ sessionId: sid, error: e.message });
      }
    }
    return res.json({ success: true, deleted, sheetRowsDeleted, errors });
  }

  /* ── GET ?action=list — recent sessions, scoped by role ─ */
  if (action === 'list' && req.method === 'GET') {
    const { storeCode, from, to, limit } = req.query;
    let where = [];
    let args = [];
    if (storeCode) { where.push('store_code = ?'); args.push(storeCode); }
    if (from)      { where.push('audit_date >= ?'); args.push(from); }
    if (to)        { where.push('audit_date <= ?'); args.push(to); }
    if (user.role === 'employee') {
      where.push('conducted_by_code = ?'); args.push(user.empCode);
    } else if (user.role === 'manager' && user.storeCode) {
      // Manager sees only their showroom by default
      if (!storeCode) { where.push('store_code = ?'); args.push(user.storeCode); }
    }
    const sql = `SELECT * FROM audit_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY audit_date DESC, created_at DESC
                 LIMIT ${Math.min(Number(limit) || 200, 500)}`;
    const r = await db.execute({ sql, args });
    return res.json({ success: true, sessions: r.rows.map(mapSession) });
  }

  return res.status(400).json({ success: false, error: 'Invalid action: ' + action });
}
