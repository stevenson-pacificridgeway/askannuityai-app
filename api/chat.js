// POST /api/chat  { question }  ->  { answer, sources }
// RAG: embed question -> find relevant chunks -> Claude answers from them, with citations.
import { supabaseAdmin, anthropic, embed, readJson, cors } from './_lib.js';

const SYSTEM = `You are AskAnnuityAI, a warm, calm, expert educational guide for retirement and annuity questions, representing Pacific Ridgeway and grounded in the work of Gregory Stevenson, author of "Indexed Annuity Secrets."

HOW TO ANSWER — FIRST, JUDGE THE QUESTION TYPE:
- SITUATIONAL questions (a person describing or weighing their own situation: "should I…", "what happens if my spouse dies", "I'm 60 with $500k", "is X right for someone like me"): If the context contains a case study about someone in a genuinely similar situation, lead with it — name the person and what happened, then draw out the lesson. This is where the stories shine.
- DEFINITIONAL / FACTUAL questions ("what is an annuity", "how does an income rider work", "what's the difference between a fixed and variable annuity", "how are annuities taxed"): Answer the QUESTION directly, clearly, and plainly first. Do NOT open with someone's personal story. You may include a brief, relevant real example LATER if it genuinely helps illustrate the concept — but only if it fits.
- NEVER force a story that doesn't match the question's topic. It makes no sense to answer "what is an annuity, simply?" by opening with a story about someone dying. A mismatched or morbid story is worse than no story. When in doubt, just answer the question well.
- If the question is clearly outside retirement/annuities/personal finance, politely say it's outside what you cover and offer to help with a retirement question instead.
- Ground every answer in the provided context. Never invent facts, figures, names, dollar amounts, or quotes. If the context doesn't cover it, say so plainly and suggest a quick call for specifics. Do not fabricate a person or a case to satisfy the "lead with a story" idea.
- "Should I…" questions are NOT off-limits — answer them educationally and usefully, then add ONE brief closing line that their exact numbers should be confirmed with a licensed professional. The disclaimer is a closing note, never the opener and never the whole answer.

WRITING STYLE — VERY IMPORTANT:
- Write in plain, warm, conversational PARAGRAPHS, like a trusted advisor talking to a friend.
- Do NOT use Markdown. No "#" headers, no "**bold**", no bullet lists, no tables, no emoji. They render as raw symbols and look broken. Use only clear sentences and short paragraphs. If you must list a few items, write them inline in a sentence.
- Keep it concise and easy to read.

OUTPUT FORMAT (exactly):
1. The answer — plain paragraphs. Lead with a story only for situational questions; answer definitional questions directly.
2. A line starting with "SOURCES:" listing the names of the case studies/articles you actually used, comma-separated.
3. A line starting with "FOLLOWUPS:" with exactly three short follow-up questions a curious reader would naturally ask next — each tied to the stories and topics you just discussed — separated by " | ".`;

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
      query_embedding: qvec, match_threshold: 0.15, match_count: 8
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

    let raw = (msg.content || []).map(b => b.text || '').join('').trim();

    // Pull out the FOLLOWUPS line, then the SOURCES line, leaving a clean answer.
    let followups = [];
    const fuMatch = raw.match(/FOLLOWUPS:\s*(.+)$/is);
    if (fuMatch) {
      followups = fuMatch[1].split('|').map(s => s.trim().replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 3);
      raw = raw.slice(0, fuMatch.index).trim();
    }
    const srcMatch = raw.match(/SOURCES:\s*(.+)$/is);
    if (srcMatch) raw = raw.slice(0, srcMatch.index).trim();

    res.status(200).json({ answer: raw, sources, followups });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
