// Asia/Dubai is UTC+4 with no DST (PRD §5), so every calendar boundary is plain
// arithmetic — no timezone library. The trick throughout: shift the instant by
// +4h so Dubai wall-clock lines up with UTC fields, do the math, shift back.

const DUBAI_OFFSET_MS = 4 * 60 * 60_000
const DAY_MS = 86_400_000

/** ISO UTC instant of the most recent Asia/Dubai midnight, as of `now`. */
export function dubaiDayStart(now = Date.now()): string {
    const shifted = now + DUBAI_OFFSET_MS
    const midnight = Math.floor(shifted / DAY_MS) * DAY_MS
    return new Date(midnight - DUBAI_OFFSET_MS).toISOString()
}

/** ISO UTC instant of the most recent Monday 00:00 Asia/Dubai (calendar week). */
export function dubaiWeekStart(now = Date.now()): string {
    const shifted = now + DUBAI_OFFSET_MS
    const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS
    const mondayOffset = (new Date(dayStart).getUTCDay() + 6) % 7 // 0 = Monday … 6 = Sunday
    return new Date(dayStart - mondayOffset * DAY_MS - DUBAI_OFFSET_MS).toISOString()
}

/** ISO UTC instant of the 1st of the current month, 00:00 Asia/Dubai (calendar month). */
export function dubaiMonthStart(now = Date.now()): string {
    const d = new Date(now + DUBAI_OFFSET_MS)
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    return new Date(first - DUBAI_OFFSET_MS).toISOString()
}

/** Asia/Dubai calendar date (YYYY-MM-DD) for `ms`. Used as the bill_date fallback. */
export function dubaiDate(ms: number): string {
    return new Date(ms + DUBAI_OFFSET_MS).toISOString().slice(0, 10)
}

const RULE = '━'.repeat(10)

/** "45.50 AED", "48,523.00 AED" */
function money(n: number): string {
    return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AED`
}

const receipts = (n: number) => `${n} ${n === 1 ? 'receipt' : 'receipts'}`

type BillFields = { merchant: string | null; total: number; category: string }

function billLines(b: BillFields): string[] {
    return [` · Amount: ${money(b.total)}`, ` · Company: ${b.merchant || 'Unknown'}`, ` · Expense: ${b.category}`]
}

/** Reply after a receipt is logged. `today` is null if the totals read failed. */
export function formatReceipt(bill: BillFields, today: { total: number; count: number } | null): string {
    const lines = ['RECEIPT PROCESSED', RULE, ...billLines(bill)]
    if (today) {
        lines.push(RULE, "TODAY'S TOTAL EXPENSES", ` · ${money(today.total)} (${receipts(today.count)})`)
    }
    return lines.join('\n')
}

/** Reply after /undo removes a bill. */
export function formatRemoved(bill: BillFields): string {
    return ['RECEIPT REMOVED', RULE, ...billLines(bill)].join('\n')
}

/** Reply to /today /week /month. `header` is e.g. "TODAY'S EXPENSES". */
export function formatSummary(
    header: string,
    r: { total: number; byCategory: Record<string, number>; count: number },
): string {
    if (r.count === 0) return [header, RULE, ' · Nothing logged yet'].join('\n')
    const cats = Object.entries(r.byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([c, v]) => ` · ${c}: ${money(v)}`)
    return [header, RULE, ...cats, RULE, 'TOTAL', ` · ${money(r.total)} (${receipts(r.count)})`].join('\n')
}
