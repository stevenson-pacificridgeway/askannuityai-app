// POST /api/chat  { question }  ->  { answer, sources }
// RAG: embed question -> find relevant chunks -> Claude answers from them, with citations.
import { supabaseAdmin, anthropic, embed, readJson, cors, isAdmin, sendNotifyEmail } from './_lib.js';

const SYSTEM = `You are Oscar, a warm, calm, expert educational guide for retirement and annuity questions. You're the friendly AI assistant for AskAnnuityAI, representing Pacific Ridgeway and grounded in the work of Gregory Stevenson, author of "Indexed Annuity Secrets." If someone asks your name or who you are, tell them you're Oscar. Don't force your name into normal answers — just be Oscar naturally.

HOW TO ANSWER — FIRST, JUDGE THE QUESTION TYPE:
- SITUATIONAL questions (a person describing or weighing their own situation: "should I…", "what happens if my spouse dies", "I'm 60 with $500k", "is X right for someone like me"): If the context contains a case study about someone in a genuinely similar situation, lead with it — name the person and what happened, then draw out the lesson. This is where the stories shine.
- DEFINITIONAL / FACTUAL questions ("what is an annuity", "how does an income rider work", "what's the difference between a fixed and variable annuity", "how are annuities taxed"): Answer the QUESTION directly, clearly, and plainly first. Do NOT open with someone's personal story. You may include a brief, relevant real example LATER if it genuinely helps illustrate the concept — but only if it fits.
- NEVER force a story that doesn't match the question's topic. It makes no sense to answer "what is an annuity, simply?" by opening with a story about someone dying. A mismatched or morbid story is worse than no story. When in doubt, just answer the question well.
- If the question is clearly outside retirement/annuities/personal finance, politely say it's outside what you cover and offer to help with a retirement question instead.
- Ground every answer in the provided context. Never invent facts, figures, names, dollar amounts, or quotes. If the context doesn't cover it, say so plainly and suggest a quick call for specifics. Do not fabricate a person or a case to satisfy the "lead with a story" idea.
- If a provided source is not clearly relevant to THIS question, ignore it entirely and do not list it under SOURCES. Only cite sources you actually used.
- For a short follow-up (e.g. "what about her?", "and if I wait?"), interpret it using the earlier conversation turns rather than treating it as a brand-new topic.
- "Should I…" questions are NOT off-limits — answer them educationally and usefully, then add ONE brief closing line that their exact numbers should be confirmed with a licensed professional. The disclaimer is a closing note, never the opener and never the whole answer.
- HARD RULE ON NUMBERS: NEVER invent, estimate, or guess any specific dollar income figure, monthly or annual amount, payout percentage, rollup rate, or numeric range. The ONLY numbers you may ever state are those given verbatim in an "INCOME ESTIMATE" block in this prompt. If there is NO such block, give ZERO numbers — do not say things like "$17,500 to $20,000" or "5 to 7 percent." This is critical: wrong numbers on a financial site are worse than no numbers.
- MONEY/INCOME questions (e.g. "I'm 62 with $300k, how do I turn it into guaranteed income?"): Keep it short and confident. Tell them the play in plain words — roll the old 401(k) or IRA over into a fixed indexed annuity with a guaranteed lifetime income rider, which turns their savings into a paycheck they can't outlive — and note that the longer they wait before switching the income on, the bigger that paycheck. If an "INCOME ESTIMATE" block appears below, USE those figures exactly as given, ALWAYS stated as annual (per-year) amounts — never convert to monthly even if they asked "how much per month" — framed as a rough estimate, and offer to have a licensed agent run their exact numbers. If there is NO income-estimate block, describe the play WITHOUT any numbers and offer the exact figures on a call. Two to four short sentences.

WRITING STYLE — VERY IMPORTANT (BE BRIEF):
- Keep answers SHORT — aim for 2 to 4 short sentences. Most people just want a quick, clear answer, not an essay. Never pad or over-explain.
- Lead with the answer in the first sentence. Plain, everyday words, about an 8th-grade reading level; if you use a technical term, define it in a few words.
- Warm and confident, like a trusted advisor giving a fast, simple answer. End situational/"how do I" answers with one short line offering a quick call for their exact numbers.
- Only tell a case-study story when the question is clearly about a personal situation AND it truly helps — and keep it to one or two sentences, never a long anecdote.
- Do NOT use Markdown. No headers, no "**bold**", no bullet lists, no tables, no emoji. Just a few short, clear sentences.

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

// ---- Midland income estimator ---------------------------------------------
// Calibrated from Midland National's PUBLIC MNL Income Planning Annuity calculator
// (single life, guaranteed lifetime withdrawal benefit), pulled July 2026:
//   immediate income per $100k — age 60: $7,110 · 62: $7,320 · 65: $7,630 · 70: $8,150
//   deferral grows the payout ~10% for each year you wait, up to 10 years (verified:
//   60→70 predicted $18,441 vs calculator $18,450). These are ESTIMATES, not quotes.
function baseIncomePer100k(age) {
  const anchors = [[55, 6600], [60, 7110], [62, 7320], [65, 7630], [70, 8150], [75, 8670], [80, 9190]];
  const a = Math.max(55, Math.min(80, age));
  for (let i = 0; i < anchors.length - 1; i++) {
    const [a0, v0] = anchors[i], [a1, v1] = anchors[i + 1];
    if (a >= a0 && a <= a1) return v0 + (v1 - v0) * ((a - a0) / (a1 - a0));
  }
  return anchors[anchors.length - 1][1];
}
function midlandEstimate(age, amount, targetAge, joint) {
  // Joint-life (based on the younger person) runs ~90.5% of single life on Midland's calculator.
  const per100 = baseIncomePer100k(age) * (joint ? 0.905 : 1);
  const units = amount / 100000;
  const defYears = Math.max(0, Math.min(10, (targetAge || age) - age));
  const round100 = n => Math.round(n / 100) * 100;
  return {
    immediate: round100(units * per100),
    deferred: round100(units * per100 * Math.pow(1.10, defYears)),
    defYears, targetAge: targetAge || age
  };
}
function parseMoney(text) {
  const t = text.toLowerCase();
  let m = t.match(/\$?\s*([\d.,]+)\s*(?:m|mm|million)\b/);
  if (m) { const n = parseFloat(m[1].replace(/,/g, '')); if (n > 0 && n < 100) return Math.round(n * 1e6); }
  m = t.match(/\$?\s*([\d.,]+)\s*(?:k|thousand)\b/);
  if (m) { const n = parseFloat(m[1].replace(/,/g, '')); if (n > 0) return Math.round(n * 1e3); }
  m = t.match(/\$\s*([\d,]{2,}(?:\.\d+)?)/) || t.match(/\b(\d{1,3},\d{3})\b/) || t.match(/\b(\d{5,8})\b/);
  if (m) { const n = Math.round(parseFloat(m[1].replace(/,/g, ''))); if (n >= 10000 && n <= 1e8) return n; }
  return null;
}
function parseAge(text) {
  const t = text.toLowerCase();
  let m = t.match(/\b(?:i['’]?m|i am|age|aged|turning)\s*(\d{2})\b/) ||
          t.match(/\b(\d{2})\s*(?:years?\s*old|yo|-?year-?old|y\/o)\b/);
  if (m) { const a = +m[1]; if (a >= 45 && a <= 85) return a; }
  const nums = [...t.matchAll(/\b(\d{2})\b/g)].map(x => +x[1]).filter(a => a >= 45 && a <= 85);
  return nums.length ? nums[0] : null;
}
function parseTargetAge(text, curAge) {
  const t = text.toLowerCase();
  let m = t.match(/\b(?:at|by|until|when i['’]?m|start(?:ing)? at)\s*(?:age\s*)?(\d{2})\b/);
  if (m) { const a = +m[1]; if (a > curAge && a <= 85) return a; }
  m = t.match(/\b(?:in|wait|after)\s*(\d{1,2})\s*years?\b/);
  if (m) { const n = +m[1]; if (n > 0 && n <= 20) return curAge + n; }
  return null;
}
// Build a "use these numbers" directive when the visitor mentions an amount + age and the topic is income.
// Looks across the current message PLUS the last few user turns, so follow-ups still get real numbers.
function incomeEstimateDirective(question, contextText) {
  try {
    const ctx = ((contextText || '') + ' ' + question).trim();
    const amt = parseMoney(question) || parseMoney(ctx);
    const incomeish = /(income|paycheck|401\s*\(?k\)?|\bira\b|roll\s* ?over|rollover|retire|nest egg|savings|turn .* into|guaranteed|annuit|per month|monthly|payout|withdraw|how much)/i.test(ctx);
    if (!amt || !incomeish) return '';
    // Couple / joint case; joint payouts are based on the YOUNGER person's age.
    const joint = /\b(joint|couple|married|spouse|my (?:wife|husband|partner)|our (?:savings|money|nest egg|retirement|401|ira)|both of us|we(?:'re| are| both)?)\b/i.test(ctx);
    const ages = [...ctx.toLowerCase().matchAll(/\b(\d{2})\b/g)].map(x => +x[1]).filter(a => a >= 45 && a <= 85);
    let age = parseAge(question) || parseAge(ctx);
    if (joint && ages.length) age = Math.min(...ages);
    if (!age || age < 50 || age > 85) return '';
    const tgt = parseTargetAge(question, age) || parseTargetAge(ctx, age) || (age + 5);
    const e = midlandEstimate(age, amt, tgt, joint);
    const fmt = n => '$' + n.toLocaleString('en-US');
    const kind = joint ? 'joint-life (based on the younger person)' : 'single-life';
    return `\n\nINCOME ESTIMATE — you MUST use these exact figures (rounded) as an ESTIMATE. Do NOT substitute your own numbers, ranges, or payout percentages, and ALWAYS state them as ANNUAL (per year) amounts — never monthly, even if the visitor said "monthly" or "per month":\n`
      + `Source: Midland National's public MNL Income Planning Annuity calculator (${kind}, guaranteed lifetime withdrawal benefit). `
      + `For about ${fmt(amt)} at age ${age}: starting income NOW is about ${fmt(e.immediate)} per year; `
      + `if they wait until age ${e.targetAge} (${e.defYears} years) it is about ${fmt(e.deferred)} per year. `
      + `Present both scenarios in per-year terms only, say they'd roll the money into the annuity, and note the exact figure comes from a licensed illustration. Never call it a guaranteed quote.`;
  } catch (_) { return ''; }
}
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = await readJson(req);
  const question = (body.question || '').toString().slice(0, 2000).trim();
  if (!question) return res.status(400).json({ error: 'Missing question' });

  const rawHistory = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const ip = clientIp(req);
  // If the visitor is signed in with Google, the front-end passes their email so we know WHO asked.
  const askerEmail = (body.email || '').toString().slice(0, 200).trim();

  // If this is an income question with an age + dollar amount (in this message OR a recent turn),
  // compute real Midland estimates and hand them to the model so it quotes concrete numbers.
  const recentUserText = rawHistory.filter(t => t && t.role === 'user').slice(-4).map(t => String(t.content || '')).join(' ');
  const systemFull = SYSTEM + incomeEstimateDirective(question, recentUserText);

  // --- Pre-work (JSON errors OK here, before we start streaming) ---
  // Rate-limit check and the question embedding are independent → run them together.
  let over = false, qvec = null;
  try {
    [over, qvec] = await Promise.all([overRateLimit(ip), embed(question)]);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
  if (over) return res.status(429).json({ error: 'Too many questions in a short time. Please wait a minute and try again.' });

  // Reserve a log row NOW (answer filled in after streaming). This makes the request
  // immediately visible to the rate limiter, so concurrent bursts from one IP can't all
  // slip through by racing the end-of-stream insert.
  let logId = null;
  try {
    const { data: ins } = await supabaseAdmin
      .from('chat_logs').insert({ question, ip, email: askerEmail || null }).select('id').single();
    logId = ins?.id ?? null;
  } catch (_) { /* logging is best-effort; never block the answer */ }

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

  let answerText = '';
  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6', // keep Sonnet for answer quality; streaming makes it feel instant
      max_tokens: 450, // short answers — a couple of sentences plus the SOURCES/FOLLOWUPS lines
      system: systemFull,
      messages
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
        const t = event.delta.text;
        answerText += t;
        res.write(t);
        if (typeof res.flush === 'function') res.flush();
      }
    }
  } catch (e) {
    try { res.write('\n\nSorry — the assistant was interrupted. Please try again.'); } catch (_) {}
  }
  // Log the question + the answer the AI actually gave (+ who asked, if signed in).
  // Tokens are already delivered, so this adds no perceptible latency.
  const cleanAnswer = answerText.replace(/\n*(SOURCES:|FOLLOWUPS:)[\s\S]*$/i, '').trim().slice(0, 8000);
  try {
    if (logId) await supabaseAdmin.from('chat_logs').update({ answer: cleanAnswer || null }).eq('id', logId);
    else await supabaseAdmin.from('chat_logs').insert({ question, ip, email: askerEmail || null, answer: cleanAnswer || null });
  } catch (_) {}

  // Email a notification when a SIGNED-IN visitor asks (so you know who's engaging + what they asked).
  // Skips anonymous visitors and your own admin accounts to keep the inbox useful. Best-effort, non-blocking.
  if (askerEmail && !isAdmin(askerEmail)) {
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const when = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const ans = cleanAnswer || '(the assistant did not return an answer)';
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px">
        <h2 style="color:#082B63;margin:0 0 4px">New question on AskAnnuityAI</h2>
        <p style="color:#64748b;margin:0 0 16px">${esc(askerEmail)} &middot; ${esc(when)} PT</p>
        <p style="font-size:16px;color:#0f172a;margin:0 0 10px"><b>Q:</b> ${esc(question)}</p>
        <div style="background:#f4f7fb;border-left:3px solid #D4A12B;padding:12px 14px;border-radius:6px;color:#28323f;font-size:14.5px;line-height:1.6;white-space:pre-wrap">${esc(ans)}</div>
        <p style="margin:20px 0 0"><a href="https://askannuityai.com/dashboard" style="background:#082B63;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;display:inline-block">Open the live dashboard</a></p>
        <p style="color:#94a3b8;font-size:12px;margin:18px 0 0">You're getting this because a signed-in visitor asked a question. Reply to this email to reach them at ${esc(askerEmail)}.</p>
      </div>`;
    const text = `New question on AskAnnuityAI\n${askerEmail} · ${when} PT\n\nQ: ${question}\n\nA: ${ans}\n\nDashboard: https://askannuityai.com/dashboard`;
    try { await sendNotifyEmail({ subject: `AskAnnuityAI — new question from ${askerEmail}`, html, text, replyTo: askerEmail }); } catch (_) {}
  }
  res.end();
}
