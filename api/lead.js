// /api/lead
//   POST { name, email, phone, amount, message, source }  -> stores a lead (public)
//   GET   (ADMIN ONLY, Bearer token)                       -> returns all leads
import { supabaseAdmin, isAdmin, getUserFromReq, readJson, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- Admin reads the central leads list ----
  if (req.method === 'GET') {
    const user = await getUserFromReq(req);
    if (!user || !isAdmin(user.email)) return res.status(403).json({ error: 'Admin only' });
    try {
      const { data, error } = await supabaseAdmin.from('leads').select('*').limit(2000);
      if (error) throw error;
      const leads = (data || []).sort(
        (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
      );
      return res.status(200).json({ leads });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }

  // ---- Anyone can submit a lead from the contact form ----
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

  const b = await readJson(req);
  try {
    const source = b.source || 'website';
    const email = (b.email || '').trim();
    // Auto-signups (welcome popup) can fire repeatedly for the same person — dedupe them
    // so real prospects aren't buried. Genuine contact-form submissions are never deduped.
    if (email && /welcome/i.test(source)) {
      const { data: dupes } = await supabaseAdmin
        .from('leads').select('id').eq('email', email).eq('source', source).limit(1);
      if (dupes && dupes.length) return res.status(200).json({ ok: true, deduped: true });
    }
    const { error } = await supabaseAdmin.from('leads').insert({
      name: b.name || '', email, phone: b.phone || '',
      amount: b.amount || '', message: b.message || '', source
    });
    if (error) throw error;
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
