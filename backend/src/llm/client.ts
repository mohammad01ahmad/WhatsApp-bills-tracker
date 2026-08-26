import { CATEGORIES, type Bill } from '../utils/constants.ts'
import { billJsonSchema, parseBillResponse } from './billSchema.ts'

const MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free'
// The ":free" slug doesn't advertise structured_outputs, so it gets the loose
// path (json_object + fence-strip + one retry). The paid slug does → strict
// json_schema, no retry. Flip OPENROUTER_MODEL to switch; no code change.
const STRICT = !MODEL.endsWith(':free')

const SYSTEM = `You read a photo of a receipt or invoice and return a single JSON object.

If the image is NOT a receipt or invoice (a photo of people or a place, a screenshot of a chat, a random picture), return:
{"is_receipt": false, "total": null, "merchant": null, "bill_date": null, "category": null, "confidence": null}

Otherwise return:
{"is_receipt": true, "total": <number>, "merchant": <string|null>, "bill_date": <"YYYY-MM-DD"|null>, "category": <string>, "confidence": <"high"|"medium"|"low">}

- total: the final amount actually paid — the grand total including tax, not a subtotal or a single line item. A number, no currency symbol.
- merchant: the shop or company name, or null if not visible.
- bill_date: the date printed on the receipt, or null if none is shown.
- category: exactly one of ${CATEGORIES.map(c => `"${c}"`).join(', ')}. Use "Others" if nothing fits.
- confidence: how sure you are of the total.

All amounts are in AED. Return only the JSON object, no prose.`

async function callOnce(body: unknown): Promise<Bill> {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000), // a hung request otherwise blocks the message forever — no reply, no error
        headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`)

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error(`openrouter: no content in response: ${JSON.stringify(data).slice(0, 300)}`)
    return parseBillResponse(content)
}

/** Send one receipt image to the vision model and return the parsed, validated result. */
export async function extractBill(imageBuffer: Buffer, mimeType: string): Promise<Bill> {
    const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`
    const body: Record<string, unknown> = {
        model: MODEL,
        max_tokens: 1024,
        messages: [
            { role: 'system', content: SYSTEM },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Extract this receipt.' },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ],
            },
        ],
        response_format: STRICT
            ? { type: 'json_schema', json_schema: { name: 'bill', strict: true, schema: billJsonSchema } }
            : { type: 'json_object' },
    }

    // Strict path: one shot. Loose path: retry once — the free model fairly often
    // returns something unparseable on the first try but fine on the second.
    const attempts = STRICT ? 1 : 2
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
        try {
            return await callOnce(body)
        } catch (e) {
            lastErr = e
        }
    }
    throw lastErr
}
