/* Stream a Drive file (private to the SA) through to the client.
   Uses google-auth-library for OAuth + raw HTTPS to forward Range headers.
   Lightweight replacement for the previous googleapis-based version. */

const https = require('https');
const { getAccessToken } = require('./_google');
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range'
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing file id' });

  try {
    const token = await getAccessToken(SCOPE);

    /* Fetch metadata first so we can advertise correct content-length / type */
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=mimeType,name,size&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!metaRes.ok) {
      const t = await metaRes.text().catch(() => '');
      return res.status(metaRes.status).json({ error: `Drive metadata ${metaRes.status}: ${t.slice(0, 200)}` });
    }
    const meta = await metaRes.json();
    const mimeType = meta.mimeType || 'application/octet-stream';
    const fileSize = parseInt(meta.size || '0', 10);
    const rangeHeader = req.headers['range'];

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
    const reqHeaders = { Authorization: `Bearer ${token}` };
    let statusCode = 200;

    if (rangeHeader && fileSize) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        reqHeaders['Range'] = `bytes=${start}-${end}`;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', String(end - start + 1));
        statusCode = 206;
      }
    } else if (fileSize) {
      res.setHeader('Content-Length', String(fileSize));
    }

    /* Stream via raw HTTPS so we can forward Range headers and follow redirects */
    await new Promise((resolve, reject) => {
      function stream(url, attempt) {
        https.get(url, { headers: reqHeaders }, (driveRes) => {
          if ((driveRes.statusCode === 301 || driveRes.statusCode === 302) && attempt < 5) {
            driveRes.resume();
            return stream(driveRes.headers.location, attempt + 1);
          }
          res.writeHead(statusCode);
          driveRes.pipe(res);
          driveRes.on('end', resolve);
          driveRes.on('error', reject);
        }).on('error', reject);
      }
      stream(driveUrl, 0);
    });

  } catch (err) {
    console.error('File proxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};
