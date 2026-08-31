// Command parsing for the group. Images are handled in socket.ts directly; this
// only classifies text messages and pulls apart the argument commands (/fix, /receipt).

import { CATEGORIES, type Category } from '../utils/constants.ts'

export const COMMANDS = ['today', 'week', 'month', 'undo', 'fix', 'receipt'] as const
export type Command = (typeof COMMANDS)[number]

// Derived from COMMANDS so the two never drift. `\b` keeps it a whole word
// (`/todays` doesn't match); the rest of the line is captured raw-cased.
const COMMAND_RE = new RegExp(`^/(${COMMANDS.join('|')})\\b(.*)$`, 'i')

/**
 * If `text` starts with a known `/command` (case-insensitive, whole word), returns
 * `{ cmd, rest }` where `rest` is the trimmed, original-case remainder after the
 * verb (`/undo please` → { cmd: 'undo', rest: 'please' }). Otherwise undefined.
 */
export function parseCommand(text: string): { cmd: Command; rest: string } | undefined {
    const m = text.trim().match(COMMAND_RE)
    return m ? { cmd: m[1].toLowerCase() as Command, rest: m[2].trim() } : undefined
}

/**
 * Parse a money amount from user text. Accepts "128", "128.50", "1,280.50".
 * Rejects zero, negatives, non-finite, and anything with stray characters —
 * bills.total has no positivity check in Postgres, so this is the only guard.
 */
export function parseAmount(s: string): number | undefined {
    const cleaned = s.trim().replace(/,/g, '')
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined
    const n = Number(cleaned)
    return Number.isFinite(n) && n > 0 ? n : undefined
}

// Keyword / number → Category. `Building Materials / Hardware Supplies` is
// unbearable to type on a phone, so accept shorthand and 1–4.
const CATEGORY_ALIASES: Record<string, Category> = {
    '1': 'Petrol',
    petrol: 'Petrol',
    fuel: 'Petrol',
    gas: 'Petrol',
    '2': 'Food',
    food: 'Food',
    meal: 'Food',
    meals: 'Food',
    '3': 'Building Materials / Hardware Supplies',
    materials: 'Building Materials / Hardware Supplies',
    material: 'Building Materials / Hardware Supplies',
    hardware: 'Building Materials / Hardware Supplies',
    hw: 'Building Materials / Hardware Supplies',
    '4': 'Others',
    others: 'Others',
    other: 'Others',
    misc: 'Others',
}

/** Map a user token (keyword or 1–4) to a Category, or undefined if unrecognised. */
export function resolveCategory(token: string): Category | undefined {
    const hit = CATEGORY_ALIASES[token.trim().toLowerCase()]
    return hit && CATEGORIES.includes(hit) ? hit : undefined // CATEGORIES stays the source of truth
}

export type ReceiptArgs = { total: number; category: Category; merchant: string | null }

/** Human-readable list of what `resolveCategory` accepts, for error replies. */
export const CATEGORY_HINT = 'petrol, food, materials, others (or 1–4)'

/**
 * Parse the arguments of `/receipt <amount> <category> [company…]`. Returns a
 * ReceiptArgs on success, or a string explaining what's wrong (sent as the reply).
 */
export function parseReceiptArgs(rest: string): ReceiptArgs | string {
    const parts = rest.split(/\s+/).filter(Boolean)
    if (parts.length < 2) return `Usage: /receipt <amount> <category> [company] — category: ${CATEGORY_HINT}`
    const total = parseAmount(parts[0])
    if (total === undefined) return `"${parts[0]}" isn't a valid amount.`
    const category = resolveCategory(parts[1])
    if (!category) return `"${parts[1]}" isn't a category. Use: ${CATEGORY_HINT}`
    return { total, category, merchant: parts.slice(2).join(' ') || null }
}
