#!/usr/bin/env node
/**
 * One-shot migration: copy `employees` and `employee_auth` tables from the
 * Customer Requisition Turso DB into the Audit Turso DB.
 *
 * USAGE (PowerShell):
 *   $env:SOURCE_DATABASE_URL  = "libsql://mbz-customer-req-mbz-admin.aws-ap-south-1.turso.io"
 *   $env:SOURCE_AUTH_TOKEN    = "<read-or-rw token for the customer-req DB>"
 *   $env:TARGET_DATABASE_URL  = "libsql://mbz-audit-req-mbz-admin.aws-ap-south-1.turso.io"
 *   $env:TARGET_AUTH_TOKEN    = "<rw token for the audit DB>"
 *   node scripts/migrate-employees.js
 *
 * USAGE (bash):
 *   SOURCE_DATABASE_URL=... SOURCE_AUTH_TOKEN=... \
 *   TARGET_DATABASE_URL=... TARGET_AUTH_TOKEN=... \
 *   node scripts/migrate-employees.js
 *
 * Behaviour:
 *   - Ensures `employees` and `employee_auth` exist in the target (same schema
 *     as api/_db.js).
 *   - Pulls every row from the source.
 *   - Upserts into the target using INSERT OR REPLACE keyed on emp_code.
 *   - Prints row-count parity at the end.
 *
 * Safe to re-run.
 */

'use strict';

const { createClient } = require('@libsql/client');

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: ${name} env var is required.`);
    process.exit(1);
  }
  return v;
}

const SOURCE_URL   = need('SOURCE_DATABASE_URL');
const SOURCE_TOKEN = need('SOURCE_AUTH_TOKEN');
const TARGET_URL   = need('TARGET_DATABASE_URL');
const TARGET_TOKEN = need('TARGET_AUTH_TOKEN');

const src = createClient({ url: SOURCE_URL, authToken: SOURCE_TOKEN });
const dst = createClient({ url: TARGET_URL, authToken: TARGET_TOKEN });

/* Same schema as api/_db.js — keep in sync. */
const DDL_EMPLOYEES = `CREATE TABLE IF NOT EXISTS employees (
  emp_code INTEGER PRIMARY KEY,
  emp_name TEXT,
  emp_mobile TEXT,
  emp_designation TEXT,
  hod TEXT,
  store_code TEXT,
  store_name TEXT,
  store_locality TEXT,
  city TEXT,
  state TEXT,
  store_status TEXT DEFAULT 'Active',
  role TEXT DEFAULT 'employee',
  password_hash TEXT
)`;

const DDL_EMPLOYEE_AUTH = `CREATE TABLE IF NOT EXISTS employee_auth (
  emp_code INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL,
  is_first_login INTEGER DEFAULT 1,
  password_changed_at TEXT,
  password_history TEXT DEFAULT '[]',
  tc_accepted INTEGER DEFAULT 0,
  otp TEXT DEFAULT '',
  otp_expires_at TEXT DEFAULT ''
)`;

/* Wanted columns in the TARGET (audit DB) schema. The script will copy only
   those that ALSO exist in the source — anything missing source-side is left
   at the target's column default (NULL / '' / 0 etc.). */
const EMPLOYEE_COLS_TARGET = [
  'emp_code', 'emp_name', 'emp_mobile', 'emp_designation', 'hod',
  'store_code', 'store_name', 'store_locality', 'city', 'state',
  'store_status', 'role', 'password_hash'
];

const EMPLOYEE_AUTH_COLS_TARGET = [
  'emp_code', 'password_hash', 'is_first_login', 'password_changed_at',
  'password_history', 'tc_accepted', 'otp', 'otp_expires_at'
];

async function getTableColumns(client, table) {
  const r = await client.execute(`PRAGMA table_info(${table})`);
  return r.rows.map(row => String(row.name));
}

async function ensureTargetSchema() {
  await dst.execute(DDL_EMPLOYEES);
  await dst.execute(DDL_EMPLOYEE_AUTH);
  /* defensive migrations matching api/_db.js */
  for (const col of [
    'ALTER TABLE employee_auth ADD COLUMN password_changed_at TEXT',
    "ALTER TABLE employee_auth ADD COLUMN password_history TEXT DEFAULT '[]'",
    'ALTER TABLE employee_auth ADD COLUMN tc_accepted INTEGER DEFAULT 0',
    "ALTER TABLE employee_auth ADD COLUMN otp TEXT DEFAULT ''",
    "ALTER TABLE employee_auth ADD COLUMN otp_expires_at TEXT DEFAULT ''"
  ]) {
    try { await dst.execute(col); } catch (_) {}
  }
}

function rowFor(cols, row) {
  return cols.map(c => (row[c] === undefined ? null : row[c]));
}

async function copyTable(name, wantedTargetCols) {
  console.log(`\n--- ${name} ---`);

  /* Discover what actually exists on each side. */
  const sourceCols = await getTableColumns(src, name);
  const targetCols = await getTableColumns(dst, name);
  if (sourceCols.length === 0) {
    console.error(`  source table ${name} not found or empty schema; skipping`);
    return { source: 0, ok: 0, bad: 0, targetTotal: 0, skipped: true };
  }

  /* Columns we'll actually move = wanted ∩ source ∩ target. */
  const cols = wantedTargetCols.filter(c => sourceCols.includes(c) && targetCols.includes(c));
  const missingInSource = wantedTargetCols.filter(c => !sourceCols.includes(c));
  const missingInTarget = wantedTargetCols.filter(c => !targetCols.includes(c));

  console.log(`  source cols  : ${sourceCols.join(', ')}`);
  console.log(`  copying cols : ${cols.join(', ')}`);
  if (missingInSource.length) console.log(`  not on source (left as default) : ${missingInSource.join(', ')}`);
  if (missingInTarget.length) console.log(`  not on target (dropped)         : ${missingInTarget.join(', ')}`);

  if (cols.length === 0) {
    console.error(`  no overlapping columns to copy for ${name}; skipping`);
    return { source: 0, ok: 0, bad: 0, targetTotal: 0, skipped: true };
  }

  let sourceRows;
  try {
    const res = await src.execute(`SELECT ${cols.join(', ')} FROM ${name}`);
    sourceRows = res.rows;
  } catch (e) {
    console.error(`  source read failed: ${e.message}`);
    throw e;
  }
  console.log(`  source rows  : ${sourceRows.length}`);

  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT OR REPLACE INTO ${name} (${cols.join(', ')}) VALUES (${placeholders})`;

  let ok = 0, bad = 0;
  for (const r of sourceRows) {
    try {
      await dst.execute({ sql, args: rowFor(cols, r) });
      ok++;
    } catch (e) {
      bad++;
      console.error(`  row failed (${name} emp_code=${r.emp_code}): ${e.message}`);
    }
  }
  console.log(`  inserted/replaced: ${ok}   failed: ${bad}`);

  const after = await dst.execute(`SELECT COUNT(*) AS n FROM ${name}`);
  console.log(`  target rowcount now: ${Number(after.rows[0].n)}`);
  return { source: sourceRows.length, ok, bad, targetTotal: Number(after.rows[0].n) };
}

(async () => {
  console.log(`Source : ${SOURCE_URL}`);
  console.log(`Target : ${TARGET_URL}`);

  console.log('\nEnsuring target schema...');
  await ensureTargetSchema();
  console.log('  done.');

  const r1 = await copyTable('employees', EMPLOYEE_COLS_TARGET);
  const r2 = await copyTable('employee_auth', EMPLOYEE_AUTH_COLS_TARGET);

  console.log('\n========== SUMMARY ==========');
  console.log(`employees     : src=${r1.source}  copied=${r1.ok}  fail=${r1.bad}  target=${r1.targetTotal}`);
  console.log(`employee_auth : src=${r2.source}  copied=${r2.ok}  fail=${r2.bad}  target=${r2.targetTotal}`);
  console.log('=============================\n');

  if (r1.bad || r2.bad) {
    console.error('Migration finished with errors. See log above.');
    process.exit(2);
  }
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
