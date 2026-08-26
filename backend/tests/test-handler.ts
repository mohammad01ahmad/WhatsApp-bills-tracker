// Pure unit test for command parsing. Run: node tests/test-handler.ts
import assert from 'node:assert/strict'
import { parseCommand } from '../src/whatsapp/messageHandler.ts'

assert.equal(parseCommand('/today'), 'today')
assert.equal(parseCommand('  /Week  '), 'week')
assert.equal(parseCommand('/MONTH'), 'month')
assert.equal(parseCommand('/undo'), 'undo')
assert.equal(parseCommand('/undo please'), 'undo') // trailing text allowed

assert.equal(parseCommand('/todays'), undefined) // \b — not a whole word
assert.equal(parseCommand('hello /today'), undefined) // must be at the start
assert.equal(parseCommand('/calories 200g rice'), undefined) // the sibling bot's command
assert.equal(parseCommand('just a normal message'), undefined)
assert.equal(parseCommand(''), undefined)

console.log('ok — command parsing')
