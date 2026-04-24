/* DEPRECATED — Customer_Req_App "entries" endpoint is not used in the Audit App.
   Returns a clear 410 Gone so stale clients see the right error. Use /api/audits. */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({
    error: 'Deprecated endpoint',
    message: 'Use /api/audits?action=start | session | answer | submit | list'
  });
};
