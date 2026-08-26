# PRD: WhatsApp Bill Tracker

**Owner:** Ahmad
**Status:** Draft v1
**Last updated:** 2026-08-26

---

## 1. Main idea

An automated expense-logging system for a small business. Employees drop photos of receipts
and invoices into a shared WhatsApp group. A bot — a **dedicated WhatsApp number** that sits
in the group as an ordinary participant — picks up each image via **Baileys**, sends it to a
vision LLM (**Gemma via OpenRouter**) that extracts the total amount, merchant, date, and
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
- **Vision extraction:** `google/gemma-4-31b-it:free` via OpenRouter in both environments —
  loose JSON, fence-strip, validate, one retry. The paid `google/gemma-4-31b-it` slug (strict
  JSON schema) is a fallback, flipped via `OPENROUTER_MODEL` with no code change, if `:free`
  reliability disappoints. Returns `{ is_receipt, total, merchant, bill_date, category, confidence }`.
- **An "is this a receipt?" gate.** Non-receipts are silently ignored — a debug log line and
  nothing else. No reply.
- **Supabase (Postgres)** — a **dedicated project for this business**, `bills` table. Single
  tenant, so no `user_id` / per-row ownership.
- **Confirmation reply** in the group after each logged bill: a `RECEIPT PROCESSED` block
  (amount / company / expense) + today's running total.
- **Commands, open to every group member:** `/today`, `/week`, `/month`, and `/undo` (which
  must be sent as a reply to the receipt or the bot's confirmation, and removes only that
  one bill).
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
OpenRouter · Gemma vision → { is_receipt, total, merchant, bill_date, category, confidence }
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

Command path: filter to the group, match `/today|/week|/month|/undo`, query `bills`, reply
in the group. `/undo` must be a reply — it deletes the one bill the quoted message points at
(§8 Commands).

*A rendered architecture diagram is a TODO — the ASCII flow above is the source of truth for now.*

## 8. Message handling

Same in-process event-handler model as the calorie tracker — **no webhook, no HTTP
endpoint**. The "API" is `sock.ev.on('messages.upsert', …)`.

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

All four are open to every group member (v1). Matched case-insensitively on a trimmed
message.

| Command | Behavior |
|---|---|
| `/today` `/week` `/month` | Sum `bills` over the calendar period (Asia/Dubai); reply with a `TODAY'S / THIS WEEK'S / THIS MONTH'S EXPENSES` block — per-category lines (sorted desc) + a `TOTAL`. |
| `/undo` | **Must be sent as a reply** to a message. Delete the one bill whose `whatsapp_message_id` *or* `reply_message_id` equals `contextInfo.stanzaId` (the quoted message's id). |

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

**Model:** `google/gemma-4-31b-it:free` via OpenRouter in **both environments**, selected by
the `OPENROUTER_MODEL` env var. The client keys its JSON strategy off the `:free` suffix:

- **`:free` slug (default, test + prod).** Does not advertise `structured_outputs` — the JSON
  shape goes in the prompt, `response_format: { type: "json_object" }`, and the response is
  fence-stripped, hand-validated, and retried exactly once on failure.
- **`google/gemma-4-31b-it` (paid) — fallback only.** Advertises `structured_outputs`, so the
  client switches to a strict `response_format: { type: "json_schema", strict: true }`
  (no fence-strip, no retry). Flip `OPENROUTER_MODEL` to this if `:free` can't return usable
  JSON often enough in real use — no code change. Costs a few US cents/day at business volume.

Verified on OpenRouter: image input, 262k context, both slugs.

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

One codebase, two configs. What changes is the WhatsApp identity and the infrastructure —
everything else is `.env`.

| | Testing | Production |
|---|---|---|
| Runs on | Ahmad's laptop, `npm start` | Friend's GCP `e2-micro`, `docker compose up -d` |
| Linked to | Ahmad's WhatsApp number | The dedicated "Bills Bot" number |
| `TARGET_CHAT_JID` | **unset** — self-chat mode | The business group's `…@g.us` JID |
| `OPENROUTER_MODEL` | `google/gemma-4-31b-it:free` | `google/gemma-4-31b-it:free` |
| Supabase project | The bills-tracker project | The same project (single tenant, no per-row `user_id`) |

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
│   │   │   ├── client.ts            # OpenRouter call, image content part; strict-or-loose JSON keyed off the :free suffix
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
│   └── backend-cd.yml               # verify job (typecheck + tests); deploy job commented until the VM exists
│
├── .gitignore  .mcp.json
├── CLAUDE.md
└── README.md
```

No `dashboard/` yet.

## 13. Getting started — Baileys with a dedicated number

1. Get a prepaid SIM / eSIM. Register WhatsApp on it once, on any spare phone (OTP needed
   once).
2. Run the backend in the foreground; scan the QR from that phone's WhatsApp → Linked
   Devices → Link a Device.
3. The friend adds the dedicated number to the business group (participant, not admin).
4. **Find `TARGET_CHAT_JID`:** leave it unset on the first run. Have someone post in the
   group — the bot logs the group's JID once (`saw a message in a chat this bot is not
   watching`). Copy that `…@g.us` value into `.env`, restart.
5. Confirm: a real receipt photo logs and replies; a job-site photo is ignored with no
   reply.
6. `Ctrl+C`, then `docker compose up -d`.

## 14. Getting started — GCP (the friend's account)

Same as the calorie tracker's setup, run in **the friend's own GCP account** so billing,
blast radius, and ownership are his:

- `e2-micro`, `us-central1`, Ubuntu 24.04, 10 GB standard disk — within Always-Free.
- SSH-in-browser from the Console. Install Docker (`curl -fsSL https://get.docker.com | sudo sh`).
- Clone the repo, create `backend/.env`, foreground first run for the QR, then
  `docker compose up -d`.
- `restart: on-failure:10` — a clean `exit(0)` (dead WhatsApp creds) stays down for a human;
  a non-zero exit restarts up to 10 times.
- Set a **budget alert** (Billing → Budgets & alerts).
- Nothing inbound — the process makes only outbound connections (WhatsApp, OpenRouter,
  Supabase). Default firewall is fine.
- **(Optional) auto-deploy:** `.github/workflows/backend-cd.yml` runs the verify job
  (typecheck + tests) on push. The deploy job is commented out — uncomment it once the VM
  exists and add `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY` / `DEPLOY_PATH` secrets.

## 15. Build plan

**Status:** Phases 1–3 and 5 are implemented (`backend/` scaffolded, full flow written,
`npm run typecheck` + `npm test` green). Outstanding: Phase 4 (run against a live WhatsApp
connection — testing on Ahmad's number) and Phases 6–8.

### Phase 1 — Scaffold
Repo, `backend/` folder, `.env` handling, git. **Copy** `socket.ts`, `reconnect.ts`,
`fatal.ts`, `whatsapp/constants.ts`, `logger.js`, `dubaiDayStart`, `test-backoff.ts` from the
calorie tracker. Deps: `@whiskeysockets/baileys`, `@supabase/supabase-js`, `pino`,
`qrcode-terminal`.

### Phase 2 — Data layer
New Supabase project. Run `supabase/schema.sql` (`bills` table + index; RLS on, no policy).
`tests/test-db.ts` confirms insert lands, a duplicate `whatsapp_message_id` is rejected,
`periodTotal` sees the row, and `/undo` by the confirmation id works.

### Phase 3 — Extraction in isolation (no WhatsApp)
`llm/client.ts` + `billSchema.ts` against a local folder of sample photos — real receipts
*and* several non-receipts (job sites, screenshots, blurry shots). Iterate the prompt.
**Verify two things:** `is_receipt` discriminates reliably, and `total` matches the paper
receipt. `:free` is the default; fall back to the paid slug only if `:free` can't return
usable JSON often enough.

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
SIM, register, link. The friend's GCP VM, Docker, re-pair on the server. Friend adds the bot
to the real group. Grab the group JID from the log, set `TARGET_CHAT_JID`. Detached.

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
- **Every command open to everyone.** Any member can `/undo` any bill (though only the one
  they explicitly reply to — a bare `/undo` does nothing), or spam `/month`. *Accepted for
  v1* for simplicity. *Upgrade path:* an `ADMIN_JIDS` allowlist gating `/undo` (and
  optionally the summaries), checked against `key.participant`.
- **Free-model JSON reliability.** `:free` in both environments. The fence-strip +
  retry-once wrapper covers most parse failures; a persistent failure sends a generic
  "couldn't read that receipt" reply, not a crash. *Fallback:* flip `OPENROUTER_MODEL` to the
  paid `google/gemma-4-31b-it` (strict JSON schema) if real-use reliability is too low.
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
- A correction command (`/fix <amount>` on the last bill) instead of delete-and-resend.
- Multi-currency, if the business ever buys abroad.
- Migration to the official WhatsApp Cloud API if Baileys reliability degrades at volume.
