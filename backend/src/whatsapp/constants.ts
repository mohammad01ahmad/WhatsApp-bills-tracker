// Tuning knobs for the WhatsApp reconnect policy (reconnect.ts) — when to give
// up vs. retry, and how long to wait. Copied verbatim from the calorie tracker;
// every value here maps to a way the 2026-07-29 reconnect storm got started.

/** 401/403/419 — Baileys' UNAUTHORIZED_CODES. Creds are dead; only a QR scan fixes it. */
export const UNAUTHORIZED = [401, 403, 419]

/** 500 badSession / 411 multideviceMismatch — session itself is broken, not just creds. Only a fresh QR fixes either. */
export const SESSION_BROKEN = [500, 411]

/**
 * 440 connectionReplaced — another session took over this linked device.
 * Reconnecting replaces *them*, which makes *them* reconnect and replace
 * *you* — an unwinnable ping-pong backoff can't damp (see reason: 'replaced').
 */
export const REPLACED = 440

/** A connection that held this long counts as healthy, so its drop starts a fresh backoff. */
export const STABLE_MS = 60_000

export const MAX_WAIT_MS = 60_000
