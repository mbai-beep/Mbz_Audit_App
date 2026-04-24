/* DEPRECATED — not used in the Audit App. Use /api/audits?action=answer. */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({ error: 'Deprecated', message: 'Use /api/audits?action=answer' });
};
