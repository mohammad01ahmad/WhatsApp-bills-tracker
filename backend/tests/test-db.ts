// DB path check — no WhatsApp, no LLM. Hits the real `bills` table and cleans up
// after itself, so it's run manually, not by `npm test`.
// Run: node --env-file=.env tests/test-db.ts
import { insertBill, periodTotal, setReplyMessageId, undoByQuotedId } from '../src/db/bills.ts'
import { supabase } from '../src/db/client.ts'

const msgId = 'TEST_' + Date.now()
const replyId = 'REPLY_' + msgId
const bill = {
    whatsapp_message_id: msgId,
    total: 128.5,
    merchant: 'ADNOC',
    bill_date: '2026-08-26',
    category: 'Petrol' as const,
    confidence: 'high' as const,
}

const first = await insertBill(bill)
if (!first) throw new Error('FAIL: first insert returned null, expected a row')
console.log('ok: row inserted')

const dup = await insertBill(bill)
if (dup !== null) throw new Error('FAIL: duplicate accepted — the unique index on whatsapp_message_id is missing')
console.log('ok: duplicate rejected')

const totals = await periodTotal(new Date(Date.now() - 5 * 60_000).toISOString())
if (!(totals.total >= 128.5) || !totals.byCategory['Petrol']) {
    throw new Error('FAIL: periodTotal did not include the inserted row')
}
console.log('ok: periodTotal includes the row')

await setReplyMessageId(first.id, replyId)
console.log('ok: reply_message_id set')

// undo by the confirmation id (the other anchor)
const removed = await undoByQuotedId(replyId)
if (!removed || removed.id !== first.id) throw new Error('FAIL: undo by reply_message_id did not return the row')
console.log('ok: undo by confirmation id')

const gone = await undoByQuotedId(replyId)
if (gone !== null) throw new Error('FAIL: second undo should find nothing')
console.log('ok: undo is idempotent')

// clean up any straggler (e.g. the duplicate path left something)
await supabase.from('bills').delete().eq('whatsapp_message_id', msgId)
console.log('\nDB path works.')
