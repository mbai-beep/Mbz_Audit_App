const { getDB, ensureTable } = require('./_db');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  await ensureTable();
  const db = getDB();

  /* Union showrooms table + distinct employees.store — belt-and-braces so a
     freshly-seeded system still returns rows even before employees.json import. */
  const showrooms = await db.execute(
    "SELECT store_code, store_name, locality, city, state, is_active " +
    "FROM showrooms WHERE is_active = 1 ORDER BY store_name"
  );

  const fallback = await db.execute(
    "SELECT DISTINCT store_code, store_name, store_locality AS locality, city, state " +
    "FROM employees WHERE store_status = 'Active' AND store_code != '' ORDER BY store_name"
  );

  const seen = new Set();
  const stores = [];
  for (const r of [...showrooms.rows, ...fallback.rows]) {
    if (!r.store_code || seen.has(r.store_code)) continue;
    seen.add(r.store_code);
    stores.push({
      code: r.store_code,
      name: r.store_name,
      locality: r.locality || '',
      city: r.city || '',
      state: r.state || ''
    });
  }
  return res.json({ success: true, stores });
};
