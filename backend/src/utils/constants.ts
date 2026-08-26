// The fixed category set — mirrored in the DB `check` constraint (supabase/schema.sql)
// and validated in llm/billSchema.ts. `Others` is the model's escape hatch; it
// should never be forced into a bad fit.
export const CATEGORIES = [
    'Petrol',
    'Food',
    'Building Materials / Hardware Supplies',
    'Others',
] as const
export type Category = (typeof CATEGORIES)[number]

export type Confidence = 'high' | 'medium' | 'low'

/** What the vision model returns for one image (after parsing + validation). */
export type Bill = {
    is_receipt: boolean
    total: number | null
    merchant: string | null
    bill_date: string | null // YYYY-MM-DD, or null when the receipt shows no date
    category: Category | null
    confidence: Confidence | null
}

/**
 * Insert shape for the `bills` table. `id` / `created_at` have DB defaults and
 * `reply_message_id` is set separately after the confirmation send — so neither
 * belongs here.
 */
export type BillInsert = {
    whatsapp_message_id: string
    total: number
    merchant: string | null
    bill_date: string | null
    category: Category
    confidence: Confidence | null
}
