// DB path check — no WhatsApp, no LLM. Hits the real `bills` table and cleans up
// after itself, so it's run manually, not by `npm test`.
// Run: node --env-file=.env tests/test-db.ts
import { insertBill, periodTotal, setReplyMessageId, undoByQuotedId, updateTotalByQuotedId } from '../src/db/bills.ts'
import { BILLS_TABLE, supabase } from '../src/db/client.ts'

console.log(`(using table: ${BILLS_TABLE})`)

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

// /fix by the confirmation id — returns the row with the new total
const fixed = await updateTotalByQuotedId(replyId, 200)
if (!fixed || fixed.id !== first.id || Number(fixed.total) !== 200) {
    throw new Error('FAIL: updateTotalByQuotedId did not return the row with the updated total')
}
console.log('ok: /fix updates the total by confirmation id')

const noFix = await updateTotalByQuotedId('NOSUCHID_' + Date.now(), 50)
if (noFix !== null) throw new Error('FAIL: /fix on an unknown id should return null')
console.log('ok: /fix on an unknown id returns null')

// undo by the confirmation id (the other anchor)
const removed = await undoByQuotedId(replyId)
if (!removed || removed.id !== first.id) throw new Error('FAIL: undo by reply_message_id did not return the row')
console.log('ok: undo by confirmation id')

const gone = await undoByQuotedId(replyId)
if (gone !== null) throw new Error('FAIL: second undo should find nothing')
console.log('ok: undo is idempotent')

// clean up any straggler (e.g. the duplicate path left something)
await supabase.from(BILLS_TABLE).delete().eq('whatsapp_message_id', msgId)
console.log('\nDB path works.')
