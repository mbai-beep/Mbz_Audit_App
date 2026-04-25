const { google } = require('googleapis');
const { Readable } = require('stream');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fileData, fileName, mimeType } = req.body;

    if (!fileData || !fileName) {
      return res.status(400).json({ error: 'Missing fileData or fileName' });
    }

    const base64Data = fileData.includes(',') ? fileData.split(',')[1] : fileData;
    const buffer = Buffer.from(base64Data, 'base64');

    // Parse service account - handle literal newlines in Vercel env vars
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
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({ version: 'v3', auth });
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    const bufferStream = new Readable();
    bufferStream.push(buffer);
    bufferStream.push(null);

    // supportsAllDrives: true handles shared/team drives
    const uploadRes = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: mimeType || 'application/octet-stream',
        parents: [folderId],
      },
      media: {
        mimeType: mimeType || 'application/octet-stream',
        body: bufferStream,
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    const fileId = uploadRes.data.id;

    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = (mimeType && mimeType.startsWith('image/'))
    ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`
    : `${proto}://${host}/api/file?id=${fileId}`;
    return res.status(200).json({ url, fileId });

  } catch (err) {
    console.error('Drive upload error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
