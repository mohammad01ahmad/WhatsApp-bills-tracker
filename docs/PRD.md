# PRD: WhatsApp Bill Tracker

**Owner:** Ahmad
**Status:** Draft v1
**Last updated:** 2026-08-26

---

## 1. Main idea

An automated expense-logging system for a small business. Employees drop photos of receipts
and invoices into a shared WhatsApp group. A bot — a **dedicated WhatsApp number** that sits
in the group as an ordinary participant — picks up each image via **Baileys**, sends it to a
vision LLM (**via OpenRouter**) that extracts the total amount, merchant, date, and
category, writes a row to **Supabase**, and replies in the group with a confirmation and
today's running total. Text commands (`/today`, `/week`, `/month`, `/undo`) return spend
summaries in the same group. A dashboard comes later.

Built as a sibling of [`whatsapp-calorie-tracker`](../../whatsapp-calorie-tracker) — it
reuses that project's Baileys connection layer wholesale (`socket.ts`, `reconnect.ts`,
`fatal.ts`, `whatsapp/constants.ts`), copied rather than shared.

## 2. Problem statement

A business owner needs to track operational spending — fuel, building materials, food — that
happens in the field, is paid by several different employees, and comes back as paper
receipts. Collecting those at month-end is lossy and late, and no one wants to learn a
finance app. The employees already coordinate in a WhatsApp group. Turning "a photo of a
receipt, sent the moment it's paid" into a categorized, queryable expense — with zero data
entry and no new app for anyone — is the goal.

## 3. User personas

- **Ahmad — builder & operator.** Sets it up, owns the code, runs it on the owner's behalf.
  Not a daily user. Wants it to run unattended on the owner's infrastructure and never page
  him.
- **The business owner ("the friend") — primary beneficiary.** Wants a live picture of spend
  by day / week / month and by category. Uses `/today` etc. in the group. Owns the Supabase
  project and the GCP VM.
- **Employees — submitters.** Send receipt photos to the group. Zero learning curve — it is
  just sending a photo. May also use `/today`. Will also post non-receipt images (job sites,
  screenshots) and chat in the same group.

## 4. Goals & success metrics

| Goal | Metric | Notes |
|---|---|---|
| Receipts get captured at point of sale | Capture rate — logged bills vs. receipts that actually existed, spot-audited against a month of paper | Manual audit; no ground truth in v1 |
| Extraction is trustworthy enough to act on | Total-amount accuracy — spot-check logged totals against the paper receipt | The **total** is the field that matters; merchant/category can be looser |
| The bot is invisible when it should be | Zero replies to non-receipt images; zero expense rows from job-site photos or chat | The main new failure mode vs. the calorie tracker |
| It runs unattended | Days between operator interventions | Same reconnect/restart hardening as the calorie tracker |

Out of scope as metrics: per-employee analytics, approval workflows, anything gamified.

## 5. Scope (v1)

- **Image-triggered logging.** Every image posted in one designated group (`TARGET_CHAT_JID`)
  is evaluated. No caption or prefix required.
- **Dedicated WhatsApp number** for the bot, linked via Baileys as a companion device, added
  to the group as an ordinary participant (not admin).
- **Vision extraction:** `dots-studio/dots-3-note-preview:free` via OpenRouter, hardcoded in
  `src/llm/client.ts` — loose JSON, fence-strip, validate, one retry. A paid slug (strict JSON
  schema) is the fallback: a one-line `MODEL` edit, if the free model's reliability disappoints.
  Returns `{ is_receipt, total, merchant, bill_date, category, confidence }`.
- **An "is this a receipt?" gate.** Non-receipts are silently ignored — a debug log line and
  nothing else. No reply.
- **Supabase (Postgres)** — a **dedicated project for this business**, `bills` table. Single
  tenant, so no `user_id` / per-row ownership.
- **Confirmation reply** in the group after each logged bill: a `RECEIPT PROCESSED` block
  (amount / company / expense) + today's running total.
- **Commands, open to every group member:** `/today`, `/week`, `/month`, `/undo` (a reply to
  the receipt or the bot's confirmation; removes only that one bill), `/fix <amount>` (a
  reply, same two anchors; corrects that bill's **amount only**), and
  `/receipt <amount> <category> [company]` (logs a bill with **no photo** — cash payments,
  lost receipts; `category` is a keyword or `1`–`4`, `company` optional).
- **Calendar periods**, Asia/Dubai (UTC+4, no DST) fixed offset: `/today` since Dubai
  midnight, `/week` since Monday 00:00, `/month` since the 1st 00:00.
- **Category:** fixed 4-value enum — `Petrol`, `Food`,
  `Building Materials / Hardware Supplies`, `Others`.
- **Currency:** AED only, assumed, not stored.
- **Hosting:** always-on Node process in Docker on a GCP Always-Free `e2-micro` **in the
  friend's own GCP account**.

## 6. Out of scope (v1)

- **Dashboard** — deferred; backend first. `bills` has RLS **enabled with no policy**
  (deny-by-default) — the dashboard adds a `select` policy matching whatever gate it uses.
- **Scheduled / automatic summaries** — no cron push of an end-of-day total. Commands only.
  Candidate for a fast-follow.
- **Per-employee attribution** — bills are logged under one owner id; the sender is not
  stored.
- **Approval / reimbursement workflow.**
- **Receipt image retention** — the photo stays in WhatsApp; nothing is uploaded or stored.
- **Multi-currency** — no handling, no FX conversion.
- **Editable categories** — the enum is fixed in code and DB.
- **Duplicate detection for two photos of the same physical receipt** — accepted as a known
  gap, caught via `/undo` and the dashboard.
- **Admin-restricted commands** — every command is open to every group member in v1 (see
  Risks).
- **Official WhatsApp Cloud API** — Baileys chosen for v1 to avoid Meta Business
  verification; documented as the fallback.

## 7. Application flow

```
Employee posts a photo in the group
  │
  ▼
Baileys `messages.upsert` fires inside the Node process
  (the bot is a companion device on the dedicated number)
  │
  ├─ filter: message is in the watched chat                         → else ignore
  │          (TARGET_CHAT_JID set → that chat; unset → the linked account's self-chat)
  ├─ filter: key.id not in sentByBot                                → else ignore (our own send echoing back)
  ├─ branch: imageMessage? → extraction path
  │          text matches /today|/week|/month|/undo? → command path
  │          else → ignore
  │
  ▼  (extraction path)
download media (buffer, with reuploadRequest) → size-cap
  │
  ▼
OpenRouter · dots-3 vision → { is_receipt, total, merchant, bill_date, category, confidence }
  │
  ├─ !is_receipt or total == null → debug-log, stop. NO REPLY.
  │
  ▼
insert into `bills` (idempotency: unique whatsapp_message_id) — BEFORE replying
  │
  ▼
reply in group:
   RECEIPT PROCESSED
   ━━━━━━━━━━
    · Amount: 128.50 AED
    · Company: ADNOC
    · Expense: Petrol
   ━━━━━━━━━━
   TODAY'S TOTAL EXPENSES
    · 312.00 AED (3 receipts)
```

Command path: filter to the group, match `/today|/week|/month|/undo|/fix|/receipt`, query
`bills`, reply in the group. `/undo` and `/fix` must be a reply — they act on the one bill
the quoted message points at. `/receipt` logs a bill with no photo (§8 Commands).

*A rendered architecture diagram is a TODO — the ASCII flow above is the source of truth for now.*

## 8. Message handling

Same in-process event-handler model as the calorie tracker — **no webhook, no HTTP
endpoint**. The "API" is `sock.ev.on('messages.upsert', …)`.

### 8.1 How the bot points only at the group

The chat filter in `socket.ts` has **two modes**, keyed off whether `TARGET_CHAT_JID` is set:

| `TARGET_CHAT_JID` | The bot acts on |
|---|---|
| **set** (production) | *only* that JID. A message matches if `jidNormalizedUser(m.key.remoteJid)` **or** `m.key.remoteJidAlt` equals it. Everything else — DMs to the bot number, any other group it gets added to — is dropped **before** any media download, LLM call, or DB write. |
| **unset** (testing) | *only* the linked account's own self-chat, detected from `sock.user` (id / lid / phoneNumber, both JID fields — v7 flips self-chat between the phone-number form and `…@lid`). A dedicated bot number's self-chat is empty, so this mode is effectively idle in production. |

Neither mode uses a `fromMe` check (that would also block self-chat testing). Loop safety is
`sentByBot` — a Set of the ids the process has sent; the bot skips those.

Any chat the bot **sees but isn't watching** has its JID logged **once** at `info`
(`noteForeignChat`): `saw a message in a chat this bot is not watching — set TARGET_CHAT_JID
to this jid to watch it`. That line is both the setup mechanism (§14 step 8) and a
**tripwire** — if it ever appears for an unexpected chat in production, the bot was added
somewhere it shouldn't be.

### Incoming event shape (from Baileys)

| Field | Description |
|---|---|
| `key.remoteJid` | The group JID (`…@g.us`) |
| `key.participant` | The employee who sent it (groups only). **Not stored in v1.** |
| `key.fromMe` | `true` only for the bot's own messages |
| `key.id` | Unique message ID — idempotency key |
| `message.imageMessage` | The image (+ optional caption, unused) |
| `message.conversation` / `message.extendedTextMessage.text` | Command text |
| `messageTimestamp` | Unix timestamp — the `bill_date` fallback |

### Filtering checks (in order)

1. **Chat filter — two modes.** `TARGET_CHAT_JID` set → match `remoteJid` or `remoteJidAlt`
   against it (the group). Unset → **self-chat mode**: match against
   `[sock.user.id, sock.user.lid, sock.user.phoneNumber]` and both JID fields — v7 flips
   self-chat between the phone-number form and `…@lid`. Testing runs in self-chat mode with
   zero JID config; the calorie tracker's `isSelfChat` check, reused. Anything from any other
   chat is ignored (its JID logged once at `info` to surface a group JID for production).
   **The trust boundary: one chat, nothing else.** No `fromMe` requirement in either mode.
2. **Skip the bot's own messages** — by id, via a `sentByBot` Set the socket fills on every
   send. Not by `fromMe` (which is also true for a human typing on the linked account).
3. **Branch** — image → extraction path; text matching a command → command path; anything
   else → ignore silently.
4. **Idempotency** — the unique constraint on `whatsapp_message_id`. A re-fired event hits
   Postgres `23505`, `populateTable` returns `null`, and the bot treats `null` as "already
   logged, don't confirm twice". Not a select-then-insert. `tests/test-db.ts` is what proves
   the index still exists.

### Commands

All open to every group member (v1). Matched case-insensitively on a trimmed message;
`parseCommand` returns `{ cmd, rest }` (the raw-cased remainder after the verb).

| Command | Behavior |
|---|---|
| `/today` `/week` `/month` | Sum `bills` over the calendar period (Asia/Dubai); reply with a `TODAY'S / THIS WEEK'S / THIS MONTH'S EXPENSES` block — per-category lines (sorted desc) + a `TOTAL`. |
| `/undo` | **Must be sent as a reply** to a message. Delete the one bill whose `whatsapp_message_id` *or* `reply_message_id` equals `contextInfo.stanzaId` (the quoted message's id). |
| `/fix <amount>` | **Must be a reply**, same two anchors as `/undo`. Update that bill's `total` (amount only — no category/merchant edit). Reply a `RECEIPT UPDATED` block with the new values. Bad/missing amount or bare `/fix` → a usage hint; no match → *"Nothing logged for that message."* |
| `/receipt <amount> <category> [company]` | Log a bill with **no photo**. `category` is a keyword or `1`–`4` (petrol/fuel·1, food·2, materials/hardware/hw·3, others·4); trailing text is the optional `company`. Uses the command message's own id as `whatsapp_message_id` (idempotency + `/undo`/`/fix` anchor). `bill_date` = message date, `confidence` = null. Reply is the normal `RECEIPT PROCESSED` block. Parse failure → a usage line naming the keywords, no row written. |

**`/undo` details:**

- The quoted id comes from `m.message.extendedTextMessage.contextInfo.stanzaId`.
- Users should reply to **the bot's confirmation message** (it shows the amount, so they see
  what they're deleting) — replying to the original **receipt image** also works and is the
  fallback when `reply_message_id` never got written.
- Row found → `delete`, reply a `RECEIPT REMOVED` block (same amount / company / expense
  layout as `RECEIPT PROCESSED`).
- No matching row (already removed, or replied to an unrelated message) → *"Nothing logged
  for that message."* (plain, not a block).
- **Bare `/undo`** (no quoted message) → nothing is deleted; reply *"Reply /undo to a
  receipt or to my confirmation for the bill you want to remove."* This is deliberate — a bare
  `/undo` that deleted "the most recent bill" globally would, in a multi-submitter group,
  usually delete the wrong person's entry.
- Still open to everyone: any member can undo any receipt — but only the specific one they
  point at, never an implicit "last" one.

### Reply behavior

`sock.sendMessage(groupJid, { text })`. Sent **only** when a bill is actually logged, or in
response to an explicit command. **Never** in response to a non-receipt image. On
extraction or DB failure, a generic reply ("couldn't read that receipt — try a clearer
photo"), never the raw error text; the send is `.catch()`'d so a dead socket can't crash the
process over one bad photo.

### Hosting implication

Baileys needs an always-on process, not a serverless function — a hard requirement, same as
the calorie tracker. GCP Always-Free `e2-micro`, Docker, `restart: on-failure:10`.

## 9. Vision LLM call structure (OpenRouter)

**Model:** `dots-studio/dots-3-note-preview:free` via OpenRouter, **hardcoded in
`src/llm/client.ts`** (`const MODEL`) — not an env var. It's coupled to the prompt and the
JSON branch below and doesn't vary per deployment. The client keys its JSON strategy off the
`:free` suffix:

- **`:free` slug (current).** Treated as no `structured_outputs` — the JSON shape goes in the
  prompt, `response_format: { type: "json_object" }`, response fence-stripped, hand-validated,
  retried exactly once on failure.
- **A paid slug — fallback only.** `qwen/qwen2.5-vl-72b-instruct` (needs OpenRouter credit) or
  `google/gemma-4-31b-it` (with a BYO Google AI Studio key) both advertise `structured_outputs`,
  so the client switches to strict `response_format: { type: "json_schema", strict: true }`
  (no fence-strip, no retry). Switching is a one-line edit to `MODEL` + push (auto-deploy).

**Free-tier ceiling:** OpenRouter caps `:free` models at **50 requests/day** for an account
that has never purchased credit (1000/day after ≥$10). At a busy day's receipt volume this
can 429 — accepted for v1 (see §16); the remedy is $10 of OpenRouter credit, which also
unlocks the paid slugs.

Verified on OpenRouter: `dots-studio/dots-3-note-preview:free` accepts image input.

Single-turn, stateless, one call per image. A system message (task: read a receipt/invoice
image; if the image isn't one, set `is_receipt: false`) plus a user message carrying the
image as a base64 `data:` URL in an `image_url` content part.

### Expected JSON

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

- `is_receipt: false` → the bot ignores the image silently; other fields may be null.
- `bill_date: null` when the receipt shows no date → the backend falls back to the message's
  date.
- `category` is exactly one of the four enum values. `Others` is the escape hatch — the
  model should never be forced into a bad fit.
- `confidence` is **stored but not acted on** in v1. Candidate: on `low`, ask for a clearer
  photo instead of logging.

## 10. Data model (Supabase / Postgres)

A **dedicated Supabase project** for this business — not the calorie tracker's. New table:

```sql
create table bills (
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

create index bills_created_idx on bills (created_at desc);

-- RLS on, no policy: not readable with the anon/publishable key. Backend writes
-- use the service-role key (bypasses RLS). The dashboard adds a select policy.
alter table bills enable row level security;
```

- **No `user_id`.** Single tenant — one business, one group. The backend writes with the
  service-role key; nothing needs per-row ownership. Dropping the `auth.users` FK also means
  the backend runs against a bare Supabase project with no auth user to create first. If a
  dashboard ever needs it, re-adding is a 3-line migration (every row gets the same value).
- **No `currency` column** — every invoice is AED. Not an always-`'AED'` column; no column.
  A non-AED receipt would be a schema change.
- **`created_at`** (default `now()`) is what all period queries filter on. `bill_date` is
  informational (what the receipt says).
- **`whatsapp_message_id`** unique — the sole idempotency mechanism, and the primary
  `/undo` anchor (reply to the receipt image).
- **`reply_message_id`** — set right after the confirmation `sendMessage` succeeds; nullable,
  since the row must still exist (and be undoable via the image) if that send fails. The
  second `/undo` anchor: reply to the bot's confirmation. Not unique.
- **No sender column** in v1.
- **RLS on, no policy** (deny-by-default) — a dashboard using the publishable key reads zero
  rows until it adds a `select` policy matching its gate. For single tenant that's likely a
  shared-credential gate + server-side reads with the service-role key, not per-user RLS.

## 11. Environments

One codebase. What changes between testing and production is the WhatsApp identity,
`TARGET_CHAT_JID`, the target table, the OpenRouter key, and where it runs — nothing else.

| | Testing | Production |
|---|---|---|
| Runs on | Ahmad's laptop, `npm start` | Friend's GCP `e2-micro`, `docker compose up -d` |
| Linked to | Ahmad's WhatsApp number | The dedicated "Bills Bot" number |
| `TARGET_CHAT_JID` | **unset** — self-chat mode | The business group's `…@g.us` JID |
| Target table | `bills_testing` — `db/client.ts` default when `BILLS_TABLE` is unset | `bills` — set in `docker-compose.yml` (`environment: BILLS_TABLE=${BILLS_TABLE:-bills}`), not the VM's `.env` |
| OpenRouter key | Ahmad's | The friend's |
| Model | `dots-studio/dots-3-note-preview:free` — hardcoded, same everywhere | |
| Supabase project | `blmqcc…` — same everywhere (single tenant, no per-row `user_id`); two tables, `bills` + `bills_testing` | |

### Testing — does it interfere with the calorie tracker?

**No, given two rules:**

1. **Its own `auth_session/`, its own QR scan.** Never copy the calorie tracker's
   credentials. Two Baileys instances sharing one credential set fight forever (status 440,
   "connection replaced"). Two *separate* linked devices coexist fine.
2. **Mind the companion-device count.** Each Baileys instance is one WhatsApp companion slot;
   the limit is 4. Ahmad likely already has: phone (primary, free) + possibly WhatsApp
   Web/Desktop + the calorie bot on GCP. If at 4, free a slot in WhatsApp → Linked Devices.

Message triggers don't collide: the calorie bot only reacts to `/calories`; this bot only to
images and `/today|/week|/month|/undo`. Both watch the same self-chat and each ignores what
isn't its own.

**Simplest test loop:** leave `TARGET_CHAT_JID` unset (self-chat mode), `npm start`, send a
receipt photo to yourself → logged. Send `/today` → summary. Set `TARGET_CHAT_JID` to a real
throwaway group only to exercise the group path before going live. **Teardown:** remove the
linked device from WhatsApp → Linked Devices when done.

### Production — the dedicated number

- A prepaid SIM or eSIM, registered as a WhatsApp account once on a spare phone (OTP needed
  once). Baileys then links as a companion device.
- The friend adds that number to the business group as an ordinary participant.
- Its own `auth_session/` on the friend's VM. One companion slot on *that* number's account
  — unrelated to anyone's personal linked devices.
- A ban (Baileys is unofficial — see Risks) hits a throwaway number, not anyone's real line.

## 12. Project file structure

```
whatsapp-bills-tracker/
├── backend/
│   ├── src/
│   │   ├── index.js                 # entry point + process-level safety nets, then imports socket.ts
│   │   ├── whatsapp/
│   │   │   ├── socket.ts            # COPIED from calorie tracker, then adapted: group filter, image + command routing
│   │   │   ├── messageHandler.ts    # command matching + parsing
│   │   │   ├── reconnect.ts         # COPIED verbatim — pure backoff/terminal-state policy
│   │   │   ├── fatal.ts             # COPIED verbatim — the one place allowed to process.exit
│   │   │   └── constants.ts         # COPIED verbatim — reconnect tuning knobs
│   │   ├── llm/
│   │   │   ├── client.ts            # OpenRouter call, image part; MODEL hardcoded here; strict-or-loose JSON by the :free suffix
│   │   │   └── billSchema.ts        # JSON schema + parseBillResponse (fence-strip, validate, is_receipt normalise)
│   │   ├── db/
│   │   │   ├── client.ts            # service role key, throws at boot if SUPABASE_URL / SERVICE_ROLE_KEY missing
│   │   │   └── bills.ts             # insertBill, setReplyMessageId, periodTotal, undoByQuotedId
│   │   └── utils/
│   │       ├── logger.js            # pino, shared with Baileys — COPIED verbatim
│   │       ├── constants.ts         # CATEGORIES enum, Bill / BillInsert types
│   │       └── functions.ts         # dubai day/week/month starts, dubaiDate, formatReceipt / formatSummary / formatRemoved
│   ├── auth_session/                # Baileys credentials — gitignored with a GLOB (auth_session*/)
│   ├── tests/
│   │   ├── test-backoff.ts          # COPIED verbatim — reconnect policy
│   │   ├── test-utils.ts            # period boundary math + formatters
│   │   ├── test-extract.ts          # LLM response parsing / validation / is_receipt gate
│   │   ├── test-handler.ts          # command parsing
│   │   └── test-db.ts               # manual — hits the real bills table
│   ├── .env.example
│   ├── Dockerfile                   # single-stage node:25-slim, no build step
│   ├── docker-compose.yml           # restart: on-failure:10, capped logging, auth_session bind mount, explicit `name:`
│   ├── .dockerignore
│   └── package.json
│
├── docs/
│   └── PRD.md                       # this file
│
├── supabase/schema.sql             # bills table + index; RLS on, no policy
├── .github/workflows/
│   └── backend-cd.yml               # verify (typecheck + tests) → deploy (SSH redeploy on push to main)
│
├── .gitignore  .mcp.json
├── CLAUDE.md
└── README.md
```

No `dashboard/` yet.

## 13. Production readiness

**No code changes are needed to go to production.** What's built handles it:

| Code-ready | |
|---|---|
| Chat filter | Two modes (§8.1) — production sets `TARGET_CHAT_JID` and the bot acts on that group only. |
| `is_receipt` gate | Silent on non-receipt photos. |
| Reliability | `reconnect.ts` backoff + terminal-state policy; `fatal.ts` exit codes ↔ `restart: on-failure:10`. |
| Idempotency | Unique `whatsapp_message_id`; re-delivered events don't double-log. |
| Loop guard | `sentByBot` — the bot never reprocesses its own replies. |
| Error handling | Generic replies only; provider/DB error text never reaches the chat. |
| Packaging | `Dockerfile` + `docker-compose.yml` (capped logs, `auth_session` bind mount, explicit `name:`). |
| Repo | Pushed to `github.com/mohammad01ahmad/WhatsApp-bills-tracker` (public). |
| CI/CD | `.github/workflows/backend-cd.yml` — typecheck + tests on every push, then SSH redeploy. |

**Outstanding — all infra / config, done once during deploy (§14):**

- [ ] Dedicated WhatsApp number — a prepaid SIM or eSIM with WhatsApp registered on it (one
      OTP, on any spare phone). This phone scans the pairing QR.
- [ ] The friend's own Google Cloud account (Always-Free covers this).
- [ ] The friend's own OpenRouter account + API key (the model is free; the account is not
      Ahmad's).
- [ ] `backend/.env` created on the VM (never committed).
- [ ] **Fresh QR pairing on the VM** against the dedicated number — never copy the testing
      `auth_session/` (that's Ahmad's number).
- [ ] `TARGET_CHAT_JID` set to the real business-group JID (§14 step 8).
- [ ] A GCP billing budget alert.

**Accepted for v1** (see §16): the 50 OpenRouter req/day free ceiling; `/undo` open to every
group member; no alert if the bot is silently removed from the group; confidence stored but
not shown.

## 14. Deploying to GCP — step by step

Runs in **the friend's own GCP account** (his billing, his blast radius, his data). Do §13's
prerequisites first.

1. **Create the VM.** Console → Compute Engine → VM instances → **Create instance**:
   - Machine type **`e2-micro`**; Region **`us-central1`** (or `us-west1` / `us-east1` — the
     only Always-Free regions).
   - Boot disk: **Ubuntu 24.04 LTS**, **30 GB** standard persistent disk (Always-Free ceiling).
   - Leave all firewall boxes unchecked — nothing needs to reach the VM.
   - Create. No static IP needed.

2. **Connect.** Click **SSH** next to the instance — a browser terminal opens. No key files.

3. **Install Docker:**
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER
   newgrp docker
   ```

4. **Clone the repo:**
   ```bash
   git clone https://github.com/mohammad01ahmad/WhatsApp-bills-tracker.git
   cd WhatsApp-bills-tracker/backend
   ```

5. **Create `backend/.env`** (`nano .env`):
   ```
   OPENROUTER_API_KEY=<the friend's OpenRouter key>
   SUPABASE_URL=https://blmqccdupkejrvdbbydm.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<the sb_secret_… key from Supabase → Project Settings → API Keys>
   LOG_LEVEL=info
   ```
   No `BILLS_TABLE` line here — `docker-compose.yml` sets it to `bills` for production.
   Leave `TARGET_CHAT_JID` out for now — it's set in step 8. (The model is hardcoded in
   `src/llm/client.ts`, not here.)

6. **First run — pair the dedicated number.** In the foreground so the QR is visible:
   ```bash
   docker compose up --build
   ```
   A QR code prints in the SSH terminal. On the phone holding the **dedicated number**:
   WhatsApp → Settings → Linked Devices → **Link a Device** → scan it. Wait for
   `WhatsApp connection opened { mode: 'self-chat (TARGET_CHAT_JID unset)' }` and a
   `Bills bot connected ✅` message in the dedicated number's own chat. Confirm
   `ls auth_session/` now shows files (the session, persisted to the host).

7. **Add the bot to the group.** A group admin adds the dedicated number as a participant
   (not an admin).

8. **Point the bot at the group.** With the container still running from step 6, have anyone
   post any message in the group. The log prints, **once**:
   ```
   {"level":30,…,"jid":"120363XXXXXXXXXXXXXXX@g.us",…,
    "msg":"saw a message in a chat this bot is not watching — set TARGET_CHAT_JID to this jid to watch it"}
   ```
   `Ctrl+C` to stop. `nano .env` and add:
   ```
   TARGET_CHAT_JID=120363XXXXXXXXXXXXXXX@g.us
   ```

9. **Verify the lock.**
   ```bash
   docker compose up
   ```
   Startup log now reads `mode: 'chat 120363…@g.us'`. Check all three:
   - Receipt photo **in the group** → `RECEIPT PROCESSED` reply + a row in `bills`.
   - Non-receipt photo **in the group** → no reply (`skipped: not a receipt` in the log).
   - Receipt photo **DM'd to the bot number** → nothing (`skipped: wrong chat`).

10. **Go always-on.** `Ctrl+C`, then:
    ```bash
    docker compose up -d
    ```
    `restart: on-failure:10` restarts on any crash (up to 10 in a row) and survives VM
    reboots. A clean `exit(0)` — dead WhatsApp credentials — deliberately stays down; that
    needs a human and a fresh QR (see below).

11. **Budget alert.** Console → Billing → Budgets & alerts → create a budget (e.g. $1) as a
    tripwire. Staying inside Always-Free should never bill.

### Set up auto-deploy (once, after step 10)

```bash
ssh-keygen -t ed25519 -f ~/deploy_key -N ""
cat ~/deploy_key.pub >> ~/.ssh/authorized_keys
```

GitHub repo → **Settings → Secrets and variables → Actions**:

- **Secrets** tab → add four:

  | Secret | Value |
  |---|---|
  | `DEPLOY_HOST` | the VM's external IP |
  | `DEPLOY_USER` | your SSH username on the VM |
  | `DEPLOY_SSH_KEY` | the full contents of `~/deploy_key` (the private key) |
  | `DEPLOY_PATH` | `/home/<DEPLOY_USER>/WhatsApp-bills-tracker` |

- **Variables** tab → add `DEPLOY_ENABLED` = `true`. (The deploy job is *skipped*, not
  failed, until this is set — so pushes are safe before the VM exists.)

From then on, every push to `main` touching `backend/` runs typecheck + tests, then SSHes in
and `git reset --hard origin/main` + `docker compose up -d --build`. **`.env` and
`auth_session/` are never touched** by a deploy.

### Manual redeploy (if you skip auto-deploy, or to force one)

```bash
cd ~/WhatsApp-bills-tracker && git pull && cd backend && docker compose up -d --build
```

### If the linked device is removed / credentials die

`reconnect.ts` treats dead creds as terminal — the process exits `0` and stays down. Re-pair:

```bash
cd ~/WhatsApp-bills-tracker/backend
docker compose down
sudo rm -rf auth_session/*        # the container writes these as root
docker compose up                # foreground — rescan the QR with the dedicated number
# once "WhatsApp connection opened" appears: Ctrl+C, then
docker compose up -d
```

## 15. Build plan

**Status:** Phases 1–5 done — backend built, tested end-to-end on Ahmad's number in
self-chat mode against the live Supabase project, formatting finalised, repo pushed, CI/CD
wired. **Outstanding: Phase 6** (deploy to the friend's GCP VM against the dedicated number —
follow §14) and Phases 7–8.

### Phase 1 — Scaffold
Repo, `backend/` folder, `.env` handling, git. **Copy** `socket.ts`, `reconnect.ts`,
`fatal.ts`, `whatsapp/constants.ts`, `logger.js`, `dubaiDayStart`, `test-backoff.ts` from the
calorie tracker. Deps: `@whiskeysockets/baileys`, `@supabase/supabase-js`, `pino`,
`qrcode-terminal`.

### Phase 2 — Data layer
Supabase project (`blmqcc…`). `supabase/schema.sql` applied (`bills` table + index; RLS on,
no policy). `tests/test-db.ts` confirmed insert, duplicate rejection, `periodTotal`, and
`/undo` by the confirmation id — all green against the live table.

### Phase 3 — Extraction
`llm/client.ts` + `billSchema.ts`. Model settled at `dots-studio/dots-3-note-preview:free`
(hardcoded) after Gemma's `:free` upstream pool 429'd and paid slugs needed OpenRouter
credit. `:free`→loose path with a one-shot retry. Fall back to a paid slug (one-line `MODEL`
edit) if reliability drops.

### Phase 4 — WhatsApp locally
Baileys on Ahmad's number, its own `auth_session/`, `TARGET_CHAT_JID` = self-chat or a test
group. Confirm image and command events fire. Build the chat filter + the image/command
router; log parsed results before wiring extraction in.

### Phase 5 — Full pipeline locally
Image → extract → `is_receipt` gate → insert → reply (storing `reply_message_id`). Summary
commands → query → reply. `/undo` as a reply to both anchors (the receipt image and the
bot's confirmation), plus the bare-`/undo` and no-match cases. Run for a few days on
receipts Ahmad photographs himself.

### Phase 6 — Dedicated number + production infra
The full runbook is **§14**. In short: SIM + WhatsApp registration; the friend's GCP
`e2-micro`; Docker; QR-pair the dedicated number on the VM; add the bot to the group; set
`TARGET_CHAT_JID` from the log; verify the lock (group receipt logs, DM does nothing);
`docker compose up -d`; wire the four auto-deploy secrets.

### Phase 7 — Live use & hardening
Run in the real group. Spot-audit logged totals against paper. Watch for false positives on
non-receipt images and for missed receipts. Add crash visibility (pino logs via
`docker compose logs -f`, or a lightweight alert).

### Phase 8 — Fast-follow (not v1)
Dashboard (Google sign-in, per the calorie tracker's model). Scheduled daily summary pushed
to the group.

## 16. Risks & accepted trade-offs

- **WhatsApp ToS / ban.** Baileys is unofficial; automated messaging in a multi-person
  business group is more visible than a personal self-chat bot. *Mitigation:* a dedicated
  throwaway number (a ban doesn't touch anyone's real line), `markOnlineOnConnect: false`,
  replies only on real triggers. *Fallback:* the official WhatsApp Cloud API (free ~1,000
  conversations/month, needs Meta Business verification).
- **Every command open to everyone.** Any member can `/undo` or `/fix` any bill (though only
  the one they explicitly reply to), add a bogus `/receipt`, or spam `/month`. *Accepted for
  v1* for simplicity. *Upgrade path:* an `ADMIN_JIDS` allowlist gating `/undo` / `/fix` /
  `/receipt` (and optionally the summaries), checked against `key.participant`.
- **OpenRouter free-tier ceiling — 50 requests/day.** For an account that has never bought
  credit, OpenRouter caps all `:free` models at 50 req/day (1000 after ≥$10). A busy day
  exceeds this and receipts start 429'ing until midnight UTC — the bot replies "couldn't read
  that receipt". *Accepted for v1.* *Remedy:* $10 of OpenRouter credit lifts the cap to
  1000/day and unlocks paid slugs. Watch the logs for `openrouter 429` frequency.
- **Free-model JSON reliability.** The fence-strip + retry-once wrapper covers most parse
  failures; a persistent failure sends the generic reply, not a crash. *Fallback:* a one-line
  `MODEL` edit to a paid slug (strict JSON schema).
- **Duplicate physical receipts.** Two photos of one receipt = two rows = double count.
  *Accepted*; `/undo` + the dashboard catch it. *Upgrade path:* soft-warn when
  merchant+total+`bill_date` already exists that day.
- **Non-receipt images.** *Mitigated* by the `is_receipt` gate; residual risk is a confident
  hallucination on a receipt-ish image. `confidence` is stored so these can be audited.
- **Bot silently removed from the group.** No crash — it just goes quiet. The operator must
  know. *Upgrade path:* a periodic heartbeat DM to an admin.
- **One free `e2-micro` per GCP account.** Solved by the friend using his own account.

## 17. Open items for v2

- Dashboard (read-only). Single tenant, so a shared-credential gate + server-side reads with
  the service-role key is simpler than per-user Supabase Auth + RLS. Decide the gate, then
  add the matching `select` policy (and re-add `user_id` only if that gate needs it).
- Scheduled daily / weekly summary pushed to the group — an in-process timer to the next
  Dubai boundary, no cron dependency.
- Per-employee attribution — store `key.participant` + `pushName`.
- `ADMIN_JIDS` allowlist for destructive / sensitive commands.
- Low-confidence handling — ask for a clearer photo instead of logging.
- Duplicate soft-detection.
- Editing a bill's **category or merchant** (v1 `/fix` is amount-only), and an audit trail
  for edits (`updated_at` / a history row — a fixed bill is currently indistinguishable from
  a correctly-logged one).
- Multi-currency, if the business ever buys abroad.
- Migration to the official WhatsApp Cloud API if Baileys reliability degrades at volume.
