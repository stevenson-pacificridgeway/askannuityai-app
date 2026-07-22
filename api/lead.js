// /api/lead
//   POST { name, email, phone, amount, message, source }  -> stores a lead (public)
//   GET   (ADMIN ONLY, Bearer token)                       -> returns all leads
// On a new lead, emails an instant notification via Resend (best-effort).
import { supabaseAdmin, isAdmin, getUserFromReq, readJson, cors } from './_lib.js';

const esc = (x) => String(x == null ? '' : x)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Send an instant "new lead" email. No-ops quietly if RESEND_API_KEY isn't set,
// and never throws — a notification failure must not break saving the lead.
async function notifyNewLead(lead) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  // Resend free tier only delivers to the account-owner email (stevenson@pacificridgewayinsurance.com)
  // until a domain is verified. Override with LEAD_NOTIFY_EMAIL once a domain is verified.
  const to = process.env.LEAD_NOTIFY_EMAIL || 'stevenson@pacificridgewayinsurance.com';
  const from = process.env.LEAD_NOTIFY_FROM || 'AskAnnuityAI Leads <onboarding@resend.dev>';
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const who = lead.name || lead.email || 'Website visitor';
  const row = (k, v) => v ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${k}</td><td style="padding:4px 0;color:#0f172a"><b>${esc(v)}</b></td></tr>` : '';
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px">
      <h2 style="color:#082B63;margin:0 0 4px">New lead from AskAnnuityAI</h2>
      <p style="color:#64748b;margin:0 0 16px">${esc(who)} — ${esc(lead.source || 'website')} · ${esc(when)} PT</p>
      <table style="border-collapse:collapse;font-size:15px">
        ${row('Name', lead.name)}${row('Email', lead.email)}${row('Phone', lead.phone)}
        ${row('Amount', lead.amount)}${row('Source', lead.source)}${row('Message', lead.message)}
      </table>
      ${lead.phone ? `<p style="margin:18px 0 0"><a href="tel:${esc(String(lead.phone).replace(/[^0-9+]/g,''))}" style="background:#D4A12B;color:#0a1730;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;display:inline-block">Call ${esc(lead.phone)}</a></p>` : ''}
      <p style="color:#94a3b8;font-size:12px;margin:20px 0 0">Sent automatically by AskAnnuityAI.</p>
    </div>`;
  const text = `New lead from AskAnnuityAI\n${who} — ${lead.source || 'website'} · ${when} PT\n\n`
    + ['name', 'email', 'phone', 'amount', 'source', 'message']
        .filter(k => lead[k]).map(k => `${k}: ${lead[k]}`).join('\n');
  const subject = `AskAnnuityAI — new lead: ${who}${lead.source ? ' (' + lead.source + ')' : ''}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text, reply_to: lead.email || undefined }),
      signal: ctrl.signal
    });
  } catch (_) { /* best-effort */ } finally { clearTimeout(t); }
}

// Forward every captured lead to the Follow Up Boss CRM via your RidgeCRM webhook. Best-effort — never
// throws and never blocks the save, so a CRM outage can never lose a lead. No API key here: your
// Railway server holds the Follow Up Boss key and does the authenticated call.
async function forwardToCrm(lead) {
  const url = process.env.CRM_WEBHOOK_URL || 'https://ridgecrm-production.up.railway.app/api/website-lead';
  if (!url) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: lead.name || '',
        email: lead.email || '',
        phone: lead.phone || '',
        source: lead.source || 'AskAnnuity AI',   // tag by where the lead came from
        message: lead.message || ''
      }),
      signal: ctrl.signal
    });
  } catch (_) { /* swallow — the lead is already saved */ } finally {
    clearTimeout(t);
  }
}

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
    const name = (b.name || '').trim();
    const phone = (b.phone || '').trim();
    const message = (b.message || '').trim();

    // Validate: require a plausible email plus at least one other real field.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!name && !phone && !message && !b.amount) {
      return res.status(400).json({ error: 'Please add your name or a message.' });
    }

    // Coarse flood protection (leads table has no per-IP column): cap total new leads per minute.
    try {
      const minAgo = new Date(Date.now() - 60 * 1000).toISOString();
      const { count } = await supabaseAdmin
        .from('leads').select('*', { count: 'exact', head: true }).gte('created_at', minAgo);
      if ((count || 0) >= 20) {
        return res.status(429).json({ error: 'Too many submissions right now. Please try again shortly.' });
      }
    } catch (_) { /* never block a real lead on a counting error */ }

    // Dedupe: welcome-popup auto-signups dedupe forever; contact-form dupes dedupe within 3 minutes.
    if (/welcome/i.test(source)) {
      const { data: dupes } = await supabaseAdmin
        .from('leads').select('id').eq('email', email).eq('source', source).limit(1);
      if (dupes && dupes.length) return res.status(200).json({ ok: true, deduped: true });
    } else {
      const winAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const { data: dupes } = await supabaseAdmin
        .from('leads').select('id').eq('email', email).eq('source', source)
        .gte('created_at', winAgo).limit(1);
      if (dupes && dupes.length) return res.status(200).json({ ok: true, deduped: true });
    }

    const lead = { name, email, phone, amount: b.amount || '', message, source };
    const { error } = await supabaseAdmin.from('leads').insert(lead);
    if (error) throw error;
    // Notify you by email AND forward to your CRM — both best-effort, in parallel, never blocking the save.
    await Promise.allSettled([notifyNewLead(lead), forwardToCrm(lead)]);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
