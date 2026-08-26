# WhatsApp Bill Tracker

**Owner:** Ahmad (builder & operator)
**For:** a friend's small business
**Status:** Design draft — no code yet
**Last updated:** 2026-08-26

A low-friction expense tracker for a small business. Employees drop photos of receipts and
invoices into a shared WhatsApp group; a bot on a **dedicated WhatsApp number** in that group
reads each image with a vision LLM, extracts the total / merchant / date / category, writes a
row to Supabase, and replies with a confirmation plus today's running total. `/today`,
`/week`, `/month` give spending summaries; `/undo` (as a reply to a receipt or the bot's
confirmation) removes that one bill. A dashboard comes later.

It is a sibling of [`../whatsapp-calorie-tracker`](../whatsapp-calorie-tracker) and reuses
its WhatsApp connection layer wholesale (`socket.ts`, `reconnect.ts`, `fatal.ts`,
`whatsapp/constants.ts`) — copied, not shared. See that project's README for the deep
Baileys / GCP / Supabase background.

- **`docs/PRD.md`** — the full product spec, decisions, risks, and build plan.
- **`CLAUDE.md`** — the build contract and the reasoning behind each design choice.

---

## 1. Problem

A business owner needs to track field spending — fuel, building materials, food — paid by
several employees, collected as paper receipts. Month-end collection is lossy and late, and
nobody wants a finance app. The employees already coordinate in a WhatsApp group. Turning "a
photo of a receipt, sent the moment it's paid" into a categorized, queryable expense — zero
data entry, no new app — is the whole idea.

## 2. Scope (v1)

- **Trigger:** every image posted in **one** designated group (`TARGET_CHAT_JID`). No caption
  or prefix. No sender restriction — any employee logs a bill by posting a photo. (Deliberate
  trust-boundary widening vs. the calorie tracker — see `CLAUDE.md` § Flow.)
- **`is_receipt` gate:** the model flags non-receipts (job-site photos, screenshots, chat
  images); the bot ignores those silently — no reply, no row.
- **Extraction:** `google/gemma-4-31b-it:free` via OpenRouter (both environments) — loose
  JSON, fence-strip, validate, one retry. The paid `google/gemma-4-31b-it` slug (strict JSON
  schema) is a fallback, flipped via `OPENROUTER_MODEL`. Returns
  `{ is_receipt, total, merchant, bill_date, category, confidence }`.
- **Storage:** a **dedicated Supabase project for this business**, new `bills` table. Single
  tenant — no `user_id`. The receipt image is **not** stored.
- **Confirmation reply:** a `RECEIPT PROCESSED` block (amount, company, expense) + today's
  running total. No budget, no progress bar.
- **Commands, open to every group member:** `/today`, `/week`, `/month`, `/undo`.
- **Currency:** AED only, assumed, not stored. Every invoice is guaranteed AED.
- **Timezone:** fixed offset Asia/Dubai (UTC+4), no DST, in app code. Calendar periods.
- **Hosting:** always-on Node process, Docker, on a GCP Always-Free `e2-micro` **in the
  friend's own GCP account**.

## 3. Out of scope (v1)

- **Dashboard** — deferred; backend first. (`bills` has RLS on with no policy — the dashboard
  adds one to match its gate.)
- **Automatic / scheduled summaries** — no cron push of an end-of-day total. Commands only.
- **Per-employee attribution** — the sender is not stored.
- **Approval / reimbursement workflow.**
- **Receipt image retention** — nothing is uploaded or stored; can't re-check a total against
  the original later.
- **Admin-restricted commands** — every command is open to every group member (see
  `docs/PRD.md` § 16).
- **Duplicate detection** for two photos of the same physical receipt — caught via `/undo`
  and the dashboard.
- **Multi-currency** — no handling, no conversion.
- **Editable categories** — the 4-value enum is fixed in code and DB.

## 4. Flow

1. An employee posts a photo in the group.
2. Baileys (the bot is a companion device on the dedicated number) delivers it as a
   `messages.upsert` event inside the Node process — no webhook.
3. Backend filters: the watched chat (the group in prod, the linked account's self-chat when
   `TARGET_CHAT_JID` is unset)? not a message the bot itself sent? is it an image? Then
   downloads the buffer (with `reuploadRequest`, since WhatsApp media URLs expire) and size-caps it.
4. Image → OpenRouter (Gemma `:free` vision): JSON shape in the prompt, fence-strip,
   hand-validate, one retry. (Paid slug + strict schema is the `OPENROUTER_MODEL` fallback.)
5. **`is_receipt` false or `total` null → debug-log and stop. No reply.**
6. Row inserted into `bills` **before** replying. A duplicate `whatsapp_message_id` →
   unique-index violation → treated as "already logged", no second confirmation.
7. Reply sent in the group: the `RECEIPT PROCESSED` block + today's total. The confirmation's
   message id is stored on the row (`reply_message_id`) so `/undo` can target it.

For a text command, steps 3–6 are replaced by a query. `/undo` **must be a reply** — it
deletes the one bill whose receipt image *or* confirmation message the user quoted (see § 7).

## 5. Data model

A **dedicated Supabase project** for this business — not the calorie tracker's. New table:

```sql
create table bills (
  id                   uuid primary key default gen_random_uuid(),
  whatsapp_message_id  text not null unique,          -- Baileys key.id of the receipt image — idempotency + primary /undo anchor
  reply_message_id     text,                          -- Baileys key.id of the bot's confirmation — the other /undo anchor; nullable
  total                numeric not null,              -- AED
  merchant             text,
  bill_date            date,                          -- from the receipt; message date if the receipt has none
  category             text not null check (category in (
                         'Petrol', 'Food', 'Building Materials / Hardware Supplies', 'Others')),
  confidence           text check (confidence in ('high', 'medium', 'low')),
  created_at           timestamptz not null default now()
);

create index bills_created_idx on bills (created_at desc);
alter table bills enable row level security;   -- no policy: not readable with the anon key
```

- **No `user_id`** — single tenant, backend writes with the service-role key. Dropping the
  `auth.users` FK means no auth user to pre-create.
- No `currency` column — every invoice is AED.
- `created_at` is what period queries filter on; `bill_date` is informational.
- `select`-only RLS: the future dashboard reads with the publishable key + the owner's
  session; writes are service-role and bypass RLS.

## 6. Extraction

**Model:** `google/gemma-4-31b-it:free` via OpenRouter in **both environments**, set by
`OPENROUTER_MODEL`. The client keys its JSON strategy off the `:free` suffix:

- **`:free` (default):** no strict schema — the shape goes in the prompt, output is
  fence-stripped, hand-validated, and retried once on failure.
- **`google/gemma-4-31b-it` (paid) — fallback:** supports `structured_outputs`, so the client
  switches to a strict `response_format: { type: "json_schema", strict: true }` and drops the
  retry. Flip `OPENROUTER_MODEL` if `:free` reliability is too low. See `CLAUDE.md`
  § "JSON handling — model slug decides it".

**Prompt shape:** a system message stating the task (read a receipt/invoice image; if it
isn't one, set `is_receipt: false`) followed by the image as a base64 `data:` URL.

**Category** — the model picks exactly one:

| Category | For |
|---|---|
| `Petrol` | Fuel stations |
| `Food` | Groceries, restaurants, cafes |
| `Building Materials / Hardware Supplies` | Hardware stores, construction / DIY supplies |
| `Others` | Anything that doesn't clearly fit above |

*(The friend's real business taxonomy may need more buckets — flagged as an open item in the
PRD.)*

**Expected JSON:**

```json
{
  "is_receipt": true,
  "total": 128.50,
  "merchant": "ADNOC",
  "bill_date": "2026-08-26",
  "category": "Petrol",
  "confidence": "high"
}
```

`is_receipt: false` → the bot ignores the image silently. `bill_date: null` → the backend
falls back to the message's date. `confidence` is stored, not acted on in v1.

## 7. Commands

All four are open to every group member (v1). Replies go to the group.

| Command | Does |
|---|---|
| *(image)* | Log a bill → `RECEIPT PROCESSED` block + today's total |
| `/today` | `TODAY'S EXPENSES` — per-category + total, since Dubai midnight |
| `/week` | `THIS WEEK'S EXPENSES` — since Monday 00:00 Dubai |
| `/month` | `THIS MONTH'S EXPENSES` — since the 1st 00:00 Dubai |
| `/undo` | **Reply** to a receipt image or the bot's confirmation → `RECEIPT REMOVED` block |

Reply after a logged receipt:

```
RECEIPT PROCESSED
━━━━━━━━━━
 · Amount: 45.50 AED
 · Company: Carrefour Al Manama
 · Expense: Groceries
━━━━━━━━━━
TODAY'S TOTAL EXPENSES
 · 185.20 AED (4 receipts)
```

`/today` `/week` `/month`:

```
TODAY'S EXPENSES
━━━━━━━━━━
 · Groceries: 120.00 AED
 · Petrol: 45.20 AED
━━━━━━━━━━
TOTAL
 · 185.20 AED (4 receipts)
```

**`/undo`:**

- Must be sent as a **reply**. The bot reads the quoted message id and deletes the bill whose
  `whatsapp_message_id` or `reply_message_id` matches it.
- Reply to the **bot's confirmation** (it shows the amount, so you see what you're deleting);
  replying to the **receipt image** also works and is the fallback.
- Success → the `RECEIPT REMOVED` block. No matching row → `Nothing logged for that message.`
- **Bare `/undo`** (not a reply) → deletes nothing, replies with a one-line hint. Deliberate:
  a bare `/undo` that removed "the most recent bill" would usually hit the wrong person's row
  in a multi-submitter group.

Formatters live in `backend/src/utils/functions.ts` (`formatReceipt`, `formatSummary`,
`formatRemoved`). Errors and hints stay as plain one-liners.

## 8. Environments

One codebase, two `.env` files.

| | Testing | Production |
|---|---|---|
| Runs on | Ahmad's laptop | Friend's GCP `e2-micro` |
| Linked to | Ahmad's WhatsApp number (own `auth_session/`, own QR — never share the calorie tracker's) | The dedicated "Bills Bot" number |
| `TARGET_CHAT_JID` | **unset** → self-chat mode | The business group's `…@g.us` |
| `OPENROUTER_MODEL` | `google/gemma-4-31b-it:free` | `google/gemma-4-31b-it:free` |
| Supabase project | The bills-tracker project | The same project (single tenant, no `user_id`) |

`backend/.env` (copy `.env.example`):

```
OPENROUTER_API_KEY=          # required
OPENROUTER_MODEL=            # google/gemma-4-31b-it:free (both); paid slug is the fallback
SUPABASE_URL=                # required — the dedicated bills-tracker project
SUPABASE_SERVICE_ROLE_KEY=   # required — bypasses RLS; never NEXT_PUBLIC_-prefixed
TARGET_CHAT_JID=             # blank → watch the linked account's self-chat (testing). set → a group.
LOG_LEVEL=                   # optional — trace|debug|info|warn|error|fatal|silent, default info
```

No env var for WhatsApp auth — the session lives in `backend/auth_session/` (gitignored with
a glob, `auth_session*/`; treat as a credential).

### Testing without disturbing the calorie tracker

The calorie bot is already a linked device on Ahmad's number. The test instance is fine
alongside it **if** it does its own QR scan into its own `auth_session/` (shared creds →
endless 440 "replaced" fights) and there's a free companion-device slot (WhatsApp allows 4).
Triggers don't collide — the calorie bot only reacts to `/calories` in the self-chat, this
one to images and `/today|/week|/month|/undo`. Simplest loop: leave `TARGET_CHAT_JID` unset
(self-chat mode), `npm start`, send a receipt photo to yourself. Remove the test linked
device from WhatsApp → Linked Devices when done.

## 9. First run (production)

1. Register the dedicated number's WhatsApp on a spare phone (OTP once).
2. On the friend's VM: `cd backend && docker compose up --build` in the foreground.
3. Scan the QR from that phone's **WhatsApp → Linked Devices → Link a Device**.
4. The friend adds the dedicated number to the business group (participant, not admin).
5. **Find `TARGET_CHAT_JID`:** leave it blank — the bot logs the group's JID once when
   someone posts there (`saw a message in a chat this bot is not watching`). Copy that
   `…@g.us` value into `.env`, restart.
6. Confirm a real receipt logs and a non-receipt photo is ignored with no reply.
7. `Ctrl+C`, then `docker compose up -d`.

## 10. If the connection breaks

Same as the calorie tracker. `reconnect.ts` treats 401/403/419 (dead creds) and 500/411
(broken session) as permanent — the process exits `0` and Docker's `on-failure:10` leaves it
down for a human. 440 (session replaced) retries once after a 5-minute cooldown. Recovering
from a permanent disconnect means a fresh QR pairing:

```bash
cd backend
docker compose down
sudo rm -rf auth_session/*      # container writes these as root
docker compose up               # foreground, scan the new QR
# once "WhatsApp connection opened" appears: Ctrl+C, then
docker compose up -d
```
