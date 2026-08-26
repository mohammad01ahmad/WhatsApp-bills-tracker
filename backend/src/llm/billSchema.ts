import { CATEGORIES, type Bill, type Category } from '../utils/constants.ts'

// JSON Schema for the paid slug's strict `response_format` (OpenAI-compatible:
// every property required, additionalProperties false, nullables as unions).
export const billJsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        is_receipt: { type: 'boolean' },
        total: { type: ['number', 'null'] },
        merchant: { type: ['string', 'null'] },
        bill_date: { type: ['string', 'null'] },
        category: { type: ['string', 'null'], enum: [...CATEGORIES, null] },
        confidence: { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] },
    },
    required: ['is_receipt', 'total', 'merchant', 'bill_date', 'category', 'confidence'],
} as const

const CONFIDENCES = ['high', 'medium', 'low']

/** Strip a ```json … ``` (or bare ```) fence the loose model may wrap output in. */
/**
 * Pull the JSON object out of a model response — tolerates a ```json fence, a
 * reasoning/prose prefix or suffix, and leading/trailing whitespace. Returns the
 * first `{` … last `}` slice, or the trimmed input if there's no brace pair.
 * ponytail: naive outermost-brace slice; breaks if the model emits `{`/`}` in
 * prose *before* the real JSON. Reasoning is disabled in the request to avoid
 * that; add a brace-depth scanner here if it still shows up in logs.
 */
function extractJson(s: string): string {
    const open = s.indexOf('{')
    const close = s.lastIndexOf('}')
    return open !== -1 && close > open ? s.slice(open, close + 1) : s.trim()
}

/**
 * Parse + hand-validate one model response into a `Bill`. Throws on anything
 * malformed — the caller retries once (loose path) then falls back to a generic
 * error reply. No schema library: the shape is six fields.
 */
export function parseBillResponse(raw: string): Bill {
    let obj: unknown
    try {
        obj = JSON.parse(extractJson(raw))
    } catch {
        throw new Error(`bill JSON parse failed: ${raw.slice(0, 200)}`)
    }
    if (typeof obj !== 'object' || obj === null) throw new Error('bill: not an object')
    const o = obj as Record<string, unknown>

    if (typeof o.is_receipt !== 'boolean') throw new Error(`bill: is_receipt not a boolean (${JSON.stringify(o.is_receipt)})`)

    // Not a receipt → normalise everything else away regardless of what the model sent.
    if (!o.is_receipt) {
        return { is_receipt: false, total: null, merchant: null, bill_date: null, category: null, confidence: null }
    }

    if (typeof o.total !== 'number' || !Number.isFinite(o.total) || o.total <= 0) {
        throw new Error(`bill: bad total (${JSON.stringify(o.total)})`)
    }
    if (o.category != null && !CATEGORIES.includes(o.category as Category)) {
        throw new Error(`bill: bad category (${JSON.stringify(o.category)})`)
    }
    if (o.confidence != null && !CONFIDENCES.includes(o.confidence as string)) {
        throw new Error(`bill: bad confidence (${JSON.stringify(o.confidence)})`)
    }
    if (o.bill_date != null && !(typeof o.bill_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.bill_date))) {
        throw new Error(`bill: bad bill_date (${JSON.stringify(o.bill_date)})`)
    }

    return {
        is_receipt: true,
        total: o.total,
        merchant: typeof o.merchant === 'string' && o.merchant.trim() ? o.merchant.trim() : null,
        bill_date: (o.bill_date as string | undefined) ?? null,
        category: (o.category as Category | undefined) ?? 'Others',
        confidence: (o.confidence as Bill['confidence']) ?? null,
    }
}
