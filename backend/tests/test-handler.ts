// Pure unit test for command parsing + argument parsing. Run: node tests/test-handler.ts
import assert from 'node:assert/strict'
import { parseAmount, parseCommand, parseReceiptArgs, resolveCategory } from '../src/whatsapp/messageHandler.ts'

// --- parseCommand: verb ----------------------------------------------------

assert.equal(parseCommand('/today')?.cmd, 'today')
assert.equal(parseCommand('  /Week  ')?.cmd, 'week')
assert.equal(parseCommand('/MONTH')?.cmd, 'month')
assert.equal(parseCommand('/undo')?.cmd, 'undo')
assert.equal(parseCommand('/undo please')?.cmd, 'undo') // trailing text allowed
assert.equal(parseCommand('/fix 128.50')?.cmd, 'fix')
assert.equal(parseCommand('/receipt 340 materials')?.cmd, 'receipt')

assert.equal(parseCommand('/todays'), undefined) // \b — not a whole word
assert.equal(parseCommand('/fixture 1'), undefined) // \b — /fix is a whole word
assert.equal(parseCommand('hello /today'), undefined) // must be at the start
assert.equal(parseCommand('/calories 200g rice'), undefined) // the sibling bot's command
assert.equal(parseCommand('just a normal message'), undefined)
assert.equal(parseCommand(''), undefined)

// --- parseCommand: rest is trimmed and keeps its original case ------------

assert.equal(parseCommand('/receipt 128.50 petrol ADNOC')?.rest, '128.50 petrol ADNOC')
assert.equal(parseCommand('/fix  128.50  ')?.rest, '128.50')
assert.equal(parseCommand('/today')?.rest, '')

// --- parseAmount ---------------------------------------------------------

assert.equal(parseAmount('128'), 128)
assert.equal(parseAmount('128.50'), 128.5)
assert.equal(parseAmount(' 1,280.50 '), 1280.5)
assert.equal(parseAmount('0'), undefined) // must be positive
assert.equal(parseAmount('-5'), undefined)
assert.equal(parseAmount('12.'), undefined) // no fractional digits
assert.equal(parseAmount('abc'), undefined)
assert.equal(parseAmount('12 AED'), undefined) // stray characters
assert.equal(parseAmount(''), undefined)

// --- resolveCategory: keywords + numbers, case-insensitive ---------------

assert.equal(resolveCategory('petrol'), 'Petrol')
assert.equal(resolveCategory('FUEL'), 'Petrol')
assert.equal(resolveCategory('1'), 'Petrol')
assert.equal(resolveCategory('food'), 'Food')
assert.equal(resolveCategory('2'), 'Food')
assert.equal(resolveCategory('materials'), 'Building Materials / Hardware Supplies')
assert.equal(resolveCategory('hw'), 'Building Materials / Hardware Supplies')
assert.equal(resolveCategory('3'), 'Building Materials / Hardware Supplies')
assert.equal(resolveCategory('other'), 'Others')
assert.equal(resolveCategory('4'), 'Others')
assert.equal(resolveCategory('groceries'), undefined)
assert.equal(resolveCategory('5'), undefined)

// --- parseReceiptArgs --------------------------------------------------

assert.deepEqual(parseReceiptArgs('128.50 petrol ADNOC'), {
    total: 128.5,
    category: 'Petrol',
    merchant: 'ADNOC',
})
assert.deepEqual(parseReceiptArgs('340 3'), {
    total: 340,
    category: 'Building Materials / Hardware Supplies',
    merchant: null,
})
assert.deepEqual(parseReceiptArgs('50 food Al Manama Grocery'), {
    total: 50,
    category: 'Food',
    merchant: 'Al Manama Grocery',
})
assert.equal(typeof parseReceiptArgs('128.50'), 'string') // no category
assert.equal(typeof parseReceiptArgs('notanumber food'), 'string') // bad amount
assert.equal(typeof parseReceiptArgs('50 groceries'), 'string') // bad category
assert.equal(typeof parseReceiptArgs(''), 'string')

console.log('ok — command + argument parsing')
