const { createClient } = require('@libsql/client');

let db;
function getDB() {
  if (!db) {
    db = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });
  }
  return db;
}

/* ══════════════════════════════════════════════════════════════
   Schema bootstrap - identical auth tables as Customer_Req_App,
   plus the audit-domain tables. Memoized per cold start: the CREATE
   TABLE / ALTER TABLE / seed work only runs once per Lambda instance,
   not on every request. This is the single biggest latency win.
════════════════════════════════════════════════════════════════ */
let _schemaReadyPromise = null;
function ensureTable() {
  if (!_schemaReadyPromise) _schemaReadyPromise = _doEnsureTable().catch(err => {
    /* On failure, allow retry on next request */
    _schemaReadyPromise = null;
    throw err;
  });
  return _schemaReadyPromise;
}

async function _doEnsureTable() {
  const d = getDB();

  /* ── Auth (kept identical to Customer_Req_App) ─────────────── */
  await d.execute(`CREATE TABLE IF NOT EXISTS employees (
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
  )`);

  await d.execute(`CREATE TABLE IF NOT EXISTS employee_auth (
    emp_code INTEGER PRIMARY KEY,
    password_hash TEXT NOT NULL,
    is_first_login INTEGER DEFAULT 1,
    password_changed_at TEXT,
    password_history TEXT DEFAULT '[]',
    tc_accepted INTEGER DEFAULT 0,
    otp TEXT DEFAULT '',
    otp_expires_at TEXT DEFAULT ''
  )`);

  /* Safe migration: older installs */
  try { await d.execute('ALTER TABLE employee_auth ADD COLUMN password_changed_at TEXT'); } catch(e) {}
  try { await d.execute("ALTER TABLE employee_auth ADD COLUMN password_history TEXT DEFAULT '[]'"); } catch(e) {}
  try { await d.execute('ALTER TABLE employee_auth ADD COLUMN tc_accepted INTEGER DEFAULT 0'); } catch(e) {}
  try { await d.execute("ALTER TABLE employee_auth ADD COLUMN otp TEXT DEFAULT ''"); } catch(e) {}
  try { await d.execute("ALTER TABLE employee_auth ADD COLUMN otp_expires_at TEXT DEFAULT ''"); } catch(e) {}

  /* Ensure primary admin role */
  try { await d.execute({ sql: "UPDATE employees SET role='admin' WHERE emp_code=2266", args: [] }); } catch(e) {}

  /* ══ Audit-domain tables ══════════════════════════════════════ */

  /* Showrooms — distinct store list */
  await d.execute(`CREATE TABLE IF NOT EXISTS showrooms (
    store_code TEXT PRIMARY KEY,
    store_name TEXT,
    locality TEXT,
    city TEXT,
    state TEXT,
    manager_emp_code INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TEXT
  )`);

  /* Checklist items — the question bank, grouped by area_tag */
  await d.execute(`CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_tag TEXT NOT NULL,
    category TEXT NOT NULL,
    parent_id INTEGER,
    responsible TEXT,
    action_text TEXT NOT NULL,
    timeline TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  )`);
  try { await d.execute('CREATE INDEX IF NOT EXISTS idx_ci_area ON checklist_items(area_tag)'); } catch(e) {}

  /* Audit session — one per showroom per calendar day per auditor */
  await d.execute(`CREATE TABLE IF NOT EXISTS audit_sessions (
    id TEXT PRIMARY KEY,
    store_code TEXT NOT NULL,
    store_name TEXT,
    audit_date TEXT NOT NULL,
    manager_name TEXT,
    conducted_by_code INTEGER,
    conducted_by_name TEXT,
    conducted_by_role TEXT,
    status TEXT DEFAULT 'in_progress',
    created_at TEXT,
    submitted_at TEXT,
    total_items INTEGER DEFAULT 0,
    done_count INTEGER DEFAULT 0,
    pending_count INTEGER DEFAULT 0,
    not_done_count INTEGER DEFAULT 0,
    compliance_pct REAL DEFAULT 0,
    thumbnail_urls TEXT DEFAULT '[]',
    audio_urls TEXT DEFAULT '[]'
  )`);
  try { await d.execute('CREATE INDEX IF NOT EXISTS idx_as_store ON audit_sessions(store_code, audit_date)'); } catch(e) {}
  /* Safe migrations for older installs */
  try { await d.execute("ALTER TABLE audit_sessions ADD COLUMN thumbnail_urls TEXT DEFAULT '[]'"); } catch(e) {}
  try { await d.execute("ALTER TABLE audit_sessions ADD COLUMN audio_urls TEXT DEFAULT '[]'"); } catch(e) {}

  /* Audit answers — one per checklist_item per session */
  await d.execute(`CREATE TABLE IF NOT EXISTS audit_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    status TEXT DEFAULT 'Pending',
    remarks TEXT DEFAULT '',
    responsible_name TEXT DEFAULT '',
    completed_at TEXT DEFAULT '',
    photo_urls TEXT DEFAULT '[]',
    updated_at TEXT,
    UNIQUE(session_id, item_id)
  )`);
  try { await d.execute('CREATE INDEX IF NOT EXISTS idx_aa_session ON audit_answers(session_id)'); } catch(e) {}

  /* Auto-seed showrooms + checklist on first run */
  await seedIfEmpty(d);
}

/* ══════════════════════════════════════════════════════════════
   Seed data — fires only when tables are empty. Idempotent.
════════════════════════════════════════════════════════════════ */
async function seedIfEmpty(d) {
  /* showrooms: seed from distinct active stores in employees if table empty */
  try {
    const { rows } = await d.execute("SELECT COUNT(*) AS n FROM showrooms");
    if (Number(rows[0].n) === 0) {
      const src = await d.execute(
        "SELECT DISTINCT store_code, store_name, store_locality, city, state " +
        "FROM employees WHERE store_status = 'Active' AND store_code != '' ORDER BY store_name"
      );
      const now = new Date().toISOString();
      for (const r of src.rows) {
        try {
          await d.execute({
            sql: `INSERT OR IGNORE INTO showrooms
                  (store_code, store_name, locality, city, state, is_active, created_at)
                  VALUES (?, ?, ?, ?, ?, 1, ?)`,
            args: [r.store_code, r.store_name, r.store_locality || '',
                   r.city || '', r.state || '', now]
          });
        } catch(e) {}
      }
    }
  } catch(e) {}

  /* checklist_items: seed only if empty */
  try {
    const { rows } = await d.execute("SELECT COUNT(*) AS n FROM checklist_items");
    if (Number(rows[0].n) === 0) {
      const items = require('./_checklist_seed');
      /* First pass: insert parents + non-children, remember IDs by action_text */
      const textToId = {};
      for (const it of items.filter(x => !x._parent_text)) {
        const r = await d.execute({
          sql: `INSERT INTO checklist_items
                (area_tag, category, responsible, action_text, timeline, sort_order, is_active)
                VALUES (?, ?, ?, ?, ?, ?, 1)`,
          args: [it.area_tag, it.category, it.responsible || '',
                 it.action_text, it.timeline || '', it.sort_order || 0]
        });
        textToId[it.action_text] = Number(r.lastInsertRowid || 0);
      }
      /* Second pass: insert children with resolved parent_id */
      for (const it of items.filter(x => x._parent_text)) {
        const pid = textToId[it._parent_text] || null;
        await d.execute({
          sql: `INSERT INTO checklist_items
                (area_tag, category, parent_id, responsible, action_text, timeline, sort_order, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          args: [it.area_tag, it.category, pid, it.responsible || '',
                 it.action_text, it.timeline || '', it.sort_order || 0]
        });
      }
    }
  } catch(e) { console.error('seed checklist error:', e.message); }
}

module.exports = { getDB, ensureTable };
