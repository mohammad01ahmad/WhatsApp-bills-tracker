// Pure unit tests for utils/functions.ts — period boundaries + reply formatting.
// No network, no DB. Run: node tests/test-utils.ts
import assert from 'node:assert/strict'
import {
    dubaiDate,
    dubaiDayStart,
    dubaiMonthStart,
    dubaiWeekStart,
    formatReceipt,
    formatRemoved,
    formatSummary,
} from '../src/utils/functions.ts'

const DAY_MS = 86_400_000
const OFFSET = 4 * 3600_000

// --- day boundary -----------------------------------------------------------

// 00:30 and 23:30 Dubai on the same day map to the same UTC boundary.
const morning = Date.parse('2026-08-03T00:30:00+04:00')
const night = Date.parse('2026-08-03T23:30:00+04:00')
assert.equal(dubaiDayStart(morning), dubaiDayStart(night))
assert.equal(dubaiDayStart(morning), '2026-08-02T20:00:00.000Z')

// 00:30 UTC and 03:00 UTC are the same Dubai calendar day — the case a naive UTC split gets wrong.
assert.equal(dubaiDayStart(Date.parse('2026-08-03T00:30:00Z')), dubaiDayStart(Date.parse('2026-08-03T03:00:00Z')))

// --- week boundary (calendar week, Monday) ---------------------------------

function isDubaiMidnight(iso: string, weekday?: number) {
    const d = new Date(Date.parse(iso) + OFFSET)
    const ok = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
    return weekday === undefined ? ok : ok && d.getUTCDay() === weekday
}

for (const sample of ['2026-08-26T12:00:00+04:00', '2026-01-01T09:00:00+04:00', '2026-12-31T23:00:00+04:00']) {
    const now = Date.parse(sample)
    const wk = dubaiWeekStart(now)
    assert.ok(isDubaiMidnight(wk, 1), `${sample}: week start must be a Dubai Monday 00:00, got ${wk}`)
    const delta = now - Date.parse(wk)
    assert.ok(delta >= 0 && delta < 7 * DAY_MS, `${sample}: now must fall inside the week starting at ${wk}`)
}

// Mon 00:30 and the following Sun 23:30 share a week start.
assert.equal(
    dubaiWeekStart(Date.parse('2026-08-03T00:30:00+04:00')),
    dubaiWeekStart(Date.parse('2026-08-09T23:30:00+04:00')),
)

// --- month boundary (calendar month, the 1st) ----------------------------

for (const sample of ['2026-08-01T00:30:00+04:00', '2026-08-26T18:00:00+04:00', '2026-12-15T10:00:00+04:00']) {
    const now = Date.parse(sample)
    const ms = dubaiMonthStart(now)
    const d = new Date(Date.parse(ms) + OFFSET)
    assert.ok(isDubaiMidnight(ms), `${sample}: month start must be Dubai 00:00, got ${ms}`)
    assert.equal(d.getUTCDate(), 1, `${sample}: month start must be the 1st`)
    assert.equal(d.getUTCMonth(), new Date(now + OFFSET).getUTCMonth(), `${sample}: same month as now`)
}
assert.equal(dubaiMonthStart(Date.parse('2026-08-26T18:00:00+04:00')), '2026-07-31T20:00:00.000Z')
assert.equal(dubaiMonthStart(Date.parse('2026-12-15T10:00:00+04:00')), '2026-11-30T20:00:00.000Z')

// --- dubaiDate (bill_date fallback) --------------------------------------

assert.equal(dubaiDate(Date.parse('2026-08-26T23:30:00+04:00')), '2026-08-26')
assert.equal(dubaiDate(Date.parse('2026-08-26T21:00:00Z')), '2026-08-27') // 01:00 Dubai next day

// --- formatters --------------------------------------------------------------

const RULE = '━'.repeat(10)

// formatReceipt — full block with today's total
assert.deepEqual(
    formatReceipt({ merchant: 'Carrefour Al Manama', total: 45.5, category: 'Food' }, { total: 185.2, count: 4 }).split('\n'),
    [
        'RECEIPT PROCESSED',
        RULE,
        ' · Amount: 45.50 AED',
        ' · Company: Carrefour Al Manama',
        ' · Expense: Food',
        RULE,
        "TODAY'S TOTAL EXPENSES",
        ' · 185.20 AED (4 receipts)',
    ],
)
// today read failed → receipt block only, no TODAY section; null merchant → "Unknown"
assert.deepEqual(
    formatReceipt({ merchant: null, total: 7, category: 'Others' }, null).split('\n'),
    ['RECEIPT PROCESSED', RULE, ' · Amount: 7.00 AED', ' · Company: Unknown', ' · Expense: Others'],
)
// singular receipt + thousands separator
assert.match(formatReceipt({ merchant: 'X', total: 1, category: 'Food' }, { total: 48523, count: 1 }), /48,523\.00 AED \(1 receipt\)/)

// formatRemoved
assert.deepEqual(formatRemoved({ merchant: 'ADNOC', total: 128.5, category: 'Petrol' }).split('\n'), [
    'RECEIPT REMOVED',
    RULE,
    ' · Amount: 128.50 AED',
    ' · Company: ADNOC',
    ' · Expense: Petrol',
])

// formatSummary — empty period
assert.deepEqual(formatSummary("TODAY'S EXPENSES", { total: 0, byCategory: {}, count: 0 }).split('\n'), [
    "TODAY'S EXPENSES",
    RULE,
    ' · Nothing logged yet',
])
// formatSummary — categories sorted desc, TOTAL block
assert.deepEqual(
    formatSummary("THIS MONTH'S EXPENSES", { total: 300, byCategory: { Food: 100, Petrol: 200 }, count: 3 }).split('\n'),
    [
        "THIS MONTH'S EXPENSES",
        RULE,
        ' · Petrol: 200.00 AED',
        ' · Food: 100.00 AED',
        RULE,
        'TOTAL',
        ' · 300.00 AED (3 receipts)',
    ],
)

console.log('ok — period boundaries + formatters')
