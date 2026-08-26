import { logger } from '../utils/logger.js'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * The one place that decides whether Docker should bring this container back.
 * `retryable: false` -> exit(0), which `on-failure:10` treats as "stop, this
 * needs a human" (a clean exit code never restarts). `retryable: true` ->
 * exit(1), and `delayMs` puts real distance between attempts before Docker's
 * own ~1-minute-capped backoff kicks in.
 */
export async function fatal(err: unknown, msg: string, opts: { retryable: boolean; delayMs?: number }): Promise<never> {
    logger.fatal({ err }, msg)
    if (opts.delayMs) await sleep(opts.delayMs)
    process.exit(opts.retryable ? 1 : 0)
}
