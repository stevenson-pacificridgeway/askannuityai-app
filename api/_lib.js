// Shared helpers for the serverless API (runs ONLY on the server).
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Service-role client: full DB access, server-side only. Never expose this key.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Create an embedding vector for a piece of text (used for upload + search).
export async function embed(text) {
  const r = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000)
  });
  return r.data[0].embedding;
}

// Embed many texts in ONE API call (used by ingest for speed + to beat the 60s function limit).
export async function embedMany(texts) {
  const r = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts.map(t => String(t).slice(0, 8000))
  });
  return r.data.map(d => d.embedding);
}

// Is this email allowed into the admin console?
export function isAdmin(email) {
  return (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase())
    .includes((email || '').toLowerCase());
}

// Verify the logged-in user from the Authorization: Bearer <token> header.
export async function getUserFromReq(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data?.user || null;
}

// Read a JSON body whether or not the platform pre-parsed it.
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

// Permissive CORS so the front-end (even on another domain) can call the API.
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

// Send a notification email via Resend. Best-effort: no-ops without a key, never throws.
// Recipient defaults to the Resend account email (free tier only delivers there until a domain is verified).
export async function sendNotifyEmail({ subject, html, text, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const to = process.env.LEAD_NOTIFY_EMAIL || 'stevenson@pacificridgewayinsurance.com';
  const from = process.env.LEAD_NOTIFY_FROM || 'AskAnnuityAI <onboarding@resend.dev>';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text, reply_to: replyTo || undefined }),
      signal: ctrl.signal
    });
    return r.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}
