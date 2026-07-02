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
- If a provided source is not clearly relevant to THIS question, ignore it entirely and do not list it under SOURCES. Only cite sources you actually used.
- For a short follow-up (e.g. "what about her?", "and if I wait?"), interpret it using the earlier conversation turns rather than treating it as a brand-new topic.
- "Should I…" questions are NOT off-limits — answer them educationally and usefully, then add ONE brief closing line that their exact numbers should be confirmed with a licensed professional. The disclaimer is a closing note, never the opener and never the whole answer.

WRITING STYLE — VERY IMPORTANT:
- Write in plain, warm, conversational PARAGRAPHS, like a trusted advisor talking to a friend.
- KEEP IT SIMPLE. Assume the reader is brand new to annuities and retirement and may find money topics intimidating. Use short sentences and everyday words, aiming for about an 8th-grade reading level. If you must use a technical term (like "annuitize" or "surrender charge"), explain it in plain words right away. Favor a quick, clear answer over a long thorough one — most people just want it explained simply.
- Do NOT use Markdown. No "#" headers, no "**bold**", no bullet lists, no tables, no emoji. They render as raw symbols and look broken. Use only clear sentences and short paragraphs. If you must list a few items, write them inline in a sentence.
- Keep it concise and easy to read.

OUTPUT FORMAT (exactly):
1. The answer — plain paragraphs. Lead with a story only for situational questions; answer definitional questions directly.
2. A line starting with "SOURCES:" listing the names of the case studies/articles you actually used, comma-separated.
3. A line starting with "FOLLOWUPS:" with exactly three short follow-up questions a curious reader would naturally ask next — each tied to the stories and topics you just discussed — separated by " | ".`;

// Best-effort per-IP rate limits (protects against abuse / runaway API cost).
const LIMIT_MIN = 15;    // max questions per 60 seconds per IP
const LIMIT_HOUR = 200;  // max questions per hour per IP

function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || req.socket?.remoteAddress || 'unknown';
}

// Returns true if this IP is over the limit. Fails OPEN on any DB error.
async function overRateLimit(ip) {
  try {
    const nowMs = Date.now();
    const minIso = new Date(nowMs - 60 * 1000).toISOString();
    const hourIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const [{ count: perMin }, { count: perHour }] = await Promise.all([
      supabaseAdmin.from('chat_logs').select('*', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', minIso),
      supabaseAdmin.from('chat_logs').select('*', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', hourIso)
    ]);
    return (perMin || 0) >= LIMIT_MIN || (perHour || 0) >= LIMIT_HOUR;
  } catch (_) {
    return false; // don't block real users if logging/table is unavailable
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = await readJson(req);
  const question = (body.question || '').toString().slice(0, 2000).trim();
  if (!question) return res.status(400).json({ error: 'Missing question' });

  const rawHistory = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const ip = clientIp(req);

  // --- Pre-work (JSON errors OK here, before we start streaming) ---
  // Rate-limit check and the question embedding are independent → run them together.
  let over = false, qvec = null;
  try {
    [over, qvec] = await Promise.all([overRateLimit(ip), embed(question)]);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
  if (over) return res.status(429).json({ error: 'Too many questions in a short time. Please wait a minute and try again.' });

  // Log the question for analytics — fire-and-forget so it never adds latency.
  Promise.resolve(supabaseAdmin.from('chat_logs').insert({ question, ip })).catch(() => {});

  let chunks = [];
  try {
    const { data, error } = await supabaseAdmin.rpc('match_documents', {
      query_embedding: qvec, match_threshold: 0.22, match_count: 8
    });
    if (error) throw error;
    chunks = data || [];
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }

  const context = chunks
    .map((c, i) => `[Source ${i + 1}: ${c.source || 'Document'}]\n${c.content}`)
    .join('\n\n');
  const sources = [...new Set(chunks.map(c => c.source).filter(Boolean))];

  // Build a clean, strictly-alternating message list: prior turns first, then this question.
  let turns = rawHistory
    .map(t => ({
      role: (t.role === 'ai' || t.role === 'assistant') ? 'assistant' : 'user',
      content: String(t.content || '').slice(0, 1500).trim()
    }))
    .filter(t => t.content);
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const norm = [];
  for (const t of turns) {
    if (norm.length && norm[norm.length - 1].role === t.role) norm[norm.length - 1] = t;
    else norm.push(t);
  }
  if (norm.length && norm[norm.length - 1].role === 'user') norm.pop();

  const messages = [
    ...norm,
    { role: 'user', content: `Context:\n${context || '(no relevant documents were found in the knowledge base)'}\n\nQuestion: ${question}` }
  ];

  // --- Stream the answer token-by-token ---
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // ask proxies not to buffer
  res.write(JSON.stringify({ sources }) + '\n'); // first line = metadata (sources known before generation)

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6', // keep Sonnet for answer quality; streaming makes it feel instant
      max_tokens: 700,
      system: SYSTEM,
      messages
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
        res.write(event.delta.text);
        if (typeof res.flush === 'function') res.flush();
      }
    }
    res.end();
  } catch (e) {
    try { res.write('\n\nSorry — the assistant was interrupted. Please try again.'); } catch (_) {}
    res.end();
  }
}
