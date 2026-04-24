const { getDB, ensureTable } = require('./_db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'mb-customer-req-2024-secret';
const PW_EXPIRY_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// Check new password against current hash + last-3 history
async function checkPwHistory(newPw, currentHash, historyJson) {
  if (await bcrypt.compare(String(newPw), currentHash))
    return 'New password cannot be the same as your current password.';
  const history = JSON.parse(historyJson || '[]');
  for (const h of history) {
    if (await bcrypt.compare(String(newPw), h))
      return 'Password was recently used. Please choose a different one.';
  }
  return null; // OK
}

// Rotate password: returns [newHash, newHistoryJson, nowISO]
async function rotatePw(newPw, currentHash, historyJson) {
  const hash = await bcrypt.hash(String(newPw), 10);
  const history = JSON.parse(historyJson || '[]');
  const newHistory = JSON.stringify([currentHash, ...history].slice(0, 3));
  return [hash, newHistory, new Date().toISOString()];
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  await ensureTable();
  const db = getDB();
  const { action } = req.query;

  // ── POST /api/auth?action=login ──────────────────────────
  if (action === 'login' && req.method === 'POST') {
    const { empCode, password, remember } = req.body || {};
    if (!empCode || !password)
      return res.json({ success: false, error: 'Employee ID and password are required' });

    const empResult = await db.execute({ sql: 'SELECT * FROM employees WHERE emp_code = ?', args: [parseInt(empCode)] });
    if (!empResult.rows.length)
      return res.json({ success: false, error: 'Employee ID not found' });

    const emp = empResult.rows[0];
    if (emp.store_status !== 'Active')
      return res.json({ success: false, error: 'Your account is inactive. Contact admin.' });

    const authResult = await db.execute({ sql: 'SELECT * FROM employee_auth WHERE emp_code = ?', args: [parseInt(empCode)] });
    if (!authResult.rows.length)
      return res.json({ success: false, error: 'Account not set up. Contact admin.' });

    const auth = authResult.rows[0];
    const isValid = await bcrypt.compare(String(password), auth.password_hash);
    if (!isValid)
      return res.json({ success: false, error: 'Incorrect password. Try again.' });

    const isFirstLogin = Number(auth.is_first_login) === 1;

    // 60-day expiry: only enforced when password_changed_at is recorded
    const changedAt = auth.password_changed_at;
    const passwordExpired = !isFirstLogin && !!changedAt &&
      (Date.now() - new Date(changedAt).getTime() > PW_EXPIRY_MS);

    const expiry = remember ? '30d' : '24h';
    const token = jwt.sign({
      empCode: emp.emp_code,
      empName: emp.emp_name,
      role: emp.role,
      storeCode: emp.store_code,
      storeName: emp.store_name,
      designation: emp.emp_designation,
      mobile: emp.emp_mobile,
      isFirstLogin
    }, JWT_SECRET, { expiresIn: expiry });

    return res.json({
      success: true,
      token,
      passwordExpired: !!passwordExpired,
      tcAccepted: Number(auth.tc_accepted || 0) === 1,
      employee: {
        empCode: emp.emp_code,
        empName: emp.emp_name,
        designation: emp.emp_designation,
        role: emp.role,
        storeCode: emp.store_code,
        storeName: emp.store_name,
        mobile: emp.emp_mobile,
        isFirstLogin
      }
    });
  }

  // ── POST /api/auth?action=change-password ─────────────────
  if (action === 'change-password' && req.method === 'POST') {
    const { empCode, currentPassword, newPassword } = req.body || {};
    if (!empCode || !currentPassword || !newPassword)
      return res.json({ success: false, error: 'All fields are required' });
    if (String(newPassword).length < 6)
      return res.json({ success: false, error: 'New password must be at least 6 characters' });

    const authResult = await db.execute({ sql: 'SELECT * FROM employee_auth WHERE emp_code = ?', args: [parseInt(empCode)] });
    if (!authResult.rows.length)
      return res.json({ success: false, error: 'Account not found' });

    const auth = authResult.rows[0];
    const isValid = await bcrypt.compare(String(currentPassword), auth.password_hash);
    if (!isValid)
      return res.json({ success: false, error: 'Current password is incorrect' });

    const histErr = await checkPwHistory(newPassword, auth.password_hash, auth.password_history);
    if (histErr) return res.json({ success: false, error: histErr });

    const [hash, newHistory, now] = await rotatePw(newPassword, auth.password_hash, auth.password_history);
    await db.execute({
      sql: 'UPDATE employee_auth SET password_hash = ?, is_first_login = 0, password_changed_at = ?, password_history = ? WHERE emp_code = ?',
      args: [hash, now, newHistory, parseInt(empCode)]
    });
    return res.json({ success: true });
  }

  // ── POST /api/auth?action=reset-password ──────────────────
  if (action === 'reset-password' && req.method === 'POST') {
    const { empCode, newPassword, resetToken } = req.body || {};
    if (!empCode || !newPassword || !resetToken)
      return res.json({ success: false, error: 'All fields are required' });
    if (String(newPassword).length < 6)
      return res.json({ success: false, error: 'Password must be at least 6 characters' });

    try {
      const decoded = jwt.verify(resetToken, JWT_SECRET + '-reset');
      if (decoded.empCode !== parseInt(empCode))
        return res.json({ success: false, error: 'Invalid reset session' });
    } catch {
      return res.json({ success: false, error: 'Reset session expired. Please request OTP again.' });
    }

    const authResult = await db.execute({ sql: 'SELECT * FROM employee_auth WHERE emp_code = ?', args: [parseInt(empCode)] });
    if (!authResult.rows.length)
      return res.json({ success: false, error: 'Account not found' });

    const auth = authResult.rows[0];
    const histErr = await checkPwHistory(newPassword, auth.password_hash, auth.password_history);
    if (histErr) return res.json({ success: false, error: histErr });

    const [hash, newHistory, now] = await rotatePw(newPassword, auth.password_hash, auth.password_history);
    await db.execute({
      sql: 'UPDATE employee_auth SET password_hash = ?, is_first_login = 0, password_changed_at = ?, password_history = ? WHERE emp_code = ?',
      args: [hash, now, newHistory, parseInt(empCode)]
    });
    return res.json({ success: true });
  }

  // ── POST /api/auth?action=accept-tc ─────────────────────
  if (action === 'accept-tc' && req.method === 'POST') {
    const { empCode } = req.body || {};
    if (!empCode) return res.json({ success: false, error: 'empCode required' });
    await db.execute({ sql: 'UPDATE employee_auth SET tc_accepted = 1 WHERE emp_code = ?', args: [parseInt(empCode)] });
    return res.json({ success: true });
  }

  // ── GET /api/auth?action=verify ───────────────────────────
  if (action === 'verify') {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.json({ valid: false });
    try {
      const token = authHeader.replace('Bearer ', '');
      const decoded = jwt.verify(token, JWT_SECRET);
      return res.json({ valid: true, user: decoded });
    } catch {
      return res.json({ valid: false });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
