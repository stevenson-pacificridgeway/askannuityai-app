-- ============================================================
-- AskAnnuityAI — Supabase schema
-- Run this once in: Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================

-- 1) Vector extension (for AI semantic search)
create extension if not exists vector;

-- 2) PROFILES — one row per signed-in user (mirrors auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  is_admin boolean default false,
  created_at timestamptz default now()
);

-- Auto-create a profile when someone signs up with Google.
-- Set ADMIN emails here too (edit the array to match your ADMIN_EMAILS).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, is_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.email = any (array['stevenson@pacificridgewayinsurance.com'])  -- <-- your admin email(s)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) DOCUMENTS — one row per uploaded file/note (brochures, PDFs, etc.)
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 4) DOC_CHUNKS — the AI's "brain". Each chunk of text + its embedding vector.
create table if not exists public.doc_chunks (
  id bigint generated always as identity primary key,
  document_id uuid references public.documents(id) on delete cascade,
  content text not null,
  source text,
  embedding vector(1536),            -- OpenAI text-embedding-3-small = 1536 dims
  created_at timestamptz default now()
);
create index if not exists doc_chunks_embedding_idx
  on public.doc_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 5) CONVERSATIONS + MESSAGES — saved chat history per user
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz default now()
);
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.conversations(id) on delete cascade,
  role text check (role in ('user','ai')),
  content text,
  sources jsonb,
  created_at timestamptz default now()
);

-- 6) LEADS — captured from the welcome popup + contact form
create table if not exists public.leads (
  id bigint generated always as identity primary key,
  name text, email text, phone text, amount text, message text,
  source text,
  created_at timestamptz default now()
);

-- 7) MATCH FUNCTION — semantic search the chat endpoint calls
create or replace function public.match_documents (
  query_embedding vector(1536),
  match_threshold float default 0.2,
  match_count int default 6
) returns table (id bigint, content text, source text, similarity float)
language sql stable as $$
  select dc.id, dc.content, dc.source,
         1 - (dc.embedding <=> query_embedding) as similarity
  from public.doc_chunks dc
  where 1 - (dc.embedding <=> query_embedding) > match_threshold
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles      enable row level security;
alter table public.documents     enable row level security;
alter table public.doc_chunks    enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.leads         enable row level security;

-- Profiles: a user can read/update only their own profile
create policy "own profile read"   on public.profiles for select using (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);

-- Conversations + messages: users see only their own
create policy "own conversations" on public.conversations for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own messages" on public.messages for all
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));

-- Leads: anyone may submit (insert); only admins may read
create policy "anyone can submit a lead" on public.leads for insert with check (true);
create policy "admins read leads" on public.leads for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Documents / chunks: admins manage them. (Retrieval for answers happens
-- server-side with the service-role key, which bypasses RLS — so no public
-- read policy is needed and your knowledge is never exposed wholesale.)
create policy "admins manage documents" on public.documents for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy "admins manage chunks" on public.doc_chunks for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ============================================================
-- CHAT LOGS: every question asked (powers real analytics + rate limiting).
-- Written by the server (service role); RLS on with no policies keeps it
-- unreadable via the anon/public key.
-- ============================================================
create table if not exists public.chat_logs (
  id bigint generated always as identity primary key,
  question text not null,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists chat_logs_ip_created_idx on public.chat_logs (ip, created_at desc);
create index if not exists chat_logs_created_idx on public.chat_logs (created_at desc);
alter table public.chat_logs enable row level security;

-- ============================================================
-- USER CONVERSATIONS: cross-device chat history. One JSON row per
-- conversation, owned by the signed-in user (own-row RLS).
-- ============================================================
create table if not exists public.user_conversations (
  user_id uuid not null,
  convo_id text not null,
  title text,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, convo_id)
);
alter table public.user_conversations enable row level security;
create policy "uc_select" on public.user_conversations for select using (auth.uid() = user_id);
create policy "uc_insert" on public.user_conversations for insert with check (auth.uid() = user_id);
create policy "uc_update" on public.user_conversations for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "uc_delete" on public.user_conversations for delete using (auth.uid() = user_id);

-- ============================================================
-- STORAGE: create a bucket named 'documents' in Dashboard → Storage,
-- keep it PRIVATE. The server uploads/reads it with the service role key.
-- ============================================================
