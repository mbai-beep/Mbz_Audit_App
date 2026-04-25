# MB Store Audit App

Production-ready showroom audit portal for Meena Bazaar.

**Stack:** HTML/CSS/JS (single-file frontend) · Node.js 24 serverless functions on Vercel · Turso (libSQL) for data · Google Drive (Shared Drive) for photo uploads · Google Sheets for external reporting.

## Features

- Area-wise checklist (Physical Space, People, Leadership, Product, Customer, Compliance)
- Responsible person per action + timeline + remarks + photo evidence
- Yes / No / Done / Pending status chips with debounced autosave
- Role-based access: auditor / manager / admin
- Reports: by store, by area, with CSV export
- Identical login UX to Mbz_Customer_Req_App — OTP-based forgot-password via Fast2SMS

## Project layout

```
api/                  Vercel serverless endpoints (Node 24)
  _checklist_seed.js  Canonical checklist items seeded into Turso
  _db.js              Turso client + schema bootstrap (ensureTable)
  _sheets.js          Google Sheets append helper (Audits tab)
  admin.js            Admin tools (search/toggle/reset employees)
  audits.js           start | session | answer | submit | list
  auth.js             Login, change password, accept T&C
  checklist.js        Get active checklist (grouped by area)
  entries.js          Legacy alias for older clients (safe to ignore)
  file.js             Streams private Drive files through the SA
  otp.js              Fast2SMS OTP send/verify for forgot-password
  reports.js          summary (KPIs) | session-csv
  seed.js             One-shot seeder for employees + checklist
  sheets.js           (deprecated stub — do not use)
  stores.js           Store list used by login/dashboard
  upload.js           Upload photo → Shared Drive (supportsAllDrives)
data/
  employees.json      Initial employee roster (used by /api/seed)
public/
  index.html          Entire SPA (login + auditor + manager + admin views)
vercel.json           Function config + CORS headers
package.json          Node 24, @libsql/client, googleapis, bcryptjs, jsonwebtoken
```

## First-time deployment

### 1 · Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit: MB Store Audit App"
git branch -M main
git remote add origin https://github.com/mbai-beep/Mbz_Audit_App.git
git push -u origin main
```

### 2 · Create the Vercel project
- Import the GitHub repo into Vercel.
- Framework preset: **Other**. Root directory: **./**. Build command: leave blank.
- Node.js version: 24.x (from `engines`).

### 3 · Set Environment Variables
Copy from `.env.example`:

| Var | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://mbz-audit-req-mbz-admin.aws-ap-south-1.turso.io` |
| `TURSO_AUTH_TOKEN` | (the long JWT starting `eyJhbGci...`) |
| `JWT_SECRET` | `openssl rand -hex 64` |
| `ADMIN_SECRET` | any long random string |
| `FAST2SMS_API_KEY` | your Fast2SMS API key |
| `GOOGLE_SERVICE_ACCOUNT` | full SA JSON as one line |
| `GOOGLE_DRIVE_FOLDER_ID` | `0AAJ1498fVte6Uk9PVA` |
| `GOOGLE_SHEET_ID` | `1_Mi3Nj12Fh3ZARua7G7ZmBApAwd5pLHBmca_YMCAJAU` |
| `GOOGLE_SHEET_TAB` | `Audits` (or any tab name) |

### 4 · Grant the Service Account access
- Share the **Google Sheet** with `<service-account>@<project>.iam.gserviceaccount.com` as **Editor**.
- Make the SA a **Content Manager** of the **Shared Drive** (ID `0AAJ1498fVte6Uk9PVA`).

### 5 · Seed the database (one-time)
After the first deploy, call the seed endpoint with your admin secret:
```bash
curl -X POST "https://<your-app>.vercel.app/api/seed" \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: $ADMIN_SECRET"
```
This creates tables, seeds the checklist, and imports `data/employees.json`.

### 6 · Log in
- First login uses an employee's **Employee Code** and default password `password123`.
- Accept T&C on first login. Change password when prompted.

## Local development

```bash
npm install
# create .env from .env.example
vercel dev        # or: node (with a wrapper, serverless functions expect Vercel shape)
```

## Data model (Turso)

- `employees` — master roster (empCode, empName, store, role, password_hash, …)
- `showrooms` — store directory
- `checklist_items` — canonical checklist (area_tag, category, action, responsible, timeline, sort_order)
- `audit_sessions` — one per auditor × store × date
- `audit_answers` — one per (session, item); status, remarks, photos, completed_at
- `otp_tokens` — short-lived OTPs for forgot-password

## Notes

- All timestamps are **IST** (UTC+5:30).
- Turso returns `BigInt` for aggregates — server-side code coerces to `Number`.
- Photos hit `/api/upload` → Shared Drive → frontend gets a `drive.google.com/thumbnail?...` URL for images, or `/api/file?id=...` for PDFs.
- Sheets append failures are logged but never break the submit flow.
