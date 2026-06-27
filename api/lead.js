// POST /api/lead  { name, email, phone, amount, message, source } -> stores a lead
import { supabaseAdmin, readJson, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = await readJson(req);
  try {
    const { error } = await supabaseAdmin.from('leads').insert({
      name: b.name || '', email: b.email || '', phone: b.phone || '',
      amount: b.amount || '', message: b.message || '', source: b.source || 'website'
    });
    if (error) throw error;
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
