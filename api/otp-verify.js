// /api/otp-verify
//   POST { phone, code }  -> checks the 6-digit code via Twilio Verify.
//   Returns { ok:true, verified: true|false }
import { cors, readJson } from './_lib.js';

const digits = (s) => String(s == null ? '' : s).replace(/[^0-9+]/g, '');

function toE164(raw) {
  let p = digits(raw);
  if (!p) return '';
  if (p.startsWith('+')) return p;
  if (p.length === 10) return '+1' + p;
  if (p.length === 11 && p.startsWith('1')) return '+' + p;
  return '+' + p;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid || !token || !service) {
    return res.status(500).json({ error: 'Phone verification is not configured yet.' });
  }

  const b = await readJson(req);
  const phone = toE164(b.phone);
  const code = String(b.code || '').replace(/[^0-9]/g, '');
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required.' });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`https://verify.twilio.com/v2/Services/${service}/VerificationCheck`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: phone, Code: code }),
      signal: ctrl.signal
    });
    const data = await r.json().catch(() => ({}));
    const verified = r.ok && data.status === 'approved';
    return res.status(200).json({ ok: true, verified });
  } catch (e) {
    return res.status(500).json({ error: 'Could not check the code right now.' });
  } finally {
    clearTimeout(t);
  }
}
