import { logger } from "./utils/logger.js";

// Entry point. Registers process-level safety nets before the socket connects,
// so a crash always leaves a log line explaining why — otherwise this is
// invisible until the process is silently dead on the server.
process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception, exiting for a clean restart");
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled rejection, exiting for a clean restart");
    process.exit(1);
});

// Dynamic import so the handlers above are registered first — a plain top-level
// `import` would be hoisted ahead of them.
await import("./whatsapp/socket.ts");
