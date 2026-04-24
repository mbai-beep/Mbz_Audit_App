const { getDB, ensureTable } = require('./_db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'mb-customer-req-2024-secret';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function verifyAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) throw new Error('Unauthorized');
  const token = authHeader.replace('Bearer ', '');
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.role !== 'admin') throw new Error('Forbidden: admin access required');
  return decoded;
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    verifyAdmin(req);
  } catch(e) {
    return res.status(403).json({ success: false, error: e.message });
  }

  await ensureTable();
  const db = getDB();
  const { action } = req.query;

  // ── GET single employee by ID ───────────────────────
  if (action === 'get-employee') {
    const { empCode } = req.query;
    if (!empCode) return res.json({ success: false, error: 'empCode required' });
    const result = await db.execute({
      sql: `SELECT e.emp_code, e.emp_name, e.emp_designation, e.emp_mobile,
             e.store_name, e.store_code, e.store_status, e.role,
             COALESCE(a.tc_accepted, 0) AS tc_accepted
      FROM employees e
      LEFT JOIN employee_auth a ON e.emp_code = a.emp_code
      WHERE e.emp_code = ?`,
      args: [parseInt(empCode)]
    });
    if (!result.rows.length) return res.json({ success: false, error: 'Employee ID not found' });
    return res.json({ success: true, employee: result.rows[0] });
  }

  // ── GET list of all employees ─────────────────────────────
  if (action === 'list-employees') {
    const result = await db.execute(`
      SELECT e.emp_code, e.emp_name, e.emp_designation, e.emp_mobile,
             e.store_name, e.store_code, e.store_status, e.role,
             COALESCE(a.is_first_login, 1) AS is_first_login,
             a.password_changed_at, COALESCE(a.tc_accepted, 0) AS tc_accepted
      FROM employees e
      LEFT JOIN employee_auth a ON e.emp_code = a.emp_code
      ORDER BY e.store_name ASC, e.emp_name ASC
    `);
    return res.json({ success: true, employees: result.rows });
  }

  // ── POST add new employee ─────────────────────────────────
  if (action === 'add-employee' && req.method === 'POST') {
    const { empCode, empName, empDesignation, empMobile, storeCode, storeName, role, initialPassword } = req.body || {};
    if (!empCode || !empName || !initialPassword) return res.json({ success: false, error: 'Employee ID, name and password are required' });
    if (String(initialPassword).length < 6) return res.json({ success: false, error: 'Password must be at least 6 characters' });
    const existing = await db.execute({ sql: 'SELECT emp_code FROM employees WHERE emp_code = ?', args: [parseInt(empCode)] });
    if (existing.rows.length) return res.json({ success: false, error: 'Employee ID already exists' });
    const hash = await bcrypt.hash(String(initialPassword), 10);
    await db.execute({
      sql: `INSERT INTO employees (emp_code, emp_name, emp_designation, emp_mobile, store_code, store_name, store_locality, city, state, store_status, role) VALUES (?, ?, ?, ?, ?, ?, '', '', '', 'Active', ?)`,
      args: [parseInt(empCode), empName.trim(), empDesignation || '', empMobile || '', storeCode || '', storeName || '', role || 'employee']
    });
    await db.execute({
      sql: `INSERT INTO employee_auth (emp_code, password_hash, is_first_login, tc_accepted, password_history) VALUES (?, ?, 1, 0, '[]')`,
      args: [parseInt(empCode), hash]
    });
    return res.json({ success: true });
  }

  // ── POST toggle employee status ───────────────────────────
  if (action === 'toggle-status' && req.method === 'POST') {
    const { empCode, status } = req.body || {};
    if (!empCode || !status) return res.json({ success: false, error: 'empCode and status required' });
    await db.execute({
      sql: 'UPDATE employees SET store_status = ? WHERE emp_code = ?',
      args: [status, parseInt(empCode)]
    });
    return res.json({ success: true });
  }

  // ── POST admin reset password ─────────────────────────────
  if (action === 'reset-password' && req.method === 'POST') {
    const { empCode, newPassword } = req.body || {};
    if (!empCode || !newPassword) return res.json({ success: false, error: 'empCode and newPassword required' });
    if (String(newPassword).length < 6) return res.json({ success: false, error: 'Password must be at least 6 characters' });
    const hash = await bcrypt.hash(String(newPassword), 10);
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE employee_auth SET password_hash = ?, is_first_login = 1, password_changed_at = ?, password_history = '[]' WHERE emp_code = ?`,
      args: [hash, now, parseInt(empCode)]
    });
    return res.json({ success: true });
  }

  return res.status(400).json({ error: 'Invalid action' });
};
