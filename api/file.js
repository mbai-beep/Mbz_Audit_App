const { google } = require('googleapis');
const https = require('https');

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
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    } catch (e) {
      serviceAccount = JSON.parse(
        process.env.GOOGLE_SERVICE_ACCOUNT.replace(/\n/g, '\\n').replace(/\r/g, '')
      );
    }

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // Fetch metadata and access token in parallel
    const [accessToken, meta] = await Promise.all([
      auth.getAccessToken(),
      drive.files.get({ fileId: id, fields: 'mimeType,name,size', supportsAllDrives: true })
    ]);

    const mimeType = meta.data.mimeType || 'application/octet-stream';
    const fileSize = parseInt(meta.data.size || '0', 10);
    const rangeHeader = req.headers['range'];

    // Always advertise range support so iOS audio player can seek
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
    const reqHeaders = { Authorization: `Bearer ${accessToken}` };
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

    // Stream the file via raw HTTPS so we can forward Range headers
    await new Promise((resolve, reject) => {
      function stream(url, attempt) {
        https.get(url, { headers: reqHeaders }, (driveRes) => {
          if ((driveRes.statusCode === 301 || driveRes.statusCode === 302) && attempt < 5) {
            driveRes.resume(); // drain
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
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
};
