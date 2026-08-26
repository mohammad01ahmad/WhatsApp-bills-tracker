import pino from "pino";

// Shared by our own logs and by Baileys itself (passed to makeWASocket as
// `logger`), so both come out through one consistent, level-controlled stream
// instead of two disconnected logging paths. Level is env-driven so verbosity
// can change on the server without a redeploy.
export const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    serializers: { err: pino.stdSerializers.err },
});
