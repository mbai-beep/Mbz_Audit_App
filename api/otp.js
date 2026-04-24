const { getDB, ensureTable } = require('./_db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'mb-customer-req-2024-secret';
const FAST2SMS_KEY = process.env.FAST2SMS_API_KEY || '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

async function sendSMS(mobile, otp) {
  if (!FAST2SMS_KEY) {
    // Demo mode: log OTP to console (set FAST2SMS_API_KEY in Vercel env to enable real SMS)
    console.log(`[OTP DEMO] Mobile: ${mobile} | OTP: ${otp}`);
    return { success: true, demo: true, otp };
  }
  try {
    const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${FAST2SMS_KEY}&variables_values=${otp}&route=otp&numbers=${mobile}`;
    const resp = await fetch(url);
    const data = await resp.json();
    return { success: data.return === true };
  } catch (e) {
    console.error('SMS error:', e.message);
    return { success: false };
  }
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  await ensureTable();
  const db = getDB();
  const { action } = req.query;

  // POST /api/otp?action=send
  if (action === 'send' && req.method === 'POST') {
    const { empCode, mobile } = req.body || {};
    if (!empCode || !mobile) return res.json({ success: false, error: 'Employee ID and mobile number are required' });

    const empResult = await db.execute({ sql: 'SELECT * FROM employees WHERE emp_code = ?', args: [parseInt(empCode)] });
    if (!empResult.rows.length) return res.json({ success: false, error: 'Employee ID not found' });

    const emp = empResult.rows[0];
    const cleanInput = String(mobile).replace(/\D/g, '').slice(-10);
    const cleanStored = String(emp.emp_mobile).replace(/\D/g, '').slice(-10);
    if (cleanInput !== cleanStored) return res.json({ success: false, error: 'Mobile number does not match our records' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    // Ensure auth record exists
    const authResult = await db.execute({ sql: 'SELECT emp_code FROM employee_auth WHERE emp_code = ?', args: [parseInt(empCode)] });
    if (!authResult.rows.length) return res.json({ success: false, error: 'Account not set up. Contact admin.' });

    await db.execute({ sql: 'UPDATE employee_auth SET otp = ?, otp_expires_at = ? WHERE emp_code = ?', args: [otp, expiresAt, parseInt(empCode)] });

    const result = await sendSMS(cleanInput, otp);
    if (!result.success) return res.json({ success: false, error: 'Failed to send OTP. Please try again.' });

    const response = { success: true };
    if (result.demo) {
      response.demo = true;
      response.otp = result.otp; // Only in demo mode (no SMS key)
      response.message = 'Demo mode: OTP shown below (add FAST2SMS_API_KEY env variable for real SMS)';
    }
    return res.json(response);
  }

  // POST /api/otp?action=verify
  if (action === 'verify' && req.method === 'POST') {
    const { empCode, otp } = req.body || {};
    if (!empCode || !otp) return res.json({ success: false, error: 'Employee ID and OTP are required' });

    const authResult = await db.execute({ sql: 'SELECT * FROM employee_auth WHERE emp_code = ?', args: [parseInt(empCode)] });
    if (!authResult.rows.length) return res.json({ success: false, error: 'Account not found' });

    const auth = authResult.rows[0];
    if (!auth.otp || auth.otp !== String(otp)) return res.json({ success: false, error: 'Invalid OTP. Please check and retry.' });
    if (new Date() > new Date(auth.otp_expires_at)) return res.json({ success: false, error: 'OTP expired. Please request a new one.' });

    // Clear OTP and issue reset token (valid 15 min)
    await db.execute({ sql: "UPDATE employee_auth SET otp = '', otp_expires_at = '' WHERE emp_code = ?", args: [parseInt(empCode)] });
    const resetToken = jwt.sign({ empCode: parseInt(empCode) }, JWT_SECRET + '-reset', { expiresIn: '15m' });
    return res.json({ success: true, resetToken });
  }

  return res.status(400).json({ error: 'Invalid action' });
};
