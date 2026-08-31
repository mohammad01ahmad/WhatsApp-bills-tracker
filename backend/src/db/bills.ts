import type { BillInsert } from '../utils/constants.ts'
import { supabase } from './client.ts'

// WhatsApp message ids are short alphanumeric tokens. Guard before interpolating
// into a PostgREST `.or()` filter string.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Insert one bill. Returns null if this WhatsApp message was already logged — the
 * unique index on whatsapp_message_id is the idempotency check (not a pre-read),
 * so a re-fired event hits error code 23505 and is treated as "already done".
 */
export async function insertBill(bill: BillInsert) {
    const { data, error } = await supabase.from('bills').insert(bill).select().single()

    if (error?.code === '23505') return null
    if (error) throw error
    return data
}

/** Record the confirmation message's id so `/undo` can also target it. Best effort. */
export async function setReplyMessageId(billId: string, replyMessageId: string) {
    const { error } = await supabase.from('bills').update({ reply_message_id: replyMessageId }).eq('id', billId)
    if (error) throw error
}

/**
 * Totals for a calendar period, filtered on created_at >= `sinceIso`.
 * ponytail: sums in JS, not a DB aggregate — a business logs tens of rows/day.
 */
export async function periodTotal(sinceIso: string) {
    const { data, error } = await supabase.from('bills').select('total, category').gte('created_at', sinceIso)

    if (error) throw error

    const byCategory: Record<string, number> = {}
    let total = 0
    for (const row of data) {
        const v = Number(row.total ?? 0)
        total += v
        byCategory[row.category] = (byCategory[row.category] ?? 0) + v
    }
    return { total, byCategory, count: data.length }
}

/**
 * Delete the one bill the user quoted with `/undo` — matching either the receipt
 * image's id (whatsapp_message_id) or the bot's confirmation id (reply_message_id).
 * Returns the deleted row, or null if nothing matched (already removed, or the
 * quoted message isn't a logged bill).
 */
export async function undoByQuotedId(stanzaId: string) {
    if (!SAFE_ID.test(stanzaId)) return null
    const { data, error } = await supabase
        .from('bills')
        .delete()
        .or(`whatsapp_message_id.eq.${stanzaId},reply_message_id.eq.${stanzaId}`)
        .select()

    if (error) throw error
    return data && data.length ? data[0] : null
}

/**
 * Set a new total on the one bill the user quoted with `/fix` — same two anchors
 * as `/undo` (the receipt image's id or the bot's confirmation id). Returns the
 * updated row (with the new total) or null if nothing matched.
 */
export async function updateTotalByQuotedId(stanzaId: string, total: number) {
    if (!SAFE_ID.test(stanzaId)) return null
    const { data, error } = await supabase
        .from('bills')
        .update({ total })
        .or(`whatsapp_message_id.eq.${stanzaId},reply_message_id.eq.${stanzaId}`)
        .select()

    if (error) throw error
    return data && data.length ? data[0] : null
}
