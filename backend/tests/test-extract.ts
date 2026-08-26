// Pure unit tests for the LLM response parser — fence-stripping, JSON.parse,
// hand validation, and the is_receipt normalisation. No network.
// Run: node tests/test-extract.ts
import assert from 'node:assert/strict'
import { parseBillResponse } from '../src/llm/billSchema.ts'

// plain JSON
{
    const b = parseBillResponse(
        '{"is_receipt":true,"total":128.5,"merchant":"ADNOC","bill_date":"2026-08-26","category":"Petrol","confidence":"high"}',
    )
    assert.equal(b.is_receipt, true)
    assert.equal(b.total, 128.5)
    assert.equal(b.merchant, 'ADNOC')
    assert.equal(b.bill_date, '2026-08-26')
    assert.equal(b.category, 'Petrol')
    assert.equal(b.confidence, 'high')
}

// ```json fenced
{
    const b = parseBillResponse(
        '```json\n{"is_receipt": true, "total": 40, "merchant": null, "bill_date": null, "category": "Food", "confidence": "low"}\n```',
    )
    assert.equal(b.total, 40)
    assert.equal(b.merchant, null)
    assert.equal(b.bill_date, null)
}

// bare ``` fence
{
    const b = parseBillResponse('```\n{"is_receipt":false,"total":null,"merchant":null,"bill_date":null,"category":null,"confidence":null}\n```')
    assert.equal(b.is_receipt, false)
    assert.equal(b.total, null)
}

// prose / reasoning around the JSON (a reasoning model that still leaks text)
{
    const b = parseBillResponse(
        'Looking at the receipt, the total is 40 AED.\n{"is_receipt": true, "total": 40, "merchant": "Carrefour", "bill_date": null, "category": "Food", "confidence": "high"}\nHope that helps!',
    )
    assert.equal(b.total, 40)
    assert.equal(b.merchant, 'Carrefour')
}

// not a receipt → every other field is normalised to null regardless of what the model returned
{
    const b = parseBillResponse('{"is_receipt":false,"total":999,"merchant":"junk","bill_date":"nonsense","category":"nope","confidence":"bad"}')
    assert.equal(b.is_receipt, false)
    assert.equal(b.total, null)
    assert.equal(b.merchant, null)
    assert.equal(b.category, null)
    assert.equal(b.confidence, null)
}

// a receipt with no category → defaults to Others
{
    const b = parseBillResponse('{"is_receipt":true,"total":12,"merchant":"x","bill_date":null,"confidence":"medium"}')
    assert.equal(b.category, 'Others')
}

// blank merchant string → null
{
    const b = parseBillResponse('{"is_receipt":true,"total":12,"merchant":"   ","bill_date":null,"category":"Food","confidence":"medium"}')
    assert.equal(b.merchant, null)
}

// --- rejections -----------------------------------------------------------

assert.throws(() => parseBillResponse('I could not read this image'), /parse failed/)
assert.throws(
    () => parseBillResponse('{"is_receipt":true,"total":"lots","merchant":"x","bill_date":null,"category":"Food","confidence":"high"}'),
    /bad total/,
)
assert.throws(
    () => parseBillResponse('{"is_receipt":true,"total":0,"merchant":"x","bill_date":null,"category":"Food","confidence":"high"}'),
    /bad total/,
)
assert.throws(
    () => parseBillResponse('{"is_receipt":true,"total":5,"merchant":"x","bill_date":null,"category":"Groceries","confidence":"high"}'),
    /bad category/,
)
assert.throws(
    () => parseBillResponse('{"is_receipt":true,"total":5,"merchant":"x","bill_date":"26 Aug","category":"Food","confidence":"high"}'),
    /bad bill_date/,
)
assert.throws(
    () => parseBillResponse('{"is_receipt":true,"total":5,"merchant":"x","bill_date":null,"category":"Food","confidence":"pretty sure"}'),
    /bad confidence/,
)
assert.throws(() => parseBillResponse('{"total":5}'), /is_receipt not a boolean/)
assert.throws(() => parseBillResponse('null'), /not an object/)

console.log('ok — bill response parsing')
