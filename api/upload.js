/* Google Drive upload (Shared Drive supported) — lightweight version.
   Uses google-auth-library for OAuth + raw fetch with multipart upload.
   Avoids the full `googleapis` package to keep the function bundle small. */

const { getAccessToken } = require('./_google');
const SCOPE = 'https://www.googleapis.com/auth/drive';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { fileData, fileName, mimeType } = req.body || {};
    if (!fileData || !fileName) return res.status(400).json({ error: 'Missing fileData or fileName' });

    const base64Data = fileData.includes(',') ? fileData.split(',')[1] : fileData;
    const buffer = Buffer.from(base64Data, 'base64');
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_FOLDER_ID not configured' });

    const token = await getAccessToken(SCOPE);
    const ct = mimeType || 'application/octet-stream';

    /* Multipart upload: metadata JSON + binary body, separated by boundary */
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
      throw new Error(`Drive upload ${upRes.status}: ${t.slice(0, 500)}`);
    }
    const { id: fileId } = await upRes.json();

    /* Make file readable by anyone with the link (so the frontend can show
       a thumbnail directly without proxying through /api/file). */
    try {
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ role: 'reader', type: 'anyone' })
        }
      );
    } catch (e) { console.warn('[upload] permissions.create failed:', e.message); }

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = (ct.startsWith('image/'))
      ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`
      : `${proto}://${host}/api/file?id=${fileId}`;
    return res.status(200).json({ url, fileId });

  } catch (err) {
    console.error('Drive upload error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
