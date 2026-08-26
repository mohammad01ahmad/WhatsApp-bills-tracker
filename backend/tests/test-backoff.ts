// Guards the reconnect policy against a repeat of the 2026-07-29 storm
// (~400k attempts in 12h). Run: node tests/test-backoff.ts
import assert from 'node:assert/strict'
import { reconnectPlan, STABLE_MS } from '../src/whatsapp/reconnect.ts'

/** Replays a loop for `hours` and counts attempts. `sessionMs` models what WA does each cycle. */
function stormSize(hours: number, sessionMs: number, paired: boolean) {
    let elapsed = 0, retry = 0, attempts = 0
    const limit = hours * 3600_000
    while (elapsed < limit) {
        const plan = reconnectPlan({ retry, paired, sessionMs })
        if (!plan.reconnect) break
        elapsed += plan.wait + sessionMs
        retry = plan.retry
        attempts++
    }
    return attempts
}

// The original bug: never connects at all. Backoff must cap this hard.
assert.ok(stormSize(12, 0, true) < 800, 'never-connects loop must stay under 800 attempts/12h')

// The bug missed first time: WA accepts then instantly drops. Resetting the
// counter on every 'open' let this run at ~1/sec — 43k attempts in 12h.
const flap = stormSize(12, 500, true)
assert.ok(flap < 800, `open→close flap must not outrun the backoff, got ${flap}`)

// A genuinely healthy session that drops should reconnect promptly, not wait 60s.
assert.equal(reconnectPlan({ retry: 9, paired: true, sessionMs: STABLE_MS }).wait, 1000)
assert.equal(reconnectPlan({ retry: 9, paired: true, sessionMs: STABLE_MS }).retry, 0)

// Unpaired never dips below the 60s floor — each attempt mints a new device identity.
for (const retry of [0, 1, 5, 20]) {
    assert.ok(reconnectPlan({ retry, paired: false, sessionMs: 0 }).wait >= 60_000, `unpaired retry=${retry}`)
}

// Dead creds: reconnecting can never fix them, so it must stop and say so.
for (const statusCode of [401, 403, 419]) {
    const plan = reconnectPlan({ statusCode, retry: 0, paired: true, sessionMs: 0 })
    assert.equal(plan.reconnect, false, `${statusCode}`)
    assert.equal(plan.reason, 'creds', `${statusCode} reason`)
}
// Broken session (badSession / multideviceMismatch): same terminal treatment, distinct reason.
for (const statusCode of [500, 411]) {
    const plan = reconnectPlan({ statusCode, retry: 0, paired: true, sessionMs: 0 })
    assert.equal(plan.reconnect, false, `${statusCode}`)
    assert.equal(plan.reason, 'session', `${statusCode} reason`)
}
// Replaced (440): terminal too, but tagged separately so the caller applies a long cooldown.
{
    const plan = reconnectPlan({ statusCode: 440, retry: 0, paired: true, sessionMs: STABLE_MS + 1 })
    assert.equal(plan.reconnect, false)
    assert.equal(plan.reason, 'replaced')
}
// 405 is WA rate-limiting, not dead creds — that one must keep retrying.
assert.equal(reconnectPlan({ statusCode: 405, retry: 0, paired: true, sessionMs: 0 }).reconnect, true)

// Backoff is capped, never unbounded.
assert.equal(reconnectPlan({ retry: 30, paired: true, sessionMs: 0 }).wait, 60_000)

console.log(`ok — 12h worst case: ${stormSize(12, 0, true)} attempts (never-connects), ${flap} (flapping)`)
