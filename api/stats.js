// GET /api/stats  (ADMIN ONLY, Bearer token)
//   -> { total, top: [{ q, count }], recent: [{ question, created_at }] }
// Real usage analytics from the chat_logs table.
import { supabaseAdmin, isAdmin, getUserFromReq, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const user = await getUserFromReq(req);
  if (!user || !isAdmin(user.email)) return res.status(403).json({ error: 'Admin only' });

  try {
    // Total questions ever asked.
    const { count: total } = await supabaseAdmin
      .from('chat_logs').select('*', { count: 'exact', head: true });

    // Pull the most recent questions to tally the top asks.
    const { data: rows, error } = await supabaseAdmin
      .from('chat_logs')
      .select('question, created_at')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) throw error;

    const tally = {};
    for (const r of (rows || [])) {
      const key = (r.question || '').trim().toLowerCase().slice(0, 90);
      if (!key) continue;
      tally[key] = (tally[key] || 0) + 1;
    }
    const top = Object.entries(tally)
      .map(([q, count]) => ({ q, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const recent = (rows || []).slice(0, 25);
    return res.status(200).json({ total: total || 0, top, recent });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
