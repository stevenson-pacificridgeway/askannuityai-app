// POST /api/chat  { question }  ->  { answer, sources }
// RAG: embed question -> find relevant chunks -> Claude answers from them, with citations.
import { supabaseAdmin, anthropic, embed, readJson, cors } from './_lib.js';

const SYSTEM = `You are AskAnnuityAI, a warm, calm, expert educational assistant for retirement and annuity questions, representing Pacific Ridgeway.

Rules:
- Answer ONLY using the provided context. If the context does not contain the answer, say you're not certain and suggest speaking with a licensed professional. Never invent facts or figures.
- You provide EDUCATION ONLY. You do NOT give individualized financial, tax, legal, or investment advice. If the user asks for a personal recommendation ("should I…", "what should I do…"), explain that this requires a licensed professional for their specific situation, then offer to connect them.
- Write in plain English: clear, concise, friendly, never pushy.
- Annuities are insurance products; when relevant, briefly remind the reader to verify details with a licensed professional. Keep it non-alarming.
- End with a short "Source:" line naming which provided source(s) you used.`;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = await readJson(req);
  const question = (body.question || '').toString().slice(0, 2000).trim();
  if (!question) return res.status(400).json({ error: 'Missing question' });

  try {
    const qvec = await embed(question);
    const { data: chunks, error } = await supabaseAdmin.rpc('match_documents', {
      query_embedding: qvec, match_threshold: 0.2, match_count: 6
    });
    if (error) throw error;

    const context = (chunks || [])
      .map((c, i) => `[Source ${i + 1}: ${c.source || 'Document'}]\n${c.content}`)
      .join('\n\n');
    const sources = [...new Set((chunks || []).map(c => c.source).filter(Boolean))];

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', // Claude Sonnet 4.6 — swap to claude-opus-4-8 or claude-haiku-4-5-20251001 anytime
      max_tokens: 800,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Context:\n${context || '(no relevant documents were found in the knowledge base)'}\n\nQuestion: ${question}`
      }]
    });

    const answer = (msg.content || []).map(b => b.text || '').join('').trim();
    res.status(200).json({ answer, sources });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
