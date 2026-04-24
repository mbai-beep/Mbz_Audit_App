/* DEPRECATED — legacy Google-Sheets bridge from Customer_Req_App, not used
   by the Audit App. Left as a stub to avoid deploy-time file-not-found errors
   if any old link still references it. */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({ error: 'Deprecated', message: 'Not used in Audit App' });
};
