# AskAnnuityAI — Production Setup Guide

This turns the prototype into the real thing: **real Google sign-in**, a **secure admin** only you can enter, and **document uploads (brochures, PDFs, anything) that permanently feed the AI** — with answers grounded in *your* material and cited.

**Stack:** Supabase (auth + database + file storage + vector search) · Claude (answers) · OpenAI (embeddings only) · Vercel (hosting).
**Cost to start:** ~$0 (free tiers) + a few cents per conversation in AI usage.

> You'll create three accounts and paste in some keys. I (Claude) can walk you through every screen — but you enter the secret values yourself; I never handle passwords/secrets.

---

## What's in this folder
```
askannuityai-app/
├─ api/                 serverless backend (runs on Vercel)
│  ├─ chat.js           RAG: answers questions from your docs (Claude)
│  ├─ ingest.js         ADMIN: turns uploaded files/text into AI memory
│  ├─ lead.js           saves leads
│  └─ _lib.js           shared helpers
├─ public/
│  ├─ index.html        the website (your existing UI)
│  ├─ aai-config.js     <- you paste your Supabase URL + anon key here
│  └─ aai-backend.js    bridge: real auth, chat, uploads, leads
├─ supabase/schema.sql  run once in Supabase to create the database
├─ .env.example         the server secrets you'll set in Vercel
├─ vercel.json
└─ package.json
```

---

## Step 1 — Put the code on GitHub
Create a new repo (e.g. `askannuityai-app`) and upload this whole folder. (Your GitHub autopush will redeploy on every change once Vercel is connected.)

## Step 2 — Supabase (database + auth + storage)
1. Go to **supabase.com** → New project. Pick a name + strong DB password. Wait ~2 min.
2. Left sidebar → **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**.
   - In that file, the admin email is already set to `stevenson@pacificridgewayinsurance.com`. Edit the array if you want more admins.
3. Left sidebar → **Storage** → New bucket → name it exactly **`documents`** → keep it **Private** → Create.
4. Left sidebar → **Project Settings → API**. Copy these (you'll need them soon):
   - **Project URL**
   - **anon public** key
   - **service_role** key (secret — server only)

## Step 3 — Google sign-in (OAuth)
1. **console.cloud.google.com** → create/select a project.
2. **APIs & Services → OAuth consent screen** → External → fill app name "AskAnnuityAI", your email, save.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application**.
   - **Authorized JavaScript origins:** `https://askannuityai.com`
   - **Authorized redirect URIs:** paste the callback URL from Supabase → **Authentication → Providers → Google** (looks like `https://YOUR-PROJECT.supabase.co/auth/v1/callback`).
   - Create → copy the **Client ID** and **Client secret**.
4. Back in Supabase → **Authentication → Providers → Google** → toggle **Enabled**, paste the Client ID + secret → Save.
5. Supabase → **Authentication → URL Configuration** → set **Site URL** to `https://askannuityai.com` and add it to **Redirect URLs**.

## Step 4 — AI keys
- **Anthropic (Claude):** console.anthropic.com → API Keys → create one (`sk-ant-…`).
- **OpenAI (embeddings only):** platform.openai.com → API Keys → create one (`sk-…`). Pennies of usage.

## Step 5 — Deploy on Vercel
1. **vercel.com** → Add New → Project → import your GitHub repo.
2. **Settings → Environment Variables** — add (from `.env.example`):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
   - `ADMIN_EMAILS` = `stevenson@pacificridgewayinsurance.com`
3. Deploy. You'll get a live `…vercel.app` URL — test it there first.

## Step 6 — Point askannuityai.com at Vercel
1. Vercel → Project → **Settings → Domains** → add `askannuityai.com`.
2. Vercel shows the exact DNS records. In **Namecheap → askannuityai.com → Advanced DNS**, replace the current GitHub Pages A records with Vercel's record(s) (usually an A record `@ → 76.76.21.21` and a CNAME `www → cname.vercel-dns.com` — use whatever Vercel displays).
   - *(This moves the domain off GitHub Pages onto the real app. I can do this DNS step in your browser for you.)*

## Step 7 — Connect the front-end
1. Open `public/aai-config.js` and paste your **Project URL** + **anon** key.
2. Make the 6 small edits in `public/index.html` listed in **WIRING.md** (or just tell me and I'll do them). They swap the demo brain/auth for the real ones:
   - Google buttons → `AAI.signInWithGoogle()`
   - auth state → real user
   - chat `send()` → `AAI.askAI()`
   - admin upload → `AAI.uploadDoc()`
   - admin paste → `AAI.ingestText()`
   - lead forms → `AAI.saveLead()`

## Step 8 — Go
1. Visit askannuityai.com → **Sign in with Google** (you'll be the admin automatically).
2. Open **Admin → Knowledge** → drag in your brochures/PDFs. Each one is extracted, embedded, and added to the brain in seconds.
3. Ask a question → the answer now comes from *your* documents, with citations.

---

## Security (why this is bulletproof)
- Secrets (service role, API keys) live **only on the server** (Vercel env) — never in the browser.
- The admin is gated by your **Google identity + an allow-list**, not a password in the code.
- **Row Level Security** means users can only see their own chats; only admins can read leads or manage documents.
- Uploaded files sit in a **private** bucket; the server reads them with the service role.

## Keeping the brain fed (your "continuously learning" goal)
- Upload anytime through Admin → it's instantly searchable. No redeploy needed.
- Want auto-sync from Google Drive/Dropbox later? We add a scheduled function that ingests new files on a timer. (Obsidian is fine for *authoring* — just export/upload the notes; the live brain stays in Supabase.)
