/* Google Drive upload (Shared Drive) — organizes files into
   <ROOT>/<storeCode>/<phase>/<filename>
   where phase ∈ { 'Pre_Audit', 'Post_Audit' }.

   Two action modes:
   - default (POST /api/upload)
       Body: { fileData, fileName, mimeType, storeCode, phase, folderId? }
       Uploads the file. If folderId is provided, uses it directly. Otherwise
       resolves <root>/<storeCode>/<phase>/ creating folders if missing.
   - ?action=ensure-folder
       Body: { storeCode, phase }
       Returns { success, folderId } without uploading. Call this ONCE before
       a batch of parallel uploads so all uploads share the same folder
       (prevents duplicate-folder races).

   Race-safety:
   - In-process promise cache so concurrent calls share a single lookup.
   - When multiple folders with the same name exist (legacy duplicates),
     the OLDEST one (by createdTime) is always picked — so subsequent
     uploads converge to a single canonical folder.
*/

const { getAccessToken } = require('./_google');
const SCOPE = 'https://www.googleapis.com/auth/drive';

/* Promise cache survives only inside one warm Lambda instance. The
   "ensure-folder" action in front of Promise.all is what fully prevents
   the multi-instance race. */
const FOLDER_PROMISE_CACHE = new Map();

async function findOrCreateFolder(parentId, folderName, token) {
  const cacheKey = `${parentId}/${folderName}`;
  if (FOLDER_PROMISE_CACHE.has(cacheKey)) return FOLDER_PROMISE_CACHE.get(cacheKey);

  const promise = (async () => {
    /* Search WITH orderBy=createdTime ascending — picks the oldest match.
       This is the convergence guarantee: even if duplicates exist, every
       future upload routes to the same (oldest) folder. */
    const q = encodeURIComponent(
      `name='${String(folderName).replace(/'/g, "\\'")}' and ` +
      `mimeType='application/vnd.google-apps.folder' and ` +
      `'${parentId}' in parents and trashed=false`
    );
    const searchUrl =
      `https://www.googleapis.com/drive/v3/files?q=${q}` +
      `&fields=files(id,name,createdTime)` +
      `&orderBy=createdTime` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`;
    const sr = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!sr.ok) {
      const t = await sr.text().catch(() => '');
      throw new Error(`Drive folder search ${sr.status}: ${t.slice(0, 300)}`);
    }
    const sdata = await sr.json();
    if (sdata.files && sdata.files.length) {
      return sdata.files[0].id; // oldest match
    }

    /* Create it */
    const createUrl = 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id';
    const cr = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      })
    });
    if (!cr.ok) {
      const t = await cr.text().catch(() => '');
      throw new Error(`Drive folder create ${cr.status}: ${t.slice(0, 300)}`);
    }
    const { id } = await cr.json();
    return id;
  })();

  FOLDER_PROMISE_CACHE.set(cacheKey, promise);
  /* Failures invalidate the cache so the next call can retry */
  promise.catch(() => FOLDER_PROMISE_CACHE.delete(cacheKey));
  return promise;
}

async function resolveTargetFolder(token, storeCode, phase) {
  const root = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!root) throw new Error('GOOGLE_DRIVE_FOLDER_ID not configured');
  if (!storeCode) return root; // legacy fallback
  const safeStore = String(storeCode).replace(/[\\\/]/g, '_').trim() || 'unknown_store';
  const safePhase = (String(phase || 'Pre_Audit').replace(/[\\\/]/g, '_').trim() === 'Post_Audit') ? 'Post_Audit' : 'Pre_Audit';
  const storeFolderId = await findOrCreateFolder(root, safeStore, token);
  const phaseFolderId = await findOrCreateFolder(storeFolderId, safePhase, token);
  return phaseFolderId;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const action = (req.query && req.query.action) || '';

    /* ── ensure-folder: returns the leaf folder ID without uploading ─── */
    if (action === 'ensure-folder') {
      const { storeCode, phase } = req.body || {};
      if (!storeCode) return res.status(400).json({ success: false, error: 'storeCode required' });
      const token = await getAccessToken(SCOPE);
      const folderId = await resolveTargetFolder(token, storeCode, phase);
      return res.status(200).json({ success: true, folderId });
    }

    /* ── default: upload a file ───────────────────────────────────── */
    const { fileData, fileName, mimeType, storeCode, phase, folderId: providedFolderId } = req.body || {};
    if (!fileData || !fileName) {
      return res.status(400).json({ success: false, error: 'Missing fileData or fileName' });
    }

    const base64Data = fileData.includes(',') ? fileData.split(',')[1] : fileData;
    const buffer = Buffer.from(base64Data, 'base64');
    const token = await getAccessToken(SCOPE);

    /* Use provided folderId (fast path — no races) OR resolve fresh */
    let folderId = providedFolderId;
    if (!folderId) {
      try {
        folderId = await resolveTargetFolder(token, storeCode, phase);
      } catch (e) {
        console.error('[upload] folder resolve failed:', e.message);
        return res.status(500).json({ success: false, error: 'Folder setup failed: ' + e.message });
      }
    }

    const ct = mimeType || 'application/octet-stream';

    /* Multipart upload */
    const boundary = '-------MBZ-' + Date.now().toString(36);
    const meta = JSON.stringify({ name: fileName, mimeType: ct, parents: [folderId] });
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${meta}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${ct}\r\n\r\n`,
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const body = Buffer.concat([head, buffer, tail]);

    const uploadUrl =
      'https://www.googleapis.com/upload/drive/v3/files' +
      '?uploadType=multipart&supportsAllDrives=true&fields=id';

    const upRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      body
    });
    if (!upRes.ok) {
      const t = await upRes.text().catch(() => '');
      console.error('[upload] drive upload failed:', upRes.status, t.slice(0, 500));
      return res.status(500).json({ success: false, error: `Drive upload ${upRes.status}: ${t.slice(0, 300)}` });
    }
    const { id: fileId } = await upRes.json();

    /* Public read-only sharing so thumbnails render in the app */
    try {
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'reader', type: 'anyone' })
        }
      );
    } catch (e) { console.warn('[upload] permissions.create failed:', e.message); }

    const url = (ct.startsWith('image/'))
      ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`
      : `https://drive.google.com/uc?id=${fileId}`;
    return res.status(200).json({ success: true, url, fileId, folderId });

  } catch (err) {
    console.error('[upload] unhandled:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message || 'Upload failed' });
  }
};
