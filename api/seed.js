const { getDB, ensureTable } = require('./_db');
const bcrypt = require('bcryptjs');
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'mb-admin-seed-2024';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  const secret = req.query.secret || (req.body && req.body.secret) || '';
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let EMPLOYEES = req.body;
  if (!Array.isArray(EMPLOYEES)) {
    return res.status(400).json({ error: 'Body must be array of employees' });
  }

  try { await ensureTable(); } catch(e) {
    return res.status(500).json({ error: 'ensureTable failed: ' + e.message });
  }

  const db = getDB();
  try {
    /* 1. Batch-upsert employees */
    const empStatements = EMPLOYEES.map(emp => ({
      sql: `INSERT OR REPLACE INTO employees
            (emp_code, emp_name, emp_mobile, emp_designation, hod,
             store_code, store_name, store_locality, city, state,
             store_status, role)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [emp.emp_code, emp.emp_name, emp.emp_mobile, emp.emp_designation, emp.hod,
             emp.store_code, emp.store_name, emp.store_locality, emp.city, emp.state,
             emp.store_status, emp.role]
    }));
    await db.batch(empStatements, 'write');

    /* 2. Upsert showrooms from employee rows */
    const seen = new Set();
    const now = new Date().toISOString();
    const shrStmts = [];
    for (const emp of EMPLOYEES) {
      if (!emp.store_code || seen.has(emp.store_code) || emp.store_status !== 'Active') continue;
      seen.add(emp.store_code);
      shrStmts.push({
        sql: `INSERT INTO showrooms (store_code, store_name, locality, city, state, is_active, created_at)
              VALUES (?, ?, ?, ?, ?, 1, ?)
              ON CONFLICT(store_code) DO UPDATE SET
                store_name = excluded.store_name,
                locality   = excluded.locality,
                city       = excluded.city,
                state      = excluded.state,
                is_active  = 1`,
        args: [emp.store_code, emp.store_name, emp.store_locality || '',
               emp.city || '', emp.state || '', now]
      });
    }
    if (shrStmts.length) await db.batch(shrStmts, 'write');

    /* 3. Only create default auth for employees missing it */
    const empCodes = EMPLOYEES.map(e => e.emp_code);
    const placeholders = empCodes.map(() => '?').join(',');
    const existing = await db.execute({
      sql: `SELECT emp_code FROM employee_auth WHERE emp_code IN (${placeholders})`,
      args: empCodes
    });
    const existingSet = new Set(existing.rows.map(r => Number(r.emp_code)));
    const newEmps = EMPLOYEES.filter(e => !existingSet.has(Number(e.emp_code)));

    const hashes = await Promise.all(
      newEmps.map(emp => bcrypt.hash('MB@' + emp.emp_code, 6))
    );

    if (newEmps.length > 0) {
      const authStatements = newEmps.map((emp, i) => ({
        sql: 'INSERT INTO employee_auth (emp_code, password_hash, is_first_login) VALUES (?, ?, 1)',
        args: [emp.emp_code, hashes[i]]
      }));
      await db.batch(authStatements, 'write');
    }

    return res.json({
      success: true,
      inserted: newEmps.length,
      skipped: existingSet.size,
      showrooms: shrStmts.length,
      total: EMPLOYEES.length
    });
  } catch(e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};
