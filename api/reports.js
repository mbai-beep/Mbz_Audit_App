const { getDB, ensureTable } = require('./_db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'mb-customer-req-2024-secret';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function getUser(req) {
  const h = req.headers.authorization || '';
  if (!h) throw new Error('Unauthorized');
  return jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  await ensureTable();
  const db = getDB();

  let user;
  try { user = getUser(req); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  const { action } = req.query;

  /* ── ?action=summary — overall KPIs ────────────────────── */
  if (action === 'summary') {
    const { from, to, storeCode } = req.query;
    const where = [];
    const args = [];
    if (from)      { where.push('audit_date >= ?'); args.push(from); }
    if (to)        { where.push('audit_date <= ?'); args.push(to); }
    if (storeCode) { where.push('store_code = ?'); args.push(storeCode); }
    if (user.role === 'manager' && user.storeCode && !storeCode) {
      where.push('store_code = ?'); args.push(user.storeCode);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const totalsSql = `SELECT
         COUNT(*) AS sessions,
         SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) AS submitted,
         SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
         COALESCE(ROUND(AVG(compliance_pct), 1), 0) AS avg_compliance,
         COALESCE(SUM(done_count), 0) AS total_done,
         COALESCE(SUM(pending_count), 0) AS total_pending,
         COALESCE(SUM(not_done_count), 0) AS total_not_done
       FROM audit_sessions ${w}`;
    const totals = await db.execute({ sql: totalsSql, args });
    const t = totals.rows[0] || {};
    // Normalize numeric types (Turso may return BigInt for COUNT/SUM)
    const totalsObj = {
      sessions: Number(t.sessions || 0),
      submitted: Number(t.submitted || 0),
      in_progress: Number(t.in_progress || 0),
      avg_compliance: Number(t.avg_compliance || 0),
      total_done: Number(t.total_done || 0),
      total_pending: Number(t.total_pending || 0),
      total_not_done: Number(t.total_not_done || 0)
    };

    const byStoreSql = `SELECT store_code, store_name,
         COUNT(*) AS audits,
         COALESCE(ROUND(AVG(compliance_pct), 1), 0) AS avg_compliance,
         COALESCE(SUM(done_count), 0) AS done,
         COALESCE(SUM(not_done_count), 0) AS not_done,
         COALESCE(SUM(pending_count), 0) AS pending,
         (SELECT id FROM audit_sessions s2
            WHERE s2.store_code = audit_sessions.store_code
            ORDER BY s2.audit_date DESC, s2.created_at DESC LIMIT 1) AS last_session_id
       FROM audit_sessions ${w}
       GROUP BY store_code, store_name
       ORDER BY avg_compliance DESC`;
    const byStore = await db.execute({ sql: byStoreSql, args });
    const byStoreRows = byStore.rows.map(r => ({
      store_code: r.store_code,
      store_name: r.store_name || '',
      audits: Number(r.audits || 0),
      avg_compliance: Number(r.avg_compliance || 0),
      done: Number(r.done || 0),
      not_done: Number(r.not_done || 0),
      pending: Number(r.pending || 0),
      last_session_id: r.last_session_id || ''
    }));

    const byAreaSql = `SELECT ci.area_tag,
         COUNT(aa.id) AS total,
         SUM(CASE WHEN aa.status IN ('Done','Yes') THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN aa.status IN ('No','Not Done') THEN 1 ELSE 0 END) AS not_done,
         SUM(CASE WHEN aa.status = 'Pending' THEN 1 ELSE 0 END) AS pending
       FROM audit_answers aa
       JOIN checklist_items ci ON ci.id = aa.item_id
       JOIN audit_sessions s  ON s.id  = aa.session_id
       ${w ? w.replace(/audit_date/g, 's.audit_date').replace(/store_code/g, 's.store_code') : ''}
       GROUP BY ci.area_tag
       ORDER BY ci.area_tag`;
    const byArea = await db.execute({ sql: byAreaSql, args });
    const byAreaRows = byArea.rows.map(r => ({
      area_tag: r.area_tag,
      total: Number(r.total || 0),
      done: Number(r.done || 0),
      not_done: Number(r.not_done || 0),
      pending: Number(r.pending || 0)
    }));

    return res.json({
      success: true,
      totals: totalsObj,
      byStore: byStoreRows,
      byArea: byAreaRows
    });
  }

  /* ── ?action=session-csv&id=... — single-session CSV ─── */
  if (action === 'session-csv') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    const s = await db.execute({ sql: 'SELECT * FROM audit_sessions WHERE id = ?', args: [id] });
    if (!s.rows.length) return res.status(404).json({ error: 'Not found' });

    const rows = await db.execute({
      sql: `SELECT ci.area_tag, ci.category, ci.action_text, ci.responsible, ci.timeline,
                   aa.status, aa.remarks, aa.responsible_name, aa.completed_at
            FROM checklist_items ci
            LEFT JOIN audit_answers aa ON aa.item_id = ci.id AND aa.session_id = ?
            WHERE ci.is_active = 1
            ORDER BY ci.sort_order`,
      args: [id]
    });

    const esc = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['Area','Category','Action','Responsible (default)','Timeline','Status','Remarks','Responsible (actual)','Completed At'];
    const body = rows.rows.map(r => [
      r.area_tag, r.category, r.action_text, r.responsible, r.timeline,
      r.status || 'Pending', r.remarks || '', r.responsible_name || '', r.completed_at || ''
    ].map(esc).join(','));
    const csv = [header.join(','), ...body].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_${id}.csv"`);
    return res.status(200).send(csv);
  }

  return res.status(400).json({ error: 'Invalid action' });
};
