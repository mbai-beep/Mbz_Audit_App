const { getDB, ensureTable } = require('./_db');
const jwt = require('jsonwebtoken');
const { appendAuditRow } = require('./_sheets');

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
    thumbnail_urls: thumbs,
    audio_urls: audios
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

  await ensureTable();
  const db = getDB();

  let user;
  try { user = getUser(req); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  const { action } = req.query;

  /* ── POST ?action=start — create/open today's session ───── */
  if (action === 'start' && req.method === 'POST') {
    const { storeCode, storeName, auditDate, managerName } = req.body || {};
    if (!storeCode) return res.json({ success: false, error: 'storeCode required' });

    const dt = auditDate || todayIST();
    // Return existing in-progress session for this code+date+auditor if present
    const existing = await db.execute({
      sql: `SELECT * FROM audit_sessions
            WHERE store_code = ? AND audit_date = ? AND conducted_by_code = ?
            ORDER BY created_at DESC LIMIT 1`,
      args: [storeCode, dt, user.empCode]
    });
    if (existing.rows.length) {
      return res.json({ success: true, session: mapSession(existing.rows[0]) });
    }

    // Create new session + pre-create answer rows for active items
    const items = await db.execute({
      sql: 'SELECT id FROM checklist_items WHERE is_active = 1 ORDER BY sort_order'
    });
    const sessionId = `AU-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nowStr = nowIST();

    await db.execute({
      sql: `INSERT INTO audit_sessions
            (id, store_code, store_name, audit_date, manager_name,
             conducted_by_code, conducted_by_name, conducted_by_role,
             status, created_at, total_items, done_count, pending_count,
             not_done_count, compliance_pct)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, 0, ?, 0, 0)`,
      args: [sessionId, storeCode, storeName || '', dt, managerName || '',
             user.empCode, user.empName || '', user.role || 'auditor',
             nowStr, items.rows.length, items.rows.length]
    });

    if (items.rows.length) {
      const stmts = items.rows.map(it => ({
        sql: `INSERT OR IGNORE INTO audit_answers
              (session_id, item_id, status, updated_at)
              VALUES (?, ?, 'Pending', ?)`,
        args: [sessionId, it.id, nowStr]
      }));
      await db.batch(stmts, 'write');
    }

    const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [sessionId] });
    return res.json({ success: true, session: mapSession(s.rows[0]) });
  }

  /* ── GET ?action=session&id=... — full detail ──────────── */
  if (action === 'session' && req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.json({ success: false, error: 'id required' });
    const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [id] });
    if (!s.rows.length) return res.json({ success: false, error: 'Not found' });

    const items = await db.execute({
      sql: 'SELECT * FROM checklist_items WHERE is_active = 1 ORDER BY sort_order'
    });
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

  /* ── POST ?action=submit — close session ───────────────── */
  if (action === 'submit' && req.method === 'POST') {
    const { sessionId, managerName, thumbnailUrls, audioUrls } = req.body || {};
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

    /* Append to Google Sheets — failures are logged but never break submit. */
    let sheetsAppended = false;
    try { sheetsAppended = await appendAuditRow(updated); }
    catch (e) { console.error('[audits.submit] sheets append threw:', e.message); }

    return res.json({
      success: true,
      session: updated ? mapSession(updated) : null,
      sheetsAppended
    });
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

  return res.status(400).json({ error: 'Invalid action' });
};
