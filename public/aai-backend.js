// ============================================================
// AskAnnuityAI — front-end backend bridge
// Exposes window.AAI with real Google auth, AI chat, uploads, leads.
// Load AFTER aai-config.js:
//   <script src="/aai-config.js"></script>
//   <script type="module" src="/aai-backend.js"></script>
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.AAI_CONFIG || {};
const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

function tokenFromStorage() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("sb-") && k.includes("auth-token")) {
        const v = JSON.parse(localStorage.getItem(k) || "{}");
        return v.access_token || (v.currentSession && v.currentSession.access_token) || "";
      }
    }
  } catch (e) {}
  return "";
}
// True if the JWT is missing/expired (with a 60s safety buffer).
function jwtExpired(jwt) {
  try {
    const p = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return !p.exp || (p.exp * 1000 < Date.now() + 60000);
  } catch (e) { return true; }
}
// Race a promise against a timeout so a hung getSession() can't freeze the admin UI.
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
}
async function token() {
  // Use the stored access token only while it's still valid.
  const t = tokenFromStorage();
  if (t && !jwtExpired(t)) return t;
  // Expired or missing → let the Supabase client refresh it (auto-uses the refresh token).
  try {
    const res = await withTimeout(sb.auth.getSession(), 4000);
    const at = res?.data?.session?.access_token;
    if (at && !jwtExpired(at)) return at;
  } catch (e) {}
  // Last resort: force a refresh.
  try {
    const res = await withTimeout(sb.auth.refreshSession(), 4000);
    const at = res?.data?.session?.access_token;
    if (at) return at;
  } catch (e) {}
  return t || ""; // whatever we have, so the caller can surface a clean error
}

const AAI = {
  supabase: sb,

  // ---------- AUTH (real Google OAuth) ----------
  signInWithGoogle() {
    return sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    });
  },
  signOut() { return sb.auth.signOut(); },
  async currentUser() {
    const { data } = await sb.auth.getUser();
    if (!data?.user) return null;
    const u = data.user;
    return {
      id: u.id,
      email: u.email,
      name: u.user_metadata?.full_name || u.user_metadata?.name || (u.email || "").split("@")[0]
    };
  },
  // Fires now + on every sign-in/out. Pass a callback(user|null).
  onAuth(cb) {
    sb.auth.onAuthStateChange(async () => cb(await AAI.currentUser()));
    AAI.currentUser().then(cb);
  },

  // ---------- CHAT (RAG over your documents) ----------
  async askAI(question, history) {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, history: Array.isArray(history) ? history : [] })
    });
    if (!r.ok) throw new Error("chat failed: " + r.status);
    return r.json(); // { answer, sources: [], followups: [] }
  },

  // ---------- ADMIN: upload a file (brochure/PDF/etc.) into the brain ----------
  async uploadDoc(file) {
    const path = `uploads/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const up = await sb.storage.from("documents").upload(path, file, { upsert: false });
    if (up.error) throw up.error;
    const r = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (await token()) },
      body: JSON.stringify({ path, title: file.name })
    });
    if (!r.ok) throw new Error("ingest failed: " + r.status);
    return r.json(); // { ok, document_id, title, chunks }
  },

  // ---------- ADMIN: paste raw text into the brain ----------
  async ingestText(title, text) {
    const r = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (await token()) },
      body: JSON.stringify({ title, text, source: title })
    });
    if (!r.ok) throw new Error("ingest failed: " + r.status);
    return r.json();
  },

  // ---------- LEADS ----------
  async saveLead(data) {
    await fetch("/api/lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    });
  },
  // ---------- ADMIN: read every captured lead from the database ----------
  async getLeads() {
    const r = await fetch("/api/lead", {
      headers: { authorization: "Bearer " + (await token()) }
    });
    if (!r.ok) throw new Error("leads fetch failed: " + r.status);
    const j = await r.json();
    return j.leads || [];
  },
  // ---------- ADMIN: real usage analytics (questions asked, top asks) ----------
  async getStats() {
    const r = await fetch("/api/stats", {
      headers: { authorization: "Bearer " + (await token()) }
    });
    if (!r.ok) throw new Error("stats fetch failed: " + r.status);
    return r.json(); // { total, top:[{q,count}], recent:[] }
  },

  // ---------- CONVERSATION HISTORY (synced across devices) ----------
  // Each conversation is stored as one JSON row keyed by (user_id, convo_id).
  async saveConversationRemote(rec) {
    if (!rec || !rec.id) return;
    const u = await AAI.currentUser();
    if (!u) return;
    await sb.from("user_conversations").upsert({
      user_id: u.id, convo_id: rec.id, title: rec.title || "Conversation",
      data: rec, updated_at: new Date().toISOString()
    }, { onConflict: "user_id,convo_id" });
  },
  async listConversationsRemote() {
    const { data } = await sb.from("user_conversations")
      .select("data, updated_at").order("updated_at", { ascending: false });
    return (data || []).map(r => r.data).filter(Boolean);
  }
};

window.AAI = AAI;
window.dispatchEvent(new Event("aai-ready"));
