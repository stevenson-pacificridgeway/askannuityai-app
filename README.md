# AskAnnuityAI

The production app for **askannuityai.com** — an AI that educates people about retirement & annuities, grounded in *your* documents, with real Google accounts and a secure admin for uploading knowledge.

- **Auth & data:** Supabase (Google OAuth, Postgres, Storage, pgvector)
- **AI:** Claude (answers) + OpenAI embeddings (search)
- **Hosting:** Vercel (static front-end + serverless `/api`)

## Quick start
See **SETUP.md** for the full click-by-click. Short version:
1. Push this folder to GitHub.
2. Create a Supabase project, run `supabase/schema.sql`, make a private `documents` bucket, enable the Google provider.
3. Set up a Google OAuth client; add keys to Supabase.
4. Deploy to Vercel with the env vars from `.env.example`.
5. Fill `public/aai-config.js` and apply the edits in **WIRING.md**.
6. Point askannuityai.com at Vercel.

## How the brain works (RAG)
Upload a brochure → `api/ingest.js` extracts text, splits it into chunks, embeds each chunk, and stores it in `doc_chunks`. When someone asks a question → `api/chat.js` embeds the question, finds the closest chunks (`match_documents`), and asks Claude to answer **only from those chunks**, with citations. Add documents anytime; no redeploy needed.
