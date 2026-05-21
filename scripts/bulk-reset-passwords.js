#!/usr/bin/env node
/**
 * One-shot bulk reset: every employee's password becomes `MB@<emp_code>`.
 *
 * - Iterates the `employees` table on the target (audit) DB.
 * - Computes bcrypt of `MB@<emp_code>` per employee.
 * - Upserts `employee_auth` with:
 *     password_hash      = bcrypt('MB@<emp_code>')
 *     is_first_login     = 1   (forces a password change on first login)
 *     password_changed_at = now
 *     password_history   = '[]'
 *     otp = '', otp_expires_at = ''
 *   tc_accepted is left untouched (rows that already accepted in customer-req
 *   keep their acceptance).
 *
 * USAGE (PowerShell):
 *   $env:TURSO_DATABASE_URL = "libsql://mbz-audit-req-mbz-admin.aws-ap-south-1.turso.io"
 *   $env:TURSO_AUTH_TOKEN   = "<audit-req rw token>"
 *   node scripts/bulk-reset-passwords.js
 *
 * Add --dry-run to see what would change without writing:
 *   node scripts/bulk-reset-passwords.js --dry-run
 *
 * Safe to re-run. Each run reverts every account back to MB@<emp_code>.
 */

'use strict';

const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`ERROR: ${name} env var is required.`); process.exit(1); }
  return v;
}

const DRY_RUN = process.argv.includes('--dry-run');
const DB_URL   = need('TURSO_DATABASE_URL');
const DB_TOKEN = need('TURSO_AUTH_TOKEN');

const db = createClient({ url: DB_URL, authToken: DB_TOKEN });

(async () => {
  console.log(`Target : ${DB_URL}`);
  console.log(`Mode   : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);

  const empRes = await db.execute('SELECT emp_code, emp_name, store_status FROM employees ORDER BY emp_code');
  const employees = empRes.rows;
  console.log(`Employees in target DB: ${employees.length}\n`);

  let ok = 0, skip = 0, bad = 0;
  for (const e of employees) {
    const empCode = Number(e.emp_code);
    if (!Number.isFinite(empCode)) { skip++; continue; }
    const password = `MB@${empCode}`;

    try {
      const hash = await bcrypt.hash(password, 10);
      const now = new Date().toISOString();

      if (DRY_RUN) {
        if (ok < 5) console.log(`  would reset ${empCode} (${e.emp_name||''}) -> ${password}`);
      } else {
        await db.execute({
          sql: `INSERT INTO employee_auth
                  (emp_code, password_hash, is_first_login, password_changed_at, password_history, tc_accepted, otp, otp_expires_at)
                VALUES (?, ?, 1, ?, '[]', 0, '', '')
                ON CONFLICT(emp_code) DO UPDATE SET
                  password_hash       = excluded.password_hash,
                  is_first_login      = 1,
                  password_changed_at = excluded.password_changed_at,
                  password_history    = '[]',
                  otp                 = '',
                  otp_expires_at      = ''`,
          args: [empCode, hash, now]
        });
      }
      ok++;
      if (ok % 100 === 0) console.log(`  processed ${ok}/${employees.length}`);
    } catch (err) {
      bad++;
      console.error(`  FAIL ${empCode}: ${err.message}`);
    }
  }

  console.log('\n========== SUMMARY ==========');
  console.log(`Processed : ${ok}`);
  console.log(`Skipped   : ${skip}`);
  console.log(`Failed    : ${bad}`);
  if (DRY_RUN) {
    console.log('\nDRY RUN: no rows were modified. Re-run without --dry-run to apply.');
  } else {
    console.log('\nDone. Every employee can now log in with MB@<emp_code>.');
    console.log('First login forces a password change via the 60-day expiry / first-login flow.');
  }
  process.exit(bad ? 2 : 0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
