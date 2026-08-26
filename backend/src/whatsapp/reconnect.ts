/**
 * Reconnect policy, kept pure and in its own file so it can be tested without
 * opening a real WhatsApp socket (socket.ts connects on import).
 *
 * Copied verbatim from the calorie tracker, where it was written after the
 * 2026-07-29 incident: ~400k connection attempts in 12h, logging straight to the
 * VM's disk. Every rule below maps to one way that loop got started.
 */
import { MAX_WAIT_MS, REPLACED, SESSION_BROKEN, STABLE_MS, UNAUTHORIZED } from './constants.ts'

export { STABLE_MS }

export type ReconnectPlan =
    | { reconnect: true; wait: number; retry: number; reason?: undefined }
    | { reconnect: false; wait: 0; retry: number; reason: 'creds' | 'session' | 'replaced' }

export function reconnectPlan(opts: {
    /** statusCode off the Boom error, if any */
    statusCode?: number
    /** how many consecutive failed attempts precede this one */
    retry: number
    /** has pairing ever completed (creds.me set)? */
    paired: boolean
    /** how long the socket stayed open, 0 if it never opened */
    sessionMs: number
}): ReconnectPlan {
    const { statusCode, retry, paired, sessionMs } = opts

    // Retrying these forever is a silent storm that can never succeed.
    if (statusCode !== undefined && UNAUTHORIZED.includes(statusCode)) {
        return { reconnect: false, wait: 0, retry, reason: 'creds' }
    }
    if (statusCode !== undefined && SESSION_BROKEN.includes(statusCode)) {
        return { reconnect: false, wait: 0, retry, reason: 'session' }
    }
    // Not backoff — a replaced session often holds *longer* than STABLE_MS before
    // being replaced again, which would reset retry to 0 every cycle (see the next
    // block) and sustain the ping-pong at a fixed short interval forever.
    if (statusCode === REPLACED) {
        return { reconnect: false, wait: 0, retry, reason: 'replaced' }
    }

    // Only a connection that actually *held* resets the backoff. Resetting on
    // every 'open' is what let an open→close flap sustain ~1 attempt/sec: each
    // cycle looked like a fresh start, so the exponential never got going.
    const next = sessionMs >= STABLE_MS ? 0 : retry + 1

    // ponytail: capped exponential, no jitter — one client, no herd to thunder
    const backoff = Math.min(2 ** next * 1000, MAX_WAIT_MS)

    // Until pairing completes nothing is written to auth_session, so each retry
    // registers a *brand new* device identity. A burst of those from one IP is
    // itself a 405 trigger, so never start fast when unpaired.
    return { reconnect: true, wait: paired ? backoff : Math.max(backoff, MAX_WAIT_MS), retry: next }
}
