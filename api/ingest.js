// POST /api/ingest   (ADMIN ONLY)
//   { path: "uploads/brochure.pdf" }      -> downloads from Storage, extracts text
//   OR { title, text, source }            -> ingests pasted text directly
// Chunks the text, embeds each chunk, and stores it as the AI's knowledge.
import { supabaseAdmin, embedMany, isAdmin, getUserFromReq, readJson, cors } from './_lib.js';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';

function chunkText(t, size = 1100, overlap = 150) {
  const words = t.replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  for (let i = 0; i < words.length; i += (size - overlap)) {
    const piece = words.slice(i, i + size).join(' ');
    if (piece.trim().length > 40) out.push(piece);
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const user = await getUserFromReq(req);
  if (!user || !isAdmin(user.email)) return res.status(403).json({ error: 'Admin only' });

  const body = await readJson(req);
  try {
    let title = body.title || 'Untitled';
    let source = body.source || title;
    let text = body.text || '';

    if (body.path) {
      const { data, error } = await supabaseAdmin.storage.from('documents').download(body.path);
      if (error) throw error;
      const buf = Buffer.from(await data.arrayBuffer());
      const ext = (body.path.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') text = (await pdf(buf)).text;
      else if (ext === 'docx') text = (await mammoth.extractRawText({ buffer: buf })).value;
      else text = buf.toString('utf8');
      title = body.title || body.path.split('/').pop();
      source = title;
    }

    if (!text.trim()) return res.status(400).json({ error: 'No text could be extracted' });

    const { data: doc, error: de } = await supabaseAdmin
      .from('documents').insert({ title, source, created_by: user.id }).select().single();
    if (de) throw de;

    const chunks = chunkText(text);
    let n = 0;
    // Embed + insert in batches so large documents finish well within the 60s limit.
    const BATCH = 64;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const vecs = await embedMany(slice);
      const rows = slice.map((c, j) => ({ document_id: doc.id, content: c, source, embedding: vecs[j] }));
      const { error } = await supabaseAdmin.from('doc_chunks').insert(rows);
      if (!error) n += rows.length;
    }
    // Nothing stored? Roll back the empty document row so it doesn't linger.
    if (n === 0) { try { await supabaseAdmin.from('documents').delete().eq('id', doc.id); } catch (_) {} }

    res.status(200).json({ ok: true, document_id: doc.id, title, chunks: n });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
