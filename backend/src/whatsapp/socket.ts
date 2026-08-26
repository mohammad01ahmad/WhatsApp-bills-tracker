import makeWASocket, {
    downloadMediaMessage,
    fetchLatestWaWebVersion,
    jidNormalizedUser,
    useMultiFileAuthState,
    type WAMessage,
    type WAVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import type { Logger } from 'pino'
import qrcode from 'qrcode-terminal'
import { parseCommand, type Command } from './messageHandler.ts'
import { reconnectPlan } from './reconnect.ts'
import { fatal } from './fatal.ts'
import { extractBill } from '../llm/client.ts'
import { insertBill, periodTotal, setReplyMessageId, undoByQuotedId } from '../db/bills.ts'
import {
    dubaiDate,
    dubaiDayStart,
    dubaiMonthStart,
    dubaiWeekStart,
    formatReceipt,
    formatRemoved,
    formatSummary,
} from '../utils/functions.ts'
import { logger } from '../utils/logger.js'

// The one chat this bot acts on.
//   set   → that chat's JID (production: the business group's @g.us).
//   unset → self-chat mode: watch the linked account's own self-chat, detected
//           from sock.user — no JID to configure. This is the testing path.
// Everything from any other chat is dropped (its JID is surfaced once, see
// noteForeignChat, so a group JID is easy to grab for production).
const TARGET = process.env.TARGET_CHAT_JID ? jidNormalizedUser(process.env.TARGET_CHAT_JID) : undefined

// Base64-encoding an unbounded image is how one large photo becomes a multi-MB
// request body and a silent 30s timeout.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

type Sock = ReturnType<typeof makeWASocket>

// Ids of messages this process sent. `messages.upsert` fires for our own outgoing
// messages too (fromMe), and when the bot is linked to a personal number for
// testing they're indistinguishable from the human typing — except by id. Skip
// only what we actually sent, not everything `fromMe`.
// ponytail: unbounded within a run; a few hundred short ids/day, trimmed at 1000.
const sentByBot = new Set<string>()
function rememberSent(id: string | null | undefined) {
    if (!id) return
    sentByBot.add(id)
    if (sentByBot.size > 1000) for (const old of [...sentByBot].slice(0, 500)) sentByBot.delete(old)
}

// Surface the JID of any chat the bot sees but isn't watching — once each, at
// info. This is how you get the group JID for production: add the bot to the
// group, have someone post, copy the JID, set TARGET_CHAT_JID, restart.
const seenForeignChats = new Set<string>()
function noteForeignChat(jid: string, m: WAMessage) {
    if (!jid || seenForeignChats.has(jid)) return
    seenForeignChats.add(jid)
    logger.info(
        { jid, kind: m.message?.imageMessage ? 'image' : 'text' },
        'saw a message in a chat this bot is not watching — set TARGET_CHAT_JID to this jid to watch it',
    )
}

async function send(sock: Sock, jid: string, text: string, log: Logger) {
    // .catch, not a bare await: if the socket is already dead this would escape
    // as an unhandled rejection and take the process down over one message.
    const sent = await sock.sendMessage(jid, { text }).catch((err) => {
        log.error({ err }, 'send failed')
        return undefined
    })
    rememberSent(sent?.key?.id)
    return sent
}

function timestampMs(m: WAMessage): number {
    const ts = m.messageTimestamp
    if (typeof ts === 'number') return ts * 1000
    if (ts && typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
        return (ts as { toNumber: () => number }).toNumber() * 1000
    }
    return Date.now()
}

async function handleImage(sock: Sock, m: WAMessage, log: Logger) {
    const jid = m.key.remoteJid!
    const img = m.message!.imageMessage!

    if (Number(img.fileLength ?? 0) > MAX_IMAGE_BYTES) {
        log.warn({ declared: Number(img.fileLength) }, 'image too large, skipping')
        return
    }

    let buffer: Buffer
    try {
        buffer = (await downloadMediaMessage(
            m,
            'buffer',
            {},
            // reuploadRequest: WhatsApp media URLs expire — without it an older
            // image throws instead of being re-requested from the sender's device.
            { logger, reuploadRequest: sock.updateMediaMessage },
        )) as Buffer
    } catch (err) {
        log.error({ err }, 'media download failed') // expired/undecryptable — not worth pinging the group
        return
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
        log.warn({ bytes: buffer.length }, 'image over cap after download, skipping')
        return
    }

    let bill
    try {
        const startedAt = Date.now()
        bill = await extractBill(buffer, img.mimetype || 'image/jpeg')
        log.info(
            { ms: Date.now() - startedAt, isReceipt: bill.is_receipt, total: bill.total, confidence: bill.confidence },
            'extraction done',
        )
    } catch (err) {
        log.error({ err }, 'extraction failed')
        await send(sock, jid, "Couldn't read that receipt — try a clearer photo.", log)
        return
    }

    // The whole point of the is_receipt gate: stay silent on the group's
    // non-receipt photos (job sites, screenshots, chat images).
    if (!bill.is_receipt || bill.total == null) {
        log.info('skipped: not a receipt')
        return
    }

    const category = bill.category ?? 'Others'
    const billDate = bill.bill_date ?? dubaiDate(timestampMs(m))

    let row
    try {
        // insert before replying — a confirmation must mean the row landed
        row = await insertBill({
            whatsapp_message_id: m.key.id!,
            total: bill.total,
            merchant: bill.merchant,
            bill_date: billDate,
            category,
            confidence: bill.confidence,
        })
    } catch (err) {
        log.error({ err }, 'insert failed')
        await send(sock, jid, "Couldn't save that bill — check the logs.", log)
        return
    }
    if (!row) {
        log.info('skipped: already logged') // duplicate delivery; don't confirm twice
        return
    }
    log.info({ rowId: row.id }, 'bill inserted')

    const today = await periodTotal(dubaiDayStart()).catch((err) => {
        // the row already landed — a failed totals read must not read as a failed log
        log.error({ err }, "today's total read failed")
        return null
    })
    const text = formatReceipt({ merchant: bill.merchant, total: bill.total, category }, today)

    const sent = await send(sock, jid, text, log)
    if (sent?.key?.id) {
        // the confirmation's id is the second /undo anchor (reply to it, not just the photo)
        await setReplyMessageId(row.id, sent.key.id).catch((err) => log.error({ err }, 'setReplyMessageId failed'))
    }
    log.info('confirmation sent')
}

async function handleCommand(sock: Sock, m: WAMessage, cmd: Command, log: Logger) {
    const jid = m.key.remoteJid!

    if (cmd === 'undo') {
        // /undo must be a reply — the quoted message tells us which bill to remove.
        const stanzaId = m.message?.extendedTextMessage?.contextInfo?.stanzaId
        if (!stanzaId) {
            await send(sock, jid, 'Reply /undo to a receipt or to my confirmation for the bill you want to remove.', log)
            return
        }
        const removed = await undoByQuotedId(stanzaId)
        if (!removed) {
            await send(sock, jid, 'Nothing logged for that message.', log)
            return
        }
        log.info({ rowId: removed.id }, 'bill undone')
        await send(
            sock,
            jid,
            formatRemoved({ merchant: removed.merchant, total: Number(removed.total), category: removed.category }),
            log,
        )
        return
    }

    const spec =
        cmd === 'today'
            ? { since: dubaiDayStart(), header: "TODAY'S EXPENSES" }
            : cmd === 'week'
              ? { since: dubaiWeekStart(), header: "THIS WEEK'S EXPENSES" }
              : { since: dubaiMonthStart(), header: "THIS MONTH'S EXPENSES" }
    const totals = await periodTotal(spec.since)
    await send(sock, jid, formatSummary(spec.header, totals), log)
}

async function connectToWhatsApp(retry = 0, refetchVersion = true, isFirstConnect = true) {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session')

    // Baileys pins a WA web version at publish time. Once WA retires that revision
    // it answers 405 at the registration handshake and no QR is ever emitted —
    // this reads the live revision. fetchLatestWaWebVersion never throws (it falls
    // back internally) but has no built-in timeout, so cap it. Only refetch on a
    // fresh start or right after a 405.
    let version: WAVersion | undefined
    if (refetchVersion) {
        const result = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5_000) })
        if (result.isLatest) {
            version = result.version
        } else {
            logger.warn({ err: result.error }, 'failed to fetch live WA web version, using the version pinned in Baileys')
        }
    }

    const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger,
        // No message store kept, so resend requests can't be fulfilled — fine, this bot sends no polls.
        // ponytail: always undefined — add an in-memory cache of sent messages if resend requests show up in logs.
        getMessage: async () => undefined,
        // Deliberately NOT overriding shouldSyncHistoryMessage: disabling all sync types blocks the
        // history-sync path that populates LID mappings (Baileys warns loudly, and a 2026-07-31 incident
        // in the sibling repo confirmed it). The library default already excludes the expensive FULL sync.
        // markOnlineOnConnect false: the default (true) suppresses phone push notifications.
        markOnlineOnConnect: false,
    })

    // 'close' can fire more than once on a dead socket; without this each one
    // starts its own reconnect chain and the loop doubles every round.
    let closed = false
    let openedAt = 0

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) qrcode.generate(qr, { small: true })

        if (connection === 'close') {
            if (closed) return
            closed = true

            // Detach immediately, not after the backoff wait — a dead socket
            // otherwise keeps its handlers live for up to 60s.
            sock.ev.removeAllListeners('connection.update')
            sock.ev.removeAllListeners('messages.upsert')
            sock.ev.removeAllListeners('creds.update')
            sock.end(undefined)

            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            const plan = reconnectPlan({
                statusCode,
                retry,
                paired: Boolean(state.creds.me),
                sessionMs: openedAt ? Date.now() - openedAt : 0,
            })
            logger.warn(
                { err: lastDisconnect?.error, reconnecting: plan.reconnect, retryInMs: plan.wait },
                'WhatsApp connection closed',
            )

            if (!plan.reconnect) {
                if (plan.reason === 'replaced') {
                    // Another session took over this linked device. Reconnecting immediately
                    // just replaces them back, and they replace us again — put real distance
                    // between attempts, then try once.
                    fatal(lastDisconnect?.error, 'connection replaced by another session (440)', { retryable: true, delayMs: 300_000 })
                } else {
                    fatal(
                        lastDisconnect?.error,
                        `credentials rejected (${plan.reason}) — wipe auth_session and scan a new QR`,
                        { retryable: false },
                    )
                }
                return
            }

            setTimeout(() => {
                connectToWhatsApp(plan.retry, statusCode === 405, false).catch((e) =>
                    fatal(e, 'reconnect chain died', { retryable: true, delayMs: 30_000 }),
                )
            }, plan.wait)
        } else if (connection === 'open') {
            openedAt = Date.now() // backoff resets only if this session lasts, see reconnect.ts
            logger.info(
                { mode: TARGET ? `chat ${TARGET}` : 'self-chat (TARGET_CHAT_JID unset)' },
                'WhatsApp connection opened',
            )
            if (isFirstConnect) {
                // Ping the bot's own self-chat (not the group) so the operator scanning the QR
                // sees "it worked" — automatic reconnects are routine and don't need a message.
                sock.sendMessage(jidNormalizedUser(sock.user!.id), { text: 'Bills bot connected ✅' })
                    .then((sent) => rememberSent(sent?.key?.id))
                    .catch((error) => logger.error({ err: error }, 'failed to send connection confirmation'))
            }
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return // ignore history replayed on (re)connect / on join

        // v7 routes self-chat by LID, not the phone-number JID; which form a
        // message arrives in depends on which side of the migration this session
        // is on. Check all three "me" forms against both JID fields — same as the
        // calorie tracker (whatsapp-calorie-tracker/backend/src/whatsapp/socket.ts).
        const meJids = [sock.user!.id, sock.user!.lid, sock.user!.phoneNumber]
            .filter(Boolean)
            .map((j) => jidNormalizedUser(j!))

        for (const m of messages) {
            const log = logger.child({ msgId: m.key.id })

            const jid = m.key.remoteJid ? jidNormalizedUser(m.key.remoteJid) : ''
            const alt = m.key.remoteJidAlt ? jidNormalizedUser(m.key.remoteJidAlt) : undefined

            const matches = TARGET
                ? jid === TARGET || alt === TARGET // production: the watched chat
                : meJids.includes(jid) || (alt !== undefined && meJids.includes(alt)) // testing: self-chat

            if (!matches) {
                noteForeignChat(jid, m)
                log.debug({ from: m.key.remoteJid }, TARGET ? 'skipped: wrong chat' : 'skipped: not self-chat')
                continue
            }
            if (m.key.id && sentByBot.has(m.key.id)) {
                log.debug('skipped: the bot sent this') // our own confirmation echoing back
                continue
            }

            try {
                if (m.message?.imageMessage) {
                    await handleImage(sock, m, log)
                    continue
                }
                const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? ''
                const cmd = parseCommand(text)
                if (cmd) {
                    await handleCommand(sock, m, cmd, log)
                    continue
                }
                log.debug('skipped: not an image or a command')
            } catch (err) {
                log.error({ err }, 'message handler crashed')
                await send(sock, m.key.remoteJid!, 'Something went wrong — check the logs.', log)
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

connectToWhatsApp().catch((e) => fatal(e, 'initial connect failed', { retryable: true, delayMs: 30_000 }))
