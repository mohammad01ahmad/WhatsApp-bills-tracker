-- Dedicated Supabase project for the bills tracker. Run once (SQL editor or the
-- supabase MCP).

create table if not exists bills (
  id                   uuid primary key default gen_random_uuid(),
  whatsapp_message_id  text not null unique,          -- Baileys key.id of the receipt image — idempotency + primary /undo anchor
  reply_message_id     text,                          -- Baileys key.id of the bot's confirmation — the other /undo anchor
  total                numeric not null,              -- AED
  merchant             text,
  bill_date            date,                          -- from the receipt; message date if the receipt has none
  category             text not null check (category in (
                         'Petrol', 'Food', 'Building Materials / Hardware Supplies', 'Others')),
  confidence           text check (confidence in ('high', 'medium', 'low')),
  created_at           timestamptz not null default now()
);

-- every summary query filters on created_at
create index if not exists bills_created_idx on bills (created_at desc);

-- RLS on, no policy: the table is not readable with the anon/publishable key.
-- Backend writes use the service-role key, which bypasses RLS. When the dashboard
-- is built, add a select policy here matching whatever gate it uses (single-tenant,
-- so likely a shared-credential gate + server-side reads rather than per-user RLS).
alter table bills enable row level security;

-- bills_testing: where local/dev runs write (BILLS_TABLE=bills_testing, the code
-- default). Production sets BILLS_TABLE=bills; db/client.ts refuses to boot if
-- TARGET_CHAT_JID is set but BILLS_TABLE is not.
--
-- LIKE ... INCLUDING ALL is a one-time SNAPSHOT of bills: columns, defaults, both
-- check constraints, the PK, the unique index on whatsapp_message_id (idempotency
-- depends on it), and the created_at index. It does NOT copy RLS, and it does NOT
-- track later changes — any ALTER to bills above must be repeated here by hand.
create table if not exists bills_testing (like bills including all);
alter table bills_testing enable row level security;
