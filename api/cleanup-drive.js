/* One-shot Drive cleanup — admin only.
   Finds duplicate folders under <ROOT> (same name, multiple folder IDs)
   and consolidates each group:
   - Keeps the OLDEST folder by createdTime
   - Moves all files + subfolders from the duplicates into the keeper
   - Recursively deduplicates subfolders (Pre_Audit / Post_Audit) inside
   - Deletes the now-empty duplicate folders

   Hit it via: POST /api/cleanup-drive   (admin Bearer token required)
   Returns a report of what was merged.
*/

const jwt = require('jsonwebtoken');
const { getAccessToken } = require('./_google');
const SCOPE = 'https://www.googleapis.com/auth/drive';
const JWT_SECRET = process.env.JWT_SECRET || 'mb-customer-req-2024-secret';

function verifyAdmin(req) {
  const h = req.headers.authorization || '';
  if (!h) throw new Error('Unauthorized');
  const decoded = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
  if (decoded.role !== 'admin') throw new Error('Forbidden — admin only');
  return decoded;
}

async function listChildren(parentId, token) {
  const out = [];
  let pageToken;
  do {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${q}` +
      `&fields=nextPageToken,files(id,name,mimeType,createdTime,parents)` +
      `&pageSize=1000` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`list ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    (data.files || []).forEach(f => out.push(f));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function moveItem(fileId, fromParent, toParent, token) {
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?addParents=${encodeURIComponent(toParent)}` +
    `&removeParents=${encodeURIComponent(fromParent)}` +
    `&supportsAllDrives=true&fields=id,parents`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  if (!r.ok) throw new Error(`move ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function deleteItem(fileId, token) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  /* 204 No Content = success; 404 = already gone (treat as success) */
  if (!r.ok && r.status !== 404) {
    throw new Error(`delete ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

/* Within `parentId`, find duplicate folder names and merge.
   Returns { merged: [{name, kept, removed:[]}], errors: [] } */
async function dedupeFoldersAt(parentId, token, report) {
  const children = await listChildren(parentId, token);
  /* Only consider folder children */
  const folders = children.filter(c => c.mimeType === 'application/vnd.google-apps.folder');
  /* Group by name */
  const byName = new Map();
  for (const f of folders) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(f);
  }

  for (const [name, group] of byName) {
    if (group.length <= 1) {
      /* Even with no duplicates, recurse so we clean inner Pre_Audit/Post_Audit */
      try { await dedupeFoldersAt(group[0].id, token, report); }
      catch (e) { report.errors.push({ at: group[0].id, name, error: e.message }); }
      continue;
    }
    /* Sort by createdTime ascending — keep the OLDEST */
    group.sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || ''));
    const keep = group[0];
    const drops = group.slice(1);
    const mergeRecord = { name, kept: keep.id, removed: [], movedFiles: 0 };
    for (const dup of drops) {
      try {
        /* Move every child of `dup` into `keep` */
        const dupChildren = await listChildren(dup.id, token);
        for (const child of dupChildren) {
          try {
            await moveItem(child.id, dup.id, keep.id, token);
            mergeRecord.movedFiles++;
          } catch (e) {
            report.errors.push({ at: child.id, name: child.name, error: 'move failed: ' + e.message });
          }
        }
        /* Then delete the now-empty duplicate */
        try {
          await deleteItem(dup.id, token);
          mergeRecord.removed.push(dup.id);
        } catch (e) {
          report.errors.push({ at: dup.id, name: dup.name, error: 'delete failed: ' + e.message });
        }
      } catch (e) {
        report.errors.push({ at: dup.id, name: dup.name, error: e.message });
      }
    }
    report.merged.push(mergeRecord);
    /* Recurse into the keeper so inner Pre_Audit/Post_Audit dupes also collapse */
    try { await dedupeFoldersAt(keep.id, token, report); }
    catch (e) { report.errors.push({ at: keep.id, name, error: e.message }); }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });

  try {
    verifyAdmin(req);
  } catch (e) {
    return res.status(403).json({ success: false, error: e.message });
  }

  try {
    const root = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!root) return res.status(500).json({ success: false, error: 'GOOGLE_DRIVE_FOLDER_ID not set' });
    const token = await getAccessToken(SCOPE);
    const report = { merged: [], errors: [] };
    await dedupeFoldersAt(root, token, report);
    return res.status(200).json({
      success: true,
      mergedGroups: report.merged.length,
      removedFolders: report.merged.reduce((a, m) => a + m.removed.length, 0),
      movedFiles: report.merged.reduce((a, m) => a + m.movedFiles, 0),
      detail: report.merged,
      errors: report.errors
    });
  } catch (err) {
    console.error('[cleanup-drive] unhandled:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message || 'cleanup failed' });
  }
};
