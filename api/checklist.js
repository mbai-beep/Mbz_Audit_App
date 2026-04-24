const { getDB, ensureTable } = require('./_db');
const jwt = require('jsonwebtoken');

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

function mapItem(r) {
  return {
    id: r.id,
    areaTag: r.area_tag,
    category: r.category,
    parentId: r.parent_id || null,
    responsible: r.responsible || '',
    actionText: r.action_text,
    timeline: r.timeline || '',
    sortOrder: r.sort_order || 0,
    isActive: Number(r.is_active) === 1
  };
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  await ensureTable();
  const db = getDB();

  let user;
  try { user = getUser(req); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  /* ── GET list of active items (all roles) ──────────────── */
  if (req.method === 'GET') {
    const includeInactive = user.role === 'admin' && req.query.all === '1';
    const sql = includeInactive
      ? 'SELECT * FROM checklist_items ORDER BY sort_order, id'
      : 'SELECT * FROM checklist_items WHERE is_active = 1 ORDER BY sort_order, id';
    const r = await db.execute(sql);

    const items = r.rows.map(mapItem);

    // Group by area_tag for the UI
    const grouped = {};
    for (const it of items) {
      if (!grouped[it.areaTag]) grouped[it.areaTag] = [];
      grouped[it.areaTag].push(it);
    }

    return res.json({
      success: true,
      total: items.length,
      areas: Object.keys(grouped),
      items,
      grouped
    });
  }

  /* ── POST admin-only: add a new checklist item ──────────── */
  if (req.method === 'POST' && user.role === 'admin') {
    const { areaTag, category, responsible, actionText, timeline, sortOrder } = req.body || {};
    if (!areaTag || !category || !actionText) {
      return res.json({ success: false, error: 'areaTag, category, actionText required' });
    }
    const r = await db.execute({
      sql: `INSERT INTO checklist_items (area_tag, category, responsible, action_text, timeline, sort_order, is_active)
            VALUES (?, ?, ?, ?, ?, ?, 1)`,
      args: [areaTag, category, responsible || '', actionText, timeline || '', Number(sortOrder) || 0]
    });
    return res.json({ success: true, id: Number(r.lastInsertRowid || 0) });
  }

  /* ── PATCH admin-only: toggle / edit ────────────────────── */
  if (req.method === 'PATCH' && user.role === 'admin') {
    const { id, isActive, actionText, responsible, timeline, areaTag, category } = req.body || {};
    if (!id) return res.json({ success: false, error: 'id required' });
    const sets = [], args = [];
    if (typeof isActive === 'boolean') { sets.push('is_active = ?'); args.push(isActive ? 1 : 0); }
    if (actionText != null)            { sets.push('action_text = ?'); args.push(actionText); }
    if (responsible != null)           { sets.push('responsible = ?'); args.push(responsible); }
    if (timeline != null)              { sets.push('timeline = ?'); args.push(timeline); }
    if (areaTag != null)               { sets.push('area_tag = ?'); args.push(areaTag); }
    if (category != null)              { sets.push('category = ?'); args.push(category); }
    if (!sets.length) return res.json({ success: false, error: 'No changes' });
    args.push(Number(id));
    await db.execute({ sql: `UPDATE checklist_items SET ${sets.join(', ')} WHERE id = ?`, args });
    return res.json({ success: true });
  }

  return res.status(403).json({ error: 'Forbidden' });
};
