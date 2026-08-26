# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: backend built, not yet run against WhatsApp

`backend/` is scaffolded and the full flow is implemented. `npm run typecheck` and `npm test`
(pure units) pass. **Not yet exercised against a live WhatsApp connection or a real Supabase
project** — that's the next step (test on Ahmad's number). The `docs/PRD.md` build plan
Phases 4–5 are what's outstanding. Keep this file matched to the code as it changes — don't
let it drift into fiction (the sibling `whatsapp-calorie-tracker/CLAUDE.md` already claims
`npm start` runs `src/whatsapp/socket.ts` and `npm test` runs one test; both are wrong now —
don't inherit that).

## What this is

An automated **expense tracker for a small business** (Ahmad builds and operates it; a friend
owns the business, the data, and the infra). Employees drop receipt/invoice photos into a
WhatsApp group; a bot on a **dedicated WhatsApp number** that sits in the group reads each
image with a vision LLM, extracts the total + merchant + date + category, and writes a row to
a Supabase `bills` table. `/today` `/week` `/month` `/undo` query it back into the group.

Full product spec: **`docs/PRD.md`**. This file is the build contract — how the code is
shaped and why.

It's a structural sibling of `../whatsapp-calorie-tracker` — same Baileys socket, same
reconnect/fatal/backoff policy, same Supabase-behind-the-service-role write path, same "Node
strips TS types at runtime, no build step" setup. The socket layer (`socket.ts`,
`reconnect.ts`, `fatal.ts`, `whatsapp/constants.ts`) is **copied from that project**, not
shared — the two are free to diverge, and the reconnect logic is load-bearing enough (see
the incident history in Connection lifecycle below) that it shouldn't shift under one project
because the other needed something.

What's different from the calorie tracker: the input is an **image, not text**; the trigger
is **any image in one group**, not `/calories` in a self-chat; extraction runs a **vision
model** and gates on an **`is_receipt` check** so the bot stays silent on the group's
non-receipt photos.

### Two environments (see `docs/PRD.md` §11)

One codebase, two `.env`s. **Testing:** runs on Ahmad's laptop, linked to Ahmad's own
WhatsApp number, `TARGET_CHAT_JID` = his self-chat or a throwaway group. **Production:** runs
on the friend's own GCP VM, linked to the dedicated bot number, `TARGET_CHAT_JID` = the
business group. Both use the `:free` Gemma slug and the same dedicated Supabase project —
single tenant, no per-row `user_id`, so the only differences are the WhatsApp identity, the
target chat, and where it runs.

## Commands

```bash
cd backend
npm install                          # once — generates package-lock.json (the Dockerfile needs it)
npm start                            # node --env-file=.env src/index.js — starts the Baileys socket, this is the app
npm run typecheck                    # tsc; there is no build step
npm test                             # pure units, no network: test-backoff (reconnect policy), test-utils (period math + formatters), test-extract (LLM response parsing), test-handler (command parsing)
node --env-file=.env tests/test-db.ts # hits the real Supabase bills table — insert lands, duplicate rejected, /undo works. Run manually.
```

No test framework. Tests are plain `node:assert` scripts. `test-db.ts` touches the real
table and cleans up after itself, so it's manual, not part of `npm test`.

## Node runs TypeScript directly — no build

`npm start` is `node --env-file=.env src/index.js`. Node strips types at runtime. This is
why `tsconfig.json` sets `erasableSyntaxOnly` and `allowImportingTsExtensions`, and why
**every relative import must carry the `.ts` extension** (`./messageHandler.ts`). Enums,
namespaces, parameter properties, and anything else that emits code fail at runtime, not
just at typecheck. `.js` files (`logger.js`, `index.js`) are plain JS and import each other
with `.js`.

## Flow

`socket.ts` is entry point, event wiring, and orchestration in one file, same as the calorie
tracker:

1. `messages.upsert` fires → skip unless `type === 'notify'` (otherwise history replays on
   every reconnect and reprocesses everything).
2. **Chat filter — two modes, keyed off whether `TARGET_CHAT_JID` is set.**
   - **Set** (production): match `jidNormalizedUser(m.key.remoteJid)` *or* `remoteJidAlt`
     against it. That's the business group.
   - **Unset** (testing): self-chat mode — match against
     `[sock.user.id, sock.user.lid, sock.user.phoneNumber]` (all normalized), checking both
     `remoteJid` and `remoteJidAlt`. This is the calorie tracker's `isSelfChat` check
     verbatim, and it's why testing needs **no** JID config. v7 routes self-chat by LID, so
     a message flips between the phone-number form and `…@lid` — checking every "me" form
     against both fields is the only reliable match.

   Neither mode requires `fromMe`. In self-chat testing *you* send the receipts
   (`fromMe: true`); in the group, employees' messages are `fromMe: false`. There is no
   sender allowlist — deliberate: anyone in the watched chat can cause an OpenRouter call by
   posting a photo. What stops the bot reprocessing its own replies is `sentByBot`, a Set of
   message ids this process sent (`skipped: the bot sent this`), not a `fromMe` check.
   Mitigations that make the open trigger acceptable: one chat ever watched, only
   `imageMessage` runs extraction, and the `is_receipt` gate (step 6) keeps the bot silent
   on non-receipts.
3. A message from any *other* chat is dropped, and its JID is logged once at `info`
   (`noteForeignChat`) — that's how you get the group JID for production (add the bot to the
   group, someone posts, copy the JID, set `TARGET_CHAT_JID`, restart).
4. **If the message is an image:** download it with
   `downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })`.
   `reuploadRequest` matters: WhatsApp's media URLs expire, and without it an older image
   throws instead of being re-requested from the sender's device.
5. Cap the buffer size before base64-encoding it into the request body (e.g. reject over
   ~5 MB). An unbounded encode is how one large photo becomes a multi-MB payload and a
   silent 30s timeout.
6. `llm/client.ts` → OpenRouter chat/completions with the image as an `image_url` content
   part and a 30s timeout. Response includes `is_receipt`. **If `is_receipt` is false or
   `total` is null → debug-log and stop. No reply, no row.** This is what keeps the bot quiet
   on job-site photos, screenshots, and chat images. See **JSON handling** below.
7. `db/bills.ts` inserts the row **before** replying — a confirmation must mean the row
   landed. Same rule as the calorie tracker.
8. The reply is `formatReceipt(...)` (`utils/functions.ts`): a `RECEIPT PROCESSED` block —
   `· Amount:` / `· Company:` / `· Expense:` — then a `TODAY'S TOTAL EXPENSES` line from
   `periodTotal(dubaiDayStart())` (today, not month). If that totals read fails, the receipt
   block is sent without the total. **No budget, no progress bar, no confidence line** —
   confidence is stored but not shown (a `low` warning line is a `ponytail:`-flagged add).
9. **Store the confirmation's message id** (`reply_message_id` on the row) from the
   `sendMessage` return value, right after the send succeeds. It's the second `/undo` anchor
   (see below). Nullable — if the send fails the row still exists and is undoable via the
   receipt image.

**If the message is a text command** (`/today`, `/week`, `/month`, `/undo`): match it in
`messageHandler.ts`, run the query in `db/bills.ts`, reply into the group. **All four are
open to every group member** (v1 — no admin gate). `/undo` is special:

- It **must be a reply**. Read the quoted message id from
  `m.message.extendedTextMessage.contextInfo.stanzaId`.
- Delete the one bill where `whatsapp_message_id = stanzaId` **OR** `reply_message_id =
  stanzaId` — i.e. the user can reply to either the receipt image or the bot's confirmation.
  Steer users to the confirmation (it shows the amount); the image is the fallback.
- Row found → delete, reply `formatRemoved(...)` — a `RECEIPT REMOVED` block.
- No match → `Nothing logged for that message.` (plain, not a block).
- **Bare `/undo`** (no quoted message) → delete nothing, reply a one-line hint. Deliberate:
  a bare `/undo` deleting "the most recent bill" globally would, in a multi-submitter group,
  usually delete the wrong person's row.

If the LLM call or the insert throws, the per-message `catch` sends a generic "couldn't read
that receipt" reply, **not** `error.message` — provider/DB error text can carry request
details into the chat log. That send is itself `.catch()`'d: an unprotected `await` on a
dead socket would escape the catch as an unhandled rejection and kill the process over one
bad receipt.

## Idempotency

Identical mechanism to the calorie tracker: a unique index `bills_whatsapp_message_id_key`
in Postgres, **not** a pre-read. `populateTable` catches Postgres error code `23505` and
returns `null`; `socket.ts` treats `null` as "already logged, don't confirm twice". Do not
replace this with select-then-insert. `tests/test-db.ts` is what proves the index still
exists — if it's ever dropped, idempotency silently becomes a no-op and every duplicate
double-confirms.

## JSON handling — model slug decides it

**The highest-risk part of the build.** The model is `google/gemma-4-31b-it:free` on
OpenRouter in **both environments** (verified: image input, 262k context). `client.ts` keys
its JSON strategy off the `:free` suffix of `OPENROUTER_MODEL`:

- **`:free` slug (the default, `!STRICT`).** No `structured_outputs`. Expected JSON shape in
  the prompt; `response_format: { type: "json_object" }` (best effort); strip a
  ```` ```json ``` ```` fence if present; hand-validate in `billSchema.ts` with a few
  `typeof` / enum-membership checks (no schema library); on a parse *or* validation failure
  **retry exactly once**, then give up and send the generic error reply.
- **paid `google/gemma-4-31b-it` (`STRICT`) — fallback only.** Advertises `structured_outputs`,
  so `client.ts` switches to `response_format: { type: "json_schema", strict: true }` and
  drops the retry. Flip `OPENROUTER_MODEL` to this if `:free` can't return usable JSON often
  enough in real use — no code change. Costs a few US cents/day at business volume.

Both paths already exist in `client.ts`; `const STRICT = !MODEL.endsWith(':free')` selects.
The expected object either way:

```json
{ "is_receipt": true, "total": 128.50, "merchant": "ADNOC",
  "bill_date": "2026-08-26", "category": "Petrol", "confidence": "high" }
```

`is_receipt: false` → `parseBillResponse` normalises every other field to null, bot ignores
silently. `bill_date: null` → `socket.ts` falls back to the message's Dubai date. `category`
missing on a receipt → defaults to `Others`. `confidence` is stored, not acted on in v1.

**Verify empirically in Phase 3** (against real receipts *and* non-receipts): does the model
discriminate `is_receipt` reliably, and does `total` match the paper receipt? Fall back to
the paid slug only if `:free` proves too unreliable.

## Connection lifecycle & reliability

**Inherited from the calorie tracker's 2026-07 reliability hardening. Treat as load-bearing,
not incidental.** That project survived a 2026-07-29 incident: an open→close flap sustained
~400k reconnect attempts in 12h, logging straight to the VM's disk. `reconnect.ts`,
`fatal.ts`, and `whatsapp/constants.ts` exist because of it.

- `reconnect.ts` exports a pure function, `reconnectPlan`, with no Baileys/socket import so
  it's unit-testable without a live connection. `tests/test-backoff.ts` replays worst-case
  loops and asserts the attempt count stays bounded.
- Backoff keys off the **raw status code** on the close error, not `DisconnectReason` — WA's
  405 rate-limit response isn't in that enum. Three status groups are terminal
  (`reconnect: false`) instead of retried forever:
  - **401/403/419** (`reason: 'creds'`) — dead credentials → `fatal(retryable: false)` →
    `exit(0)`.
  - **500/411** (`reason: 'session'`) — broken session → same, `exit(0)`.
  - **440** (`reason: 'replaced'`) — another session took the same linked device. Retrying
    immediately starts a replace-each-other ping-pong, so this gets a **5-minute cooldown**
    then one retry (`retryable: true`, `delayMs: 300_000`).
- `fatal.ts` is the **only** place allowed to call `process.exit`. `retryable: false` →
  `exit(0)`, which `docker-compose.yml`'s `restart: on-failure:10` treats as "stay down,
  needs a human" (a `0` exit never restarts under `on-failure`). `retryable: true` →
  `exit(1)` after an optional in-app `delayMs` sleep, so a retry has real distance before
  Docker's own ~1-minute-capped restart backoff.
- `fetchLatestWaWebVersion` runs **only on a fresh start or right after an observed 405**,
  not every reconnect, and is capped at a 5s timeout. It doesn't throw internally (falls
  back to Baileys' pinned version), but with no timeout a slow `web.whatsapp.com` stalls
  every reconnect.
- `makeWASocket` sets `getMessage` to a stub (`async () => undefined` — no message store, so
  resend requests can't be fulfilled; that's fine, this bot sends no polls) and
  `markOnlineOnConnect: false` (default `true` suppresses phone push notifications, including
  for this bot's own replies).

**Two things the calorie tracker's `docs/baileys-production-audit-2.md` recommended that are
deliberately NOT in the code. That audit doc does not exist in this repo — so the reasoning
lives here now. Do not re-add either without reading this.**

- **No "connected but wedged" watchdog.** One was added (audit §1 Fix 4) and removed
  2026-07-31 after it killed a demonstrably healthy connection — logs showed `got my own
  devices` (an inbound server-pushed notification, requiring a genuinely live two-way
  socket) minutes before a timer fired and restarted the container anyway. Root cause: it
  reset only on `'open'`, never on any later liveness signal, so it fired ~15min after
  *every* successful connect regardless of health — the steady-state behavior, not an edge
  case. It also duplicated something Baileys already does: `Socket/socket.js` pings every
  30s and self-closes with `DisconnectReason.connectionLost` (408) after 35s of silence, and
  408 isn't in any terminal set, so it already flows through normal backoff. A frozen event
  loop — the one case an app-level timer could help with — would also freeze the watchdog's
  own timer, so there's no real gap left to cover.
- **No `shouldSyncHistoryMessage: () => false`.** Added per audit §6, also removed
  2026-07-31. Baileys' own `makeSocket` logs an unconditional `⚠️ DANGER` warning when every
  history-sync type is disabled, because initial history sync is one of the paths that
  populates LID mappings — disabling it entirely undermines the v7 LID handling the JID
  matching depends on. The memory concern that motivated it is already handled by Baileys'
  *default* `shouldSyncHistoryMessage` (which excludes only the expensive `FULL` sync). The
  fix was to delete the override, not tune it.

## Data + secrets

Backend writes go through `db/client.ts` with the **service role key** (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`), which bypasses RLS. It throws at boot if
either is missing.

**A dedicated Supabase project for this business** — *not* the calorie tracker's (that was an
early assumption, dropped once this became a friend's business: separate billing, separate
ownership, clean handoff). Run `supabase/schema.sql`. The receipt image is **not** persisted.

```sql
create table bills (
  id                   uuid primary key default gen_random_uuid(),
  whatsapp_message_id  text not null unique,          -- Baileys key.id of the receipt image — idempotency + primary /undo anchor
  reply_message_id     text,                          -- Baileys key.id of the bot's confirmation — the other /undo anchor; nullable
  total                numeric not null,              -- AED; no currency column, every invoice is AED
  merchant             text,
  bill_date            date,                          -- from the receipt; falls back to message date when absent
  category             text not null check (category in (
                         'Petrol', 'Food', 'Building Materials / Hardware Supplies', 'Others')),
  confidence           text check (confidence in ('high', 'medium', 'low')),
  created_at           timestamptz not null default now()
);

create index bills_created_idx on bills (created_at desc);
alter table bills enable row level security;   -- no policy: not readable with the anon key
```

- **No `user_id`.** Single tenant — one business, one group. The backend writes with the
  service-role key; nothing needs per-row ownership, and dropping the `auth.users` FK means
  the backend runs against a bare project (no auth user to pre-create). A dashboard that
  needs it re-adds it as a 3-line migration (every row the same value).
- `whatsapp_message_id` — unique, the sole idempotency mechanism (`23505` → treat as already
  logged), and the `/undo` anchor when the user replies to the receipt image.
- `reply_message_id` — set from the confirmation `sendMessage` return value; the `/undo`
  anchor when the user replies to the bot's confirmation. Not unique, nullable.
- **No `currency` column.** Every invoice is guaranteed AED (confirmed with the owner). Not
  an always-`'AED'` column — no column. A non-AED receipt would be a schema change; until
  then summaries sum `total` directly.
- `created_at` (default `now()`) is what all period queries filter on. `bill_date` is
  informational.
- `category` is a fixed 4-value enum, both in the DB `check` and as a validated set in the
  extraction code: **`Petrol`**, **`Food`**, **`Building Materials / Hardware Supplies`**,
  **`Others`**. `Others` is the model's escape hatch — it should never be forced into a bad fit.
- **No sender column** in v1 (the employee who posted is not stored — see PRD §17 for the v2
  reconsideration).
- **RLS on, no policy** — deny-by-default. Writes are service-role and bypass RLS. A future
  dashboard using the publishable key reads zero rows until it adds a `select` policy
  matching its gate (single tenant → likely a shared-credential gate + server-side reads,
  not per-user RLS).

`backend/auth_session/` holds Baileys credentials — **gitignore it with a glob**
(`auth_session*/`), not a bare `auth_session/`. The calorie repo committed `auth_session.bak`
on 2026-07-31 because the bare rule let it slip past. Treat the directory as a secret:
anyone with it has the linked WhatsApp session. Deleting it forces a new QR link on next
start (QR prints to the terminal).

The `supabase` MCP server is configured in `.mcp.json` — prefer it over guessing at schema.

## Time / periods

Same fixed-offset approach as the calorie tracker: Asia/Dubai is UTC+4, no DST, so day
boundaries are plain arithmetic (`utils/functions.ts`: `dubaiDayStart` / `dubaiWeekStart` /
`dubaiMonthStart` / `dubaiDate`). The trick: shift the instant +4h so Dubai wall-clock lines
up with UTC fields, do the math, shift back.

Period commands are **calendar**, not rolling:

- `/today` — since the most recent Dubai midnight.
- `/week` — since **Monday** 00:00 Dubai (calendar week).
- `/month` — since the **1st** 00:00 Dubai (calendar month).

Early in a period the number is legitimately small; that's expected, not a bug.

## Deploy note

**Production runs on the friend's own GCP account** — his own Always-Free `e2-micro`, his
billing, his blast radius. Not co-located with the calorie bot (the free tier is one
`e2-micro` per account anyway). Same Docker setup as the calorie tracker:
`restart: on-failure:10`, capped `json-file` logging, `auth_session/` bind mount. Outbound
only (WhatsApp, OpenRouter, Supabase) — no inbound firewall rules.

- The bot is a linked device on the **dedicated bot number**, not on Ahmad's or the friend's
  personal WhatsApp. It needs its **own** `auth_session/`.
- `docker-compose.yml` still **sets an explicit top-level `name:`** — cheap insurance so a
  bare `backend` dir name never collides with anything else on the box (e.g. if Ahmad ever
  runs the test instance on the same machine as something else).

### Testing alongside the calorie tracker (Ahmad's number)

The test instance links to Ahmad's own number — which already has the calorie bot as a
linked device. This is fine **only if**: (1) it does its own QR scan into its own
`auth_session/` — never copy the calorie tracker's creds (shared creds → endless 440
"replaced" fights); (2) there's a free companion-device slot (WhatsApp allows 4; Ahmad may
need to drop WhatsApp Web/Desktop). Triggers don't collide: the calorie bot only reacts to
`/calories` in Ahmad's self-chat, this bot only to images + `/today|/week|/month|/undo` in
`TARGET_CHAT_JID`. Remove the test linked device from WhatsApp → Linked Devices when done.

## Finding `TARGET_CHAT_JID` (production only)

Testing needs nothing here — unset `TARGET_CHAT_JID` = self-chat mode.

For production: run with `TARGET_CHAT_JID` still unset, add the bot to the business group,
have someone post. `socket.ts` logs the group's JID once at `info`:
`"saw a message in a chat this bot is not watching — set TARGET_CHAT_JID to this jid…"`.
Copy that `…@g.us` value into `.env`, restart.
