// POST /api/feedback  { rating:'up'|'down', question, answer, email }
// Lets visitors rate Oscar's answers. On a "not helpful" rating we email you so you
// can review and improve the answer. Best-effort — never blocks the user.
import { sendNotifyEmail, readJson, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = await readJson(req);
  const rating = b.rating === 'down' ? 'down' : 'up';
  const question = (b.question || '').toString().slice(0, 2000);
  const answer = (b.answer || '').toString().slice(0, 6000);
  const email = (b.email || '').toString().slice(0, 200).trim();

  // Only the negative ratings are worth an alert — that's the signal you can act on.
  if (rating === 'down') {
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const when = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px">
        <h2 style="color:#b45309;margin:0 0 4px">An Oscar answer was marked "not helpful"</h2>
        <p style="color:#64748b;margin:0 0 14px">${email ? esc(email) + ' &middot; ' : ''}${esc(when)} PT</p>
        <p style="margin:0 0 8px"><b>Q:</b> ${esc(question) || '(question unavailable)'}</p>
        <div style="background:#f4f7fb;border-left:3px solid #D4A12B;padding:12px 14px;border-radius:6px;color:#28323f;white-space:pre-wrap;line-height:1.6">${esc(answer)}</div>
        <p style="margin:16px 0 0"><a href="https://askannuityai.com/dashboard" style="background:#082B63;color:#fff;text-decoration:none;font-weight:600;padding:9px 16px;border-radius:8px;display:inline-block">Review in the dashboard</a></p>
        <p style="color:#94a3b8;font-size:12px;margin:16px 0 0">Use this to spot weak answers and feed Oscar better knowledge.</p>
      </div>`;
    const text = `Oscar answer marked NOT HELPFUL\n${email ? email + ' · ' : ''}${when} PT\n\nQ: ${question}\n\nA: ${answer}`;
    try { await sendNotifyEmail({ subject: 'AskAnnuityAI — an Oscar answer was marked not helpful', html, text }); } catch (_) {}
  }
  res.status(200).json({ ok: true });
}
