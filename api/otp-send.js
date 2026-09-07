// /api/otp-send
//   POST { phone }  -> texts a 6-digit verification code via Twilio Verify.
// Reads secrets from env only (never from the browser):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID
import { cors, readJson } from './_lib.js';

const digits = (s) => String(s == null ? '' : s).replace(/[^0-9+]/g, '');

// Normalize to E.164. Bare 10-digit numbers are assumed US (+1).
function toE164(raw) {
  let p = digits(raw);
  if (!p) return '';
  if (p.startsWith('+')) return p;
  if (p.length === 10) return '+1' + p;
  if (p.length === 11 && p.startsWith('1')) return '+' + p;
  return '+' + p;
}

// Reject obvious junk US numbers BEFORE we spend a Twilio text on them.
// Returns a friendly reason string if the number looks fake, else ''.
function fakeReason(e164) {
  const p = digits(e164).replace(/^\+/, '');
  // Only screen US/CA (+1, 11 digits starting with 1). Leave other countries to Twilio.
  if (!(p.length === 11 && p.startsWith('1'))) {
    if (p.length < 8) return 'That number looks too short.';
    return '';
  }
  const nat = p.slice(1);                 // 10-digit national number
  const area = nat.slice(0, 3);
  const exch = nat.slice(3, 6);
  if (/^(\d)\1{9}$/.test(nat)) return 'That number can’t be right — please use your real mobile.';
  if (nat === '1234567890' || nat === '0123456789') return 'Please enter your real mobile number.';
  if (area[0] === '0' || area[0] === '1') return 'That area code isn’t valid.';
  if (area === '555' || exch === '555') return 'Please enter your real mobile number.';
  if (area[1] === '9' && area[2] === '9') return 'That area code isn’t valid.';   // N9 9 unassigned block
  if (exch[0] === '0' || exch[0] === '1') return 'That number isn’t valid.';
  return '';
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
  if (!phone || phone.length < 8) return res.status(400).json({ error: 'A valid mobile number is required.' });

  const bad = fakeReason(phone);
  if (bad) return res.status(400).json({ error: bad });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`https://verify.twilio.com/v2/Services/${service}/Verifications`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: phone, Channel: 'sms' }),
      signal: ctrl.signal
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: data.message || 'Could not send the code. Check the number.' });
    return res.status(200).json({ ok: true, to: phone, status: data.status });
  } catch (e) {
    return res.status(500).json({ error: 'Could not send the code right now.' });
  } finally {
    clearTimeout(t);
  }
}
